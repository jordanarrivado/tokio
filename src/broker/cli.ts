#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { refinePrompt } from '../core/refine';
import { estimateTokens } from '../core/tokens';
import type { AgentCommand } from './bench';
import { checkBenchTasks, disposeActiveWorkspaces, formatBenchSummary, formatLiveSummary, parseBenchTasks, runBench } from './bench';
import { buildRepoMap, type RepoFile } from '../context/repomap';
import { recordToolActivity } from './activity';
import { appendAuditEntry } from './audit';
import { evaluateToolUse, parseToolUse } from './hook';
import { compactCommandOutput, formatCompactFooter, saveOutput } from './compact';
import { loadCatalog } from './catalog';
import { clearScope, DEFAULT_GRANT_HOURS, evaluateWriteScope, formatScope, grantScope, readGrants } from './scope';
import { scanRepository } from './scan';
import { serveStdio } from './mcp';
import { formatStats, readAuditEntries, summarizeAudit } from './stats';
import { decideMapContext, decidePromptContext, formatMapContext, parsePromptHookEvent } from './prompt-hook';
import { loadArchitectureMap, readSessionAreas, recordSessionAreas, resolveAgainstRepo, type LoadedMap } from './mapfile';
import { initProject } from './init';
import { formatMapCheck, MAP_PROMPTS_PATH, parseMapPrompts, runMapPrompts } from './mapcheck';
import { resolveRepoPath } from './policy';
import { addressedPromptContext, evaluateMessaging } from './messaging';
import { runDoctor } from './doctor';
import { Broker } from './tools';

const AGENTS: Record<string, AgentCommand> = {
  claude: { command: 'claude', args: ['-p', '--output-format', 'json'] }
};

const DEFAULT_BUDGET_TOKENS = 1500;

const USAGE = [
  'Usage:',
  '  tokio mcp [--root <dir>]                       serve broker tools over stdio (MCP)',
  '  tokio hook                                     PreToolUse hook: reads event JSON on stdin',
  '  tokio map <task> [--root <dir>] [--target <path>] [--budget <tokens>]',
  '  tokio map check [--root <dir>] [--prompts <file>] [--verbose]   check map entries and the areas sample prompts match',
  '  tokio stats [--root <dir>] [--since <YYYY-MM-DD>]   estimated usage from the audit log',
  '  tokio bench <tasks.json> [--mode prompt|live] [--agent claude] [--repeat <n>] [--out <report.json>] [--working-tree]',
  '              [--share <folder>]... [--copy <file>]... [--check]',
  '  tokio output-hook                              PostToolUse hook: compacts long test, build, and install output',
  '  tokio prompt-hook                              UserPromptSubmit hook: adds map routes or a repo map for matching prompts',
  '  tokio init [--root <dir>] [--force] [--dry-run]  set up Claude Code and Codex configs for a project',
  '  tokio doctor [--root <dir>]                    check a project\'s Tokio setup (read-only)',
  '  tokio scope [<repo>...] [--hours <n>] [--clear] [--root <dir>]  show or grant write on catalog repositories'
].join('\n');

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === 'bench') {
    await runBenchCommand(rest);
    return;
  }
  if (command === 'map') {
    await runMapCommand(rest);
    return;
  }
  if (command === 'mcp') {
    serveStdio(new Broker(parseRootArg(rest)));
    return;
  }
  if (command === 'hook') {
    await runHookCommand();
    return;
  }
  if (command === 'output-hook') {
    await runOutputHookCommand();
    return;
  }
  if (command === 'prompt-hook') {
    await runPromptHookCommand();
    return;
  }
  if (command === 'init') {
    await runInitCommand(rest);
    return;
  }
  if (command === 'stats') {
    await runStatsCommand(rest);
    return;
  }
  if (command === 'doctor') {
    await runDoctorCommand(rest);
    return;
  }
  if (command === 'scope') {
    await runScopeCommand(rest);
    return;
  }

  process.stderr.write(`${USAGE}\n`);
  process.exitCode = command ? 1 : 0;
}

async function runBenchCommand(args: string[]): Promise<void> {
  const options = parseBenchArgs(args);
  const tasks = parseBenchTasks(await readFile(options.file, 'utf8'));
  const agent = AGENTS[options.agentName];
  if (!agent) {
    throw new Error(`Unknown agent "${options.agentName}". Supported: ${Object.keys(AGENTS).join(', ')}.`);
  }

  // Ctrl+C removes the open workspace's links before its folder, so a stopped bench never deletes shared folders.
  process.once('SIGINT', () => {
    process.stderr.write('Stopping: cleaning up the open workspace...\n');
    void disposeActiveWorkspaces().finally(() => process.exit(130));
  });
  // node_modules is always shared; --share adds folders such as vendor.
  const shared = ['node_modules', ...options.shared];
  // Progress goes to stderr, so stdout keeps only the results.
  const onProgress = (line: string): void => {
    process.stderr.write(`${new Date().toLocaleTimeString()} ${line}\n`);
  };
  if (options.check) {
    const results = await checkBenchTasks({ tasks, root: process.cwd(), shared, copyFiles: options.copyFiles, onProgress });
    for (const result of results) {
      process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.taskId}: ${result.detail}\n`);
    }
    process.exitCode = results.every((result) => result.ok) ? 0 : 1;
    return;
  }

  const report = await runBench({
    tasks,
    agent,
    root: process.cwd(),
    workspaceSource: options.workspaceSource,
    // Live runs vary from run to run, so they default to three repeats to report a median.
    repeats: options.repeats ?? (options.mode === 'live' ? 3 : 1),
    mode: options.mode,
    shared,
    copyFiles: options.copyFiles,
    onProgress,
    // Tokio arm: refined prompt plus the repo map, so the comparison covers scope and context.
    // This is a proxy for the MCP flow, where the agent pulls the same context on demand.
    buildTokioPrompt: async (task, workspace) => {
      const refined = refinePrompt({ rawPrompt: task, target: 'claude' }).refinedPrompt;
      const scan = await scanRepository(workspace);
      const map = buildRepoMap(scan.files, { task, budgetTokens: DEFAULT_BUDGET_TOKENS, coChange: scan.coChange });
      return `${refined}\n\n${map.text}`;
    }
  });

  if (options.outPath) {
    await writeFile(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${formatBenchSummary(report.summary)}\n`);
  if (report.tasks) {
    process.stdout.write(`${formatLiveSummary(report.tasks)}\n`);
  }
}

async function runMapCommand(args: string[]): Promise<void> {
  if (args[0] === 'check') {
    await runMapCheckCommand(args.slice(1));
    return;
  }
  let task: string | undefined;
  let root = process.cwd();
  let targetPath: string | undefined;
  let budgetTokens = DEFAULT_BUDGET_TOKENS;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--root') {
      root = requireValue(args, ++index, value);
    } else if (value === '--target') {
      targetPath = requireValue(args, ++index, value);
    } else if (value === '--budget') {
      budgetTokens = Number(requireValue(args, ++index, value));
      if (!Number.isInteger(budgetTokens) || budgetTokens < 1) {
        throw new Error('--budget must be a positive integer.');
      }
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option ${value}.`);
    } else {
      task = value;
    }
  }

  if (!task) {
    throw new Error(`Missing task text.\n${USAGE}`);
  }

  const scan = await scanRepository(root);
  const map = buildRepoMap(scan.files, { task, targetPath, budgetTokens, coChange: scan.coChange });
  const notes = [
    scan.truncated ? `Scan stopped at ${scan.files.length} files.` : undefined,
    map.omittedFiles > 0 ? `${map.omittedFiles} ranked files omitted by the budget.` : undefined
  ].filter((note): note is string => note !== undefined);

  process.stdout.write(`${map.text}\n`);
  process.stdout.write(`\n[${map.tokens} tokens, ${map.files.length} files${notes.length ? `; ${notes.join(' ')}` : ''}]\n`);
}

/**
 * Checks the architecture map: every entry must resolve, and each sample prompt must match exactly its expected
 * areas. Exits 1 on any stale entry or failing prompt, so it can run in CI after a map edit.
 */
async function runMapCheckCommand(args: string[]): Promise<void> {
  let root = process.cwd();
  let promptsPath: string | undefined;
  let verbose = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--verbose') {
      verbose = true;
    } else if (value === '--root') {
      root = requireValue(args, ++index, value);
    } else if (value === '--prompts') {
      promptsPath = requireValue(args, ++index, value);
    } else {
      throw new Error(`Unknown option ${value}.
${USAGE}`);
    }
  }

  const map = await loadArchitectureMap(root);
  if (!map) {
    throw new Error('No .tokio/map.md in this repository. Create one from the Tokio panel or by hand.');
  }
  const all = map.areas.map((area) => ({ area, score: 0 }));
  const routing = await resolveAgainstRepo(all, [], { root }, '');

  let promptsText: string | undefined;
  try {
    promptsText = await readFile((await resolveRepoPath(root, promptsPath ?? MAP_PROMPTS_PATH)).absolute, 'utf8');
  } catch (error) {
    // The default prompts file is optional; one named with --prompts must exist.
    if (promptsPath !== undefined) {
      throw error;
    }
  }
  const cases = promptsText === undefined ? undefined : parseMapPrompts(promptsText, map.areas);
  const results = cases && runMapPrompts(map.areas, cases);
  const report = formatMapCheck({
    path: map.path,
    areas: map.areas.length,
    routes: map.areas.reduce((sum, area) => sum + area.routes.length, 0),
    stale: routing.stale,
    areaNames: map.areas.map((area) => area.name)
  }, results, { verbose, cases });
  process.stdout.write(`${report.text}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

async function runStatsCommand(args: string[]): Promise<void> {
  const root = parseRootArg(args);
  const sinceIndex = args.indexOf('--since');
  const since = sinceIndex >= 0 ? new Date(requireValue(args, sinceIndex + 1, '--since')) : undefined;
  if (since !== undefined && Number.isNaN(since.getTime())) {
    throw new Error('--since must be a date such as 2026-10-15.');
  }

  const entries = (await readAuditEntries(root))
    .filter((entry) => since === undefined || new Date(entry.timestamp) >= since);
  const scope = since ? `since ${since.toISOString().slice(0, 10)}` : 'all recorded calls';
  process.stdout.write(`${formatStats(summarizeAudit(entries), scope)}\n`);
}

/** Writes the Claude Code and Codex configs for a project. Exits 1 when anything conflicts or fails. */
async function runDoctorCommand(args: string[]): Promise<void> {
  const checks = await runDoctor(parseRootArg(args));
  for (const check of checks) {
    process.stdout.write(`${check.level.toUpperCase().padEnd(5)} ${check.name.padEnd(22)} ${check.detail}\n`);
  }
  if (checks.some((check) => check.level === 'fail')) {
    process.exitCode = 1;
  }
}

async function runInitCommand(args: string[]): Promise<void> {
  const results = await initProject({
    root: parseRootArg(args),
    cliPath: __filename,
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run')
  });
  for (const result of results) {
    process.stdout.write(`${result.status.padEnd(10)} ${result.path}  ${result.detail}\n`);
  }
  if (results.some((result) => result.status === 'conflict' || result.status === 'error')) {
    process.exitCode = 1;
  }
}

/**
 * Shows or changes write scope. With names, grants write on those repositories; with --clear, removes
 * every grant; alone, prints the current scope. Meant for the user's own terminal: the hook refuses it
 * from the agent.
 */
async function runScopeCommand(args: string[]): Promise<void> {
  const root = parseRootArg(args);
  const hoursIndex = args.indexOf('--hours');
  const hours = hoursIndex >= 0 ? Number(requireValue(args, hoursIndex + 1, '--hours')) : DEFAULT_GRANT_HOURS;
  const valueIndexes = new Set([args.indexOf('--root') + 1, hoursIndex + 1].filter((index) => index > 0));
  const names = args.filter((arg, index) => !arg.startsWith('--') && !valueIndexes.has(index));

  try {
    const catalog = await loadCatalog(root);
    if (args.includes('--clear')) {
      await clearScope(root);
    } else if (names.length > 0) {
      await grantScope(root, names, hours);
      if (names.includes(catalog.defaultRepo)) {
        process.stdout.write(`${catalog.defaultRepo} is the default write target; it needs no grant.\n`);
      }
    }
    process.stdout.write(`${formatScope(catalog, await readGrants(root))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * UserPromptSubmit hook. Plain stdout on exit 0 is added to the prompt as context. Every failure
 * exits 0 with no output, so a broken map can never block the user's prompt.
 */
async function runPromptHookCommand(): Promise<void> {
  try {
    const event = parsePromptHookEvent(await readStdin());
    if (!event) {
      return;
    }
    const root = event.cwd ?? process.cwd();
    // A prompt that starts with ~name: is for another repository's agent, so it gets relay instructions, not a map.
    const addressed = await addressedPromptContext(root, event.prompt);
    if (addressed) {
      process.stdout.write(`${addressed.text}\n`);
      await appendAuditEntry(root, {
        tool: 'prompt-route',
        inputTokens: 0,
        outputTokens: estimateTokens(addressed.text),
        files: [],
        redactions: [],
        blocked: false,
        ...(addressed.repo ? { repos: [addressed.repo] } : {})
      });
      return;
    }
    const scan = await scanRepository(root);
    // A repository with a map gets map context or nothing: the keyword-ranked repository map only adds noise there.
    if (await injectMapContext(root, event.prompt, event.sessionId, scan.files) !== 'no-map') {
      return;
    }
    const decision = decidePromptContext(event.prompt, scan.files, scan.coChange);
    if (!decision.inject) {
      return;
    }

    process.stdout.write(`${decision.text}\n`);
    await appendAuditEntry(root, {
      tool: 'prompt-hook',
      inputTokens: 0,
      outputTokens: decision.tokens,
      files: decision.files,
      redactions: decision.redactions,
      blocked: false
    });
  } catch {
    // Fail open: a missing or unreadable repository must not block the prompt.
  }
}

/**
 * Sends the architecture map's matching areas instead of a repository map. Each area's lines go out once per
 * session; later matches only name it. True when the map matched, so the caller adds nothing else.
 */
async function injectMapContext(
  root: string,
  prompt: string,
  sessionId: string | undefined,
  files: readonly RepoFile[]
): Promise<'sent' | 'no-match' | 'no-map'> {
  let map: LoadedMap | undefined;
  try {
    map = await loadArchitectureMap(root);
  } catch {
    // An unreadable map falls back to the repository map.
    return 'no-map';
  }
  if (!map || map.areas.length === 0) {
    return 'no-map';
  }
  const sent = sessionId ? await readSessionAreas(root, sessionId) : new Set<string>();
  const decision = decideMapContext(prompt, map.areas, sent);
  if (!decision.use) {
    return 'no-match';
  }
  const routing = decision.fresh.length > 0
    ? await resolveAgainstRepo(decision.fresh, files, { root }, prompt)
    : undefined;
  const { text, redactions } = formatMapContext(routing, decision.repeated);
  process.stdout.write(`${text}\n`);
  if (sessionId && routing) {
    await recordSessionAreas(root, sessionId, routing.areas);
  }
  await appendAuditEntry(root, {
    tool: 'prompt-map',
    inputTokens: 0,
    outputTokens: estimateTokens(text),
    files: [...new Set(routing?.anchors.map((anchor) => anchor.path) ?? [])],
    redactions,
    blocked: false
  });
  return 'sent';
}

/** Claude Code sends the tool event on stdin. Exit code 2 blocks the call and shows stderr to the agent. */
async function runHookCommand(): Promise<void> {
  const raw = await readStdin();
  let verdict = evaluateToolUse(raw);
  if (!verdict.blocked) {
    // Secret rules passed; now the write scope across catalog repositories.
    const event = parseToolUse(raw);
    const scoped = event && (await evaluateWriteScope(event.tool, event.toolInput, event.cwd ?? process.cwd())
      ?? await evaluateMessaging(event.tool, event.toolInput, event.cwd ?? process.cwd()));
    if (!scoped) {
      // Allowed: tell the repository map which repository the agent is in.
      if (event) {
        await recordToolActivity(event.cwd ?? process.cwd(), event.tool, event.toolInput);
      }
      return;
    }
    verdict = scoped;
  }

  try {
    await appendAuditEntry(verdict.cwd ?? process.cwd(), {
      tool: verdict.tool,
      inputTokens: 0,
      outputTokens: 0,
      files: verdict.path ? [verdict.path] : [],
      redactions: [],
      blocked: true,
      ...(verdict.repo ? { repos: [verdict.repo] } : {})
    });
  } catch {
    // Blocking does not depend on the audit log being writable.
  }
  process.stderr.write(`Tokio blocked ${verdict.tool}: ${verdict.reason}\n`);
  process.exitCode = 2;
}

/**
 * PostToolUse hook for Bash and PowerShell. Replaces long test, build, and install output with the lines
 * that matter and saves the full output for search_output. Every failure leaves the original output in place.
 */
async function runOutputHookCommand(): Promise<void> {
  try {
    const raw = await readStdin();
    const event = parseToolUse(raw);
    const response = parseToolResponse(raw);
    const command = event?.toolInput.command;
    if (!event || !response || typeof command !== 'string') {
      return;
    }
    const compacted = compactCommandOutput(command, response.stdout, response.stderr);
    if (!compacted) {
      return;
    }
    const id = await saveOutput(compacted.full);
    const stdout = `${compacted.stdout}\n${formatCompactFooter(compacted, id)}`;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { ...response.raw, stdout, stderr: compacted.stderr }
      }
    }));
    const returned = estimateTokens(stdout) + estimateTokens(compacted.stderr);
    await appendAuditEntry(event.cwd ?? process.cwd(), {
      tool: 'output-hook',
      inputTokens: 0,
      outputTokens: returned,
      files: [],
      redactions: compacted.redactions,
      blocked: false,
      baselineTokens: compacted.baselineTokens,
      savedTokens: compacted.baselineTokens - returned
    }).catch(() => undefined);
  } catch {
    // Compaction is an optimization; the agent keeps the original output.
  }
}

/** The Bash tool_response of a PostToolUse event, or undefined when it has no string stdout. */
function parseToolResponse(raw: string): { stdout: string; stderr: string; raw: Record<string, unknown> } | undefined {
  try {
    const input: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    const response = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).tool_response : undefined;
    if (typeof response !== 'object' || response === null || Array.isArray(response)) {
      return undefined;
    }
    const record = response as Record<string, unknown>;
    if (typeof record.stdout !== 'string') {
      return undefined;
    }
    return { stdout: record.stdout, stderr: typeof record.stderr === 'string' ? record.stderr : '', raw: record };
  } catch {
    return undefined;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function parseRootArg(args: string[]): string {
  const index = args.indexOf('--root');
  return index >= 0 ? requireValue(args, index + 1, '--root') : process.cwd();
}

function parseBenchArgs(args: string[]): {
  file: string;
  agentName: string;
  repeats?: number;
  outPath?: string;
  workspaceSource: 'head' | 'working-tree';
  mode: 'prompt' | 'live';
  shared: string[];
  copyFiles: string[];
  check: boolean;
} {
  let file: string | undefined;
  let agentName = 'claude';
  let repeats: number | undefined;
  let mode: 'prompt' | 'live' = 'prompt';
  const shared: string[] = [];
  const copyFiles: string[] = [];
  let check = false;
  let outPath: string | undefined;
  let workspaceSource: 'head' | 'working-tree' = 'head';

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--mode') {
      const chosen = requireValue(args, ++index, value);
      if (chosen !== 'prompt' && chosen !== 'live') {
        throw new Error('--mode must be prompt or live.');
      }
      mode = chosen;
    } else if (value === '--share') {
      shared.push(requireValue(args, ++index, value));
    } else if (value === '--copy') {
      copyFiles.push(requireValue(args, ++index, value));
    } else if (value === '--check') {
      check = true;
    } else if (value === '--agent') {
      agentName = requireValue(args, ++index, value);
    } else if (value === '--working-tree') {
      workspaceSource = 'working-tree';
    } else if (value === '--repeat') {
      repeats = Number(requireValue(args, ++index, value));
      if (!Number.isInteger(repeats) || repeats < 1) {
        throw new Error('--repeat must be a positive integer.');
      }
    } else if (value === '--out') {
      outPath = requireValue(args, ++index, value);
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option ${value}.`);
    } else {
      file = value;
    }
  }

  if (!file) {
    throw new Error(`Missing tasks file.\n${USAGE}`);
  }
  return { file, agentName, repeats, outPath, workspaceSource, mode, shared, copyFiles, check };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

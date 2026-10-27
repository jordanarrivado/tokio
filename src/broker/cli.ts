#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { refinePrompt } from '../core/refine';
import { estimateTokens } from '../core/tokens';
import type { AgentCommand } from './bench';
import { formatBenchSummary, parseBenchTasks, runBench } from './bench';
import { buildRepoMap } from '../context/repomap';
import { recordToolActivity } from './activity';
import { appendAuditEntry } from './audit';
import { evaluateToolUse, parseToolUse } from './hook';
import { loadCatalog } from './catalog';
import { clearScope, DEFAULT_GRANT_HOURS, evaluateWriteScope, formatScope, grantScope, readGrants } from './scope';
import { scanRepository } from './scan';
import { serveStdio } from './mcp';
import { formatStats, readAuditEntries, summarizeAudit } from './stats';
import { decidePromptContext, parsePromptHookEvent } from './prompt-hook';
import { initProject } from './init';
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
  '  tokio stats [--root <dir>] [--since <YYYY-MM-DD>]   estimated usage from the audit log',
  '  tokio bench <tasks.json> [--agent claude] [--repeat <n>] [--out <report.json>] [--working-tree]',
  '  tokio prompt-hook                              UserPromptSubmit hook: adds a repo map for matching prompts',
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

  const report = await runBench({
    tasks,
    agent,
    root: process.cwd(),
    workspaceSource: options.workspaceSource,
    repeats: options.repeats,
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
}

async function runMapCommand(args: string[]): Promise<void> {
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
  repeats: number;
  outPath?: string;
  workspaceSource: 'head' | 'working-tree';
} {
  let file: string | undefined;
  let agentName = 'claude';
  let repeats = 1;
  let outPath: string | undefined;
  let workspaceSource: 'head' | 'working-tree' = 'head';

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--agent') {
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
  return { file, agentName, repeats, outPath, workspaceSource };
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

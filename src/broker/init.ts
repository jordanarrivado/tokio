import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SECRET_DENY_PATTERNS } from '../context/discovery';

/**
 * Sets up one project for Claude Code and Codex. Each file is planned first, then written only when
 * something changed. Entries that Tokio does not own are never edited. A differing Tokio entry is
 * reported as a conflict unless `force` is set.
 */

export type InitStatus = 'created' | 'updated' | 'unchanged' | 'conflict' | 'error';

export interface InitResult {
  path: string;
  status: InitStatus;
  detail: string;
}

export interface InitOptions {
  root: string;
  /** Absolute path to the compiled broker CLI (out/broker/cli.js). Written into every agent config. */
  cliPath: string;
  force?: boolean;
  dryRun?: boolean;
}

export const AGENTS_BEGIN = '<!-- tokio:begin -->';
export const AGENTS_END = '<!-- tokio:end -->';
export const PRE_TOOL_MATCHER = 'Read|Edit|Write|MultiEdit|Grep|Glob|Bash';
const SERVER_NAME = 'tokio';
const CODEX_TABLE = '[mcp_servers.tokio]';

export const TOKIO_GUIDANCE = [
  '## Tokio tools',
  '',
  'For each coding task:',
  '1. Call `refine_task` once with the task text. Use its output as the scoped prompt.',
  '2. Call `repo_map` with the task to find relevant files and line numbers.',
  '3. Call `read_symbol` only for the bodies you need. A repeat read returns only changed lines unless `full` is true.',
  '4. If a result says it was truncated, call `search_output` with the output id.',
  '',
  'Never read files named .env, credentials, secrets, or keys.'
].join('\n');

interface Plan {
  status: InitStatus;
  detail: string;
  /** Full new file content. Present only when the file must be written. */
  content?: string;
}

export async function initProject(options: InitOptions): Promise<InitResult[]> {
  const root = toPosixPath(resolve(options.root));
  const cli = toPosixPath(resolve(options.cliPath));

  const targets: [string, (text: string | undefined) => Plan][] = [
    ['.mcp.json', (text) => planMcpConfig(text, cli, root, options.force === true)],
    ['.claude/settings.json', (text) => planClaudeSettings(text, cli, options.force === true)],
    ['.codex/config.toml', (text) => planCodexConfig(text, cli, root, options.force === true)],
    ['AGENTS.md', (text) => planAgentsGuidance(text)]
  ];

  const results: InitResult[] = [];
  for (const [relativePath, plan] of targets) {
    const file = join(root, relativePath);
    try {
      const text = await readIfExists(file);
      const planned = plan(text);
      if (planned.content !== undefined && options.dryRun !== true) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, planned.content, 'utf8');
      }
      results.push({ path: relativePath, status: planned.status, detail: planned.detail });
    } catch (error) {
      results.push({ path: relativePath, status: 'error', detail: errorMessage(error) });
    }
  }
  return results;
}

/** Shell and config values use forward slashes with an upper-case drive letter, matching the existing configs. */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^([a-z]):/, (_match, drive: string) => `${drive.toUpperCase()}:`);
}

function planMcpConfig(text: string | undefined, cli: string, root: string, force: boolean): Plan {
  const doc = parseObject(text, '.mcp.json');
  if (typeof doc === 'string') {
    return { status: 'error', detail: doc };
  }
  if (doc.mcpServers !== undefined && !isRecord(doc.mcpServers)) {
    return { status: 'error', detail: '"mcpServers" is not an object; left unchanged.' };
  }

  const servers = isRecord(doc.mcpServers) ? doc.mcpServers : {};
  const desired = { command: 'node', args: [cli, 'mcp', '--root', root] };
  const existing = servers[SERVER_NAME];
  if (existing !== undefined && sameJson(existing, desired)) {
    return { status: 'unchanged', detail: 'tokio server already registered.' };
  }
  if (existing !== undefined && !force) {
    return { status: 'conflict', detail: 'a tokio server with different settings exists; kept it. Use --force to replace.' };
  }

  const next = { ...doc, mcpServers: { ...servers, [SERVER_NAME]: desired } };
  return {
    status: text === undefined ? 'created' : 'updated',
    detail: existing === undefined ? 'registered the tokio server.' : 'replaced the tokio server.',
    content: formatJson(next)
  };
}

function planClaudeSettings(text: string | undefined, cli: string, force: boolean): Plan {
  const doc = parseObject(text, '.claude/settings.json');
  if (typeof doc === 'string') {
    return { status: 'error', detail: doc };
  }
  if (doc.hooks !== undefined && !isRecord(doc.hooks)) {
    return { status: 'error', detail: '"hooks" is not an object; left unchanged.' };
  }
  if (doc.permissions !== undefined && !isRecord(doc.permissions)) {
    return { status: 'error', detail: '"permissions" is not an object; left unchanged.' };
  }
  const permissions: Record<string, unknown> = isRecord(doc.permissions) ? doc.permissions : {};
  if (permissions.deny !== undefined && !Array.isArray(permissions.deny)) {
    return { status: 'error', detail: '"permissions.deny" is not an array; left unchanged.' };
  }

  const hooks: Record<string, unknown> = isRecord(doc.hooks) ? { ...doc.hooks } : {};
  const notes: string[] = [];
  const conflicts: string[] = [];
  let changed = false;

  // Secret deny rules are added when missing. Existing rules, including the user's own, are kept.
  const deny: unknown[] = Array.isArray(permissions.deny) ? permissions.deny : [];
  const missingRules = secretDenyRules().filter((rule) => !deny.includes(rule));
  if (missingRules.length > 0) {
    changed = true;
    notes.push(`added ${missingRules.length} secret-file deny rules.`);
  }

  const events: { event: string; subcommand: string; matcher?: string }[] = [
    { event: 'PreToolUse', subcommand: 'hook', matcher: PRE_TOOL_MATCHER },
    { event: 'UserPromptSubmit', subcommand: 'prompt-hook' }
  ];
  for (const { event, subcommand, matcher } of events) {
    const command = `node ${shellArg(cli)} ${subcommand}`;
    const groups = hooks[event] === undefined ? [] : hooks[event];
    if (!Array.isArray(groups)) {
      return { status: 'error', detail: `"hooks.${event}" is not an array; left unchanged.` };
    }

    const owned = findOwnedHook(groups, subcommand);
    if (owned) {
      if (owned.command === command) {
        continue;
      }
      if (!force) {
        conflicts.push(`${event} runs a different tokio command; kept it. Use --force to replace.`);
        continue;
      }
      owned.command = command;
      changed = true;
      notes.push(`replaced ${event} hook.`);
      continue;
    }

    const group: Record<string, unknown> = matcher === undefined ? {} : { matcher };
    group.hooks = [{ type: 'command', command }];
    hooks[event] = [...groups, group];
    changed = true;
    notes.push(`added ${event} hook.`);
  }

  const detail = [...notes, ...conflicts].join(' ') || 'tokio hooks and secret deny rules already configured.';
  if (!changed) {
    return { status: conflicts.length > 0 ? 'conflict' : 'unchanged', detail };
  }
  const next: Record<string, unknown> = { ...doc, hooks };
  if (missingRules.length > 0) {
    next.permissions = { ...permissions, deny: [...deny, ...missingRules] };
  }
  return {
    status: conflicts.length > 0 ? 'conflict' : text === undefined ? 'created' : 'updated',
    detail,
    content: formatJson(next)
  };
}

function secretDenyRules(): string[] {
  return SECRET_DENY_PATTERNS.map((pattern) => `Read(${pattern})`);
}

/** Finds a hook command that the Tokio CLI owns for this subcommand. Owned means it runs broker/cli.js. */
function findOwnedHook(groups: readonly unknown[], subcommand: string): Record<string, unknown> | undefined {
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      continue;
    }
    for (const hook of group.hooks) {
      if (isRecord(hook) && typeof hook.command === 'string' && isOwnedCommand(hook.command, subcommand)) {
        return hook;
      }
    }
  }
  return undefined;
}

function isOwnedCommand(command: string, subcommand: string): boolean {
  const tokens = command.replaceAll('\\', '/').trim().split(/\s+/);
  return tokens.at(-1) === subcommand && tokens.some((token) => token.endsWith('broker/cli.js'));
}

function planCodexConfig(text: string | undefined, cli: string, root: string, force: boolean): Plan {
  const block = [
    CODEX_TABLE,
    'command = "node"',
    `args = [${tomlString(cli)}, "mcp", "--root", ${tomlString(root)}]`,
    `cwd = ${tomlString(root)}`
  ];

  if (text === undefined || text.trim().length === 0) {
    return { status: text === undefined ? 'created' : 'updated', detail: 'added the tokio server.', content: `${block.join('\n')}\n` };
  }

  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CODEX_TABLE);
  if (start < 0) {
    const separator = text.endsWith('\n') ? '\n' : '\n\n';
    return { status: 'updated', detail: 'added the tokio server.', content: `${text}${separator}${block.join('\n')}\n` };
  }

  // A table runs until the next table header. Keys in any other table are not touched.
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) {
    end += 1;
  }
  const current = lines.slice(start, end).map((line) => line.trim()).filter((line) => line.length > 0);
  if (current.join('\n') === block.join('\n')) {
    return { status: 'unchanged', detail: 'tokio server already configured.' };
  }
  if (!force) {
    return { status: 'conflict', detail: `${CODEX_TABLE} exists with different settings; kept it. Use --force to replace.` };
  }

  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  return { status: 'updated', detail: 'replaced the tokio server.', content: next.join('\n') };
}

function planAgentsGuidance(text: string | undefined): Plan {
  const block = [AGENTS_BEGIN, TOKIO_GUIDANCE, AGENTS_END].join('\n');
  if (text === undefined) {
    return { status: 'created', detail: 'created with the Tokio guidance block.', content: `${block}\n` };
  }

  const begin = text.indexOf(AGENTS_BEGIN);
  const end = text.indexOf(AGENTS_END);
  if (begin >= 0 && end > begin) {
    const current = text.slice(begin, end + AGENTS_END.length);
    if (current === block) {
      return { status: 'unchanged', detail: 'Tokio guidance block is current.' };
    }
    return {
      status: 'updated',
      detail: 'refreshed the Tokio guidance block.',
      content: `${text.slice(0, begin)}${block}${text.slice(end + AGENTS_END.length)}`
    };
  }

  // Guidance written by hand has no markers. Adding a second copy would duplicate instructions, so leave it alone.
  if (text.includes('refine_task') && text.includes('repo_map')) {
    return {
      status: 'unchanged',
      detail: 'Tokio guidance already present without markers; left it. Wrap it in tokio:begin and tokio:end markers to let tokio init manage it.'
    };
  }

  const separator = text.endsWith('\n') ? '\n' : '\n\n';
  return { status: 'updated', detail: 'appended the Tokio guidance block.', content: `${text}${separator}${block}\n` };
}

function parseObject(text: string | undefined, name: string): Record<string, unknown> | string {
  if (text === undefined || text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return `${name} is not valid JSON; left unchanged.`;
  }
  return isRecord(parsed) ? parsed : `${name} must contain a JSON object; left unchanged.`;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shellArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function tomlString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

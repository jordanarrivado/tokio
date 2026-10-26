import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SECRET_DENY_PATTERNS } from '../context/discovery';
import { CATALOG_FILE, findMissingRepos, loadCatalog, type Catalog } from './catalog';
import { AGENTS_BEGIN, AGENTS_END, toolsMissingFromMatcher } from './init';

export type CheckLevel = 'ok' | 'info' | 'warn' | 'fail';

export interface DoctorCheck {
  level: CheckLevel;
  name: string;
  detail: string;
}

/**
 * Reads a project's Tokio setup and reports what is wrong or missing. Read-only: nothing is written.
 * A missing file is a warning, not a failure, because a project may use only one of the agents.
 */
export async function runDoctor(root: string): Promise<DoctorCheck[]> {
  const settings = checkClaudeSettings(await readText(join(root, '.claude', 'settings.json')));
  return [
    ...checkMcpConfig(await readText(join(root, '.mcp.json')), root),
    ...settings,
    ...checkCodexConfig(await readText(join(root, '.codex', 'config.toml'))),
    ...checkAgentsGuidance(await readText(join(root, 'AGENTS.md'))),
    ...await checkCatalog(root, settings.some((check) => check.name === 'PreToolUse hook' && !/not registered/.test(check.detail)))
  ];
}

/**
 * The repository catalog: valid, every path an existing directory, each one a git repository. With more
 * than one repository and no tokio PreToolUse hook, the write scope is not enforced.
 */
export async function checkCatalog(root: string, hookRegistered: boolean): Promise<DoctorCheck[]> {
  const name = CATALOG_FILE;
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(root);
  } catch (error) {
    return [{ level: 'fail', name, detail: error instanceof Error ? error.message : String(error) }];
  }
  if (!catalog.fromFile) {
    return [{ level: 'info', name, detail: 'none; the root is the only repository.' }];
  }

  const missing = await findMissingRepos(catalog);
  const checks: DoctorCheck[] = catalog.repos.map((repo): DoctorCheck => {
    const path = repo.path.replaceAll('\\', '/');
    if (missing.has(repo.name)) {
      return { level: 'fail', name: `repo ${repo.name}`, detail: `${path} is not a directory. Clone it there or fix its path.` };
    }
    if (!existsSync(join(repo.path, '.git'))) {
      return { level: 'warn', name: `repo ${repo.name}`, detail: `${path} is not a git repository, so co-change ranking has no history.` };
    }
    return { level: 'ok', name: `repo ${repo.name}`, detail: `${path}${repo.name === catalog.defaultRepo ? ' (write target)' : ''}.` };
  });
  if (catalog.repos.length > 1 && !hookRegistered) {
    checks.push({ level: 'warn', name, detail: 'no tokio PreToolUse hook, so read-only repositories are not enforced. Run tokio init.' });
  }
  return [{ level: 'ok', name, detail: `${catalog.repos.length} repositories; write target ${catalog.defaultRepo}.` }, ...checks];
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function checkMcpConfig(text: string | undefined, root: string): DoctorCheck[] {
  const name = '.mcp.json';
  if (text === undefined) {
    return [{ level: 'warn', name, detail: 'missing. Run tokio init to register the tokio MCP server for Claude Code.' }];
  }
  const doc = parseJson(text);
  if (!doc) {
    return [{ level: 'fail', name, detail: 'not valid JSON.' }];
  }
  const server = isRecord(doc.mcpServers) ? doc.mcpServers.tokio : undefined;
  if (!isRecord(server)) {
    return [{ level: 'warn', name, detail: 'no "tokio" server registered. Run tokio init.' }];
  }
  const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : [];
  const cli = args.find((arg) => arg.endsWith('cli.js'));
  if (!cli) {
    return [{ level: 'fail', name, detail: 'tokio server args do not name a cli.js file.' }];
  }
  if (!existsSync(resolve(root, cli))) {
    return [{ level: 'fail', name, detail: `CLI does not exist: ${cli}. Run npm run build, or re-run tokio init from the built checkout.` }];
  }
  return [{ level: 'ok', name, detail: `tokio server runs ${cli}.` }];
}

export function checkClaudeSettings(text: string | undefined): DoctorCheck[] {
  const name = '.claude/settings.json';
  if (text === undefined) {
    return [{ level: 'warn', name, detail: 'missing. Run tokio init to add the PreToolUse hook.' }];
  }
  const doc = parseJson(text);
  if (!doc) {
    return [{ level: 'fail', name, detail: 'not valid JSON.' }];
  }

  const checks: DoctorCheck[] = [];
  const hooks = isRecord(doc.hooks) ? doc.hooks : {};

  // A permissions key nested inside a hook matcher entry is never read, so the rule silently does nothing.
  const misplaced = Object.values(hooks).some((entries) =>
    Array.isArray(entries) && entries.some((entry) => isRecord(entry) && 'permissions' in entry)
  );
  if (misplaced) {
    checks.push({
      level: 'fail',
      name,
      detail: '"permissions" is inside a hook matcher entry and is ignored. Move it to the top level, next to "hooks".'
    });
  }

  const allow = isRecord(doc.permissions) && Array.isArray(doc.permissions.allow) ? doc.permissions.allow : undefined;
  if (allow) {
    checks.push({ level: 'info', name: 'permissions.allow', detail: allow.map(String).join(', ') || '(empty)' });
  }

  // Read deny rules are what stop Grep and Glob from reading secret files. The hook only checks path fields.
  const deny = isRecord(doc.permissions) && Array.isArray(doc.permissions.deny) ? doc.permissions.deny.map(String) : [];
  const missing = SECRET_DENY_PATTERNS.filter((pattern) => !deny.includes(`Read(${pattern})`));
  if (missing.length > 0) {
    checks.push({
      level: 'warn',
      name: 'secret deny rules',
      detail: `${missing.length} of ${SECRET_DENY_PATTERNS.length} Read deny rules missing, so Grep and Glob can read those files. Run tokio init (preview with --dry-run).`
    });
  } else {
    checks.push({ level: 'ok', name: 'secret deny rules', detail: 'all secret-file Read deny rules are present.' });
  }

  const preToolUse = commandsFor(hooks, 'PreToolUse');
  if (preToolUse.some((command) => /cli\.js\S*\s+hook(\s|$)/.test(command))) {
    const uncovered = uncoveredTools(hooks);
    checks.push(uncovered.length === 0
      ? { level: 'ok', name: 'PreToolUse hook', detail: 'tokio hook is registered.' }
      : {
          level: 'warn',
          name: 'PreToolUse hook',
          detail: `tokio hook does not cover ${uncovered.join(', ')}, so secret files can be read through them. Run tokio init --force (preview with --dry-run).`
        });
  } else {
    checks.push({ level: 'warn', name: 'PreToolUse hook', detail: 'tokio hook is not registered, so secret files are not blocked.' });
  }

  const promptSubmit = commandsFor(hooks, 'UserPromptSubmit');
  if (promptSubmit.some((command) => /cli\.js\S*\s+prompt-hook(\s|$)/.test(command))) {
    checks.push({ level: 'ok', name: 'UserPromptSubmit hook', detail: 'tokio prompt-hook is registered.' });
  } else {
    checks.push({ level: 'info', name: 'UserPromptSubmit hook', detail: 'not registered. Optional: adds a repo map to matching prompts and adds tokens to each one.' });
  }

  return checks;
}

export function checkCodexConfig(text: string | undefined): DoctorCheck[] {
  const name = '.codex/config.toml';
  if (text === undefined) {
    return [{ level: 'info', name, detail: 'missing. Codex is not configured for this project.' }];
  }
  if (text.includes('[mcp_servers.tokio]')) {
    return [{ level: 'ok', name, detail: 'tokio MCP server is registered.' }];
  }
  return [{ level: 'warn', name, detail: 'no [mcp_servers.tokio] table. Run tokio init.' }];
}

export function checkAgentsGuidance(text: string | undefined): DoctorCheck[] {
  const name = 'AGENTS.md';
  if (text === undefined) {
    return [{ level: 'warn', name, detail: 'missing. Run tokio init to add the tool workflow.' }];
  }
  const hasBegin = text.includes(AGENTS_BEGIN);
  const hasEnd = text.includes(AGENTS_END);
  if (hasBegin && hasEnd) {
    return [{ level: 'ok', name, detail: 'tokio guidance block is present.' }];
  }
  if (hasBegin || hasEnd) {
    return [{ level: 'fail', name, detail: 'tokio:begin and tokio:end markers are not both present. Fix the markers or re-run tokio init --force.' }];
  }
  return [{
    level: 'warn',
    name,
    detail: 'no tokio:begin and tokio:end block. Guidance written by hand is left alone by tokio init, so wrap it in the markers to let tokio manage it.'
  }];
}

/** Tools that tokio init guards but no PreToolUse entry running tokio hook matches. */
function uncoveredTools(hooks: Record<string, unknown>): string[] {
  const entries = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const missing = entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && Array.isArray(entry.hooks)
      && entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === 'string' && /cli\.js\S*\s+hook(\s|$)/.test(hook.command)))
    .map((entry) => toolsMissingFromMatcher(entry.matcher));
  // A tool is uncovered only when every tokio entry misses it.
  return missing.length === 0 ? [] : missing.reduce((left, right) => left.filter((tool) => right.includes(tool)));
}

function commandsFor(hooks: Record<string, unknown>, event: string): string[] {
  const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
  const commands: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      continue;
    }
    for (const hook of entry.hooks) {
      if (isRecord(hook) && typeof hook.command === 'string') {
        commands.push(hook.command);
      }
    }
  }
  return commands;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

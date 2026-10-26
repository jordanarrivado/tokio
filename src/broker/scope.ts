import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { contains, loadCatalog, type Catalog } from './catalog';
import type { HookVerdict } from './hook';

/**
 * Write scope across catalog repositories. The default repository is always writable. The user grants
 * write on another one for a few hours with `tokio scope <name>`, which records it in .tokio/scope.json.
 * The PreToolUse hook checks file edits against the scope and refuses any agent attempt to grant one,
 * so only the user widens it. Bash writes are not inspected: this is a guard, not a sandbox.
 */

export const SCOPE_FILE = '.tokio/scope.json';
export const DEFAULT_GRANT_HOURS = 4;
export const MAX_GRANT_HOURS = 24;

/** Tools that write a file, and the input field that names it. */
const WRITE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
};
const SCOPE_FILE_PATTERN = /(?:^|[\\/])\.tokio[\\/]+scope\.json$/i;
const SCOPE_FILE_MENTION = /\.tokio[\\/]+scope\.json/i;
/** `tokio scope`, or the CLI run by path: `node out/broker/cli.js scope`. */
const SCOPE_COMMAND = /(?:^|[\s;&|(`'"])(?:tokio(?:\.cmd)?|[^\s;&|'"]*cli\.js['"]?)\s+scope\b/i;
const GRANT_ONLY_BY_USER = 'only the user can change write scope. Ask the user to run tokio scope in their own terminal.';

export interface Grant {
  repo: string;
  expiresAt: string;
}

/** Grants that have not expired. A missing or unreadable scope file grants nothing. */
export async function readGrants(root: string, now = new Date()): Promise<Grant[]> {
  const text = await readFile(join(root, SCOPE_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const grants = typeof parsed === 'object' && parsed !== null ? (parsed as { grants?: unknown }).grants : undefined;
    if (!Array.isArray(grants)) {
      return [];
    }
    return grants.filter((grant): grant is Grant => typeof grant === 'object' && grant !== null
      && typeof grant.repo === 'string'
      && typeof grant.expiresAt === 'string'
      && Date.parse(grant.expiresAt) > now.getTime());
  } catch {
    return [];
  }
}

/** Grants write on the named repositories for `hours`, replacing earlier grants for the same ones. */
export async function grantScope(root: string, names: readonly string[], hours: number, now = new Date()): Promise<Grant[]> {
  const catalog = await loadCatalog(root);
  const known = catalog.repos.map((repo) => repo.name);
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown repository "${unknown[0]}". Repositories: ${known.join(', ')}.`);
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_GRANT_HOURS) {
    throw new Error(`--hours must be an integer from 1 to ${MAX_GRANT_HOURS}.`);
  }

  const expiresAt = new Date(now.getTime() + hours * 3_600_000).toISOString();
  const granted = names.filter((name) => name !== catalog.defaultRepo);
  const kept = (await readGrants(root, now)).filter((grant) => !granted.includes(grant.repo));
  const grants = [...kept, ...[...new Set(granted)].map((repo) => ({ repo, expiresAt }))];
  await mkdir(dirname(join(root, SCOPE_FILE)), { recursive: true });
  await writeFile(join(root, SCOPE_FILE), `${JSON.stringify({ grants }, null, 2)}\n`, 'utf8');
  return grants;
}

/** Removes the grant for one repository, keeping the others. */
export async function revokeScope(root: string, name: string, now = new Date()): Promise<Grant[]> {
  const grants = (await readGrants(root, now)).filter((grant) => grant.repo !== name);
  if (grants.length === 0) {
    await clearScope(root);
  } else {
    await writeFile(join(root, SCOPE_FILE), `${JSON.stringify({ grants }, null, 2)}\n`, 'utf8');
  }
  return grants;
}

export async function clearScope(root: string): Promise<void> {
  await rm(join(root, SCOPE_FILE), { force: true });
}

/** The `tokio scope` report: the default write target and each live grant. */
export function formatScope(catalog: Catalog, grants: readonly Grant[]): string {
  return [
    `Write target: ${catalog.defaultRepo} (default).`,
    ...(grants.length > 0
      ? grants.map((grant) => `Also writable: ${grant.repo} until ${grant.expiresAt}.`)
      : ['No other repository is writable.'])
  ].join('\n');
}

/**
 * The write-scope verdict for a PreToolUse event, or undefined when the call may run. The catalog and
 * scope file are read from `root`, normally the event's cwd.
 */
export async function evaluateWriteScope(
  tool: string,
  toolInput: Record<string, unknown>,
  root: string,
  now = new Date()
): Promise<HookVerdict | undefined> {
  if (typeof toolInput.command === 'string') {
    const command = toolInput.command;
    if (SCOPE_COMMAND.test(command) || SCOPE_FILE_MENTION.test(command)) {
      return { blocked: true, tool, reason: GRANT_ONLY_BY_USER, cwd: root };
    }
    return undefined;
  }

  const field = WRITE_TOOLS[tool];
  const value = field === undefined ? undefined : toolInput[field];
  if (typeof value !== 'string') {
    return undefined;
  }
  if (SCOPE_FILE_PATTERN.test(value)) {
    return { blocked: true, tool, path: value, reason: GRANT_ONLY_BY_USER, cwd: root };
  }

  let catalog: Catalog;
  try {
    catalog = await loadCatalog(root);
  } catch (error) {
    // Without a valid catalog the read-only repositories are unknown, so edits fail closed.
    const message = error instanceof Error ? error.message : String(error);
    return { blocked: true, tool, path: value, reason: `${message} Fix it before editing files.`, cwd: root };
  }

  const target = resolve(root, value);
  const repo = catalog.repos.find((candidate) => contains(candidate.path, target));
  if (!repo || repo.name === catalog.defaultRepo) {
    return undefined;
  }
  const grants = await readGrants(root, now);
  if (grants.some((grant) => grant.repo === repo.name)) {
    return undefined;
  }
  return {
    blocked: true,
    tool,
    path: value,
    reason: `${repo.name} is read-only for this task. Ask the user to run: tokio scope ${repo.name}`,
    cwd: root,
    repo: repo.name
  };
}

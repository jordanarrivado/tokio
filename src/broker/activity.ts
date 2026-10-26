import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { AUDIT_DIRECTORY } from './audit';
import { contains, loadCatalog, type Catalog } from './catalog';

/**
 * Which catalog repository an agent is reading, editing, or running commands in, for the repository map.
 * The PreToolUse hook appends one line per allowed tool call. It is kept apart from the audit log, so
 * built-in tool calls never count toward Tokio's token stats. Entries hold a tool name, a repository,
 * and at most a file name; never file contents or commands.
 */

export const ACTIVITY_FILE = 'activity.log';
/** The log is cut back to its newest KEEP_BYTES once it passes MAX_BYTES; the map reads only the end. */
const MAX_BYTES = 256 * 1024;
const KEEP_BYTES = 32 * 1024;

export type ActivityAction = 'reading' | 'editing' | 'running';

export interface ActivityEntry {
  timestamp: string;
  tool: string;
  action: ActivityAction;
  repo: string;
  /** File name only, without its directory. */
  file?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * The repositories a tool call touches. A file tool touches the repository holding its path, or the cwd's
 * when it names none. A command touches every repository whose folder it names, or else the cwd's.
 */
export function detectActivity(
  catalog: Catalog,
  tool: string,
  toolInput: Record<string, unknown>,
  cwd: string
): { repo: string; action: ActivityAction; file?: string }[] {
  if (typeof toolInput.command === 'string') {
    const command = normalize(toolInput.command);
    const named = catalog.repos.filter((repo) => command.includes(normalize(repo.path)));
    const repos = named.length > 0 ? named.map((repo) => repo.name) : [repoFor(catalog, cwd)];
    return repos.filter((repo): repo is string => repo !== undefined).map((repo) => ({ repo, action: 'running' }));
  }

  const action: ActivityAction = EDIT_TOOLS.has(tool) ? 'editing' : 'reading';
  const field = PATH_FIELDS.find((name) => typeof toolInput[name] === 'string' && toolInput[name] !== '');
  const target = field === undefined ? cwd : resolve(cwd, toolInput[field] as string);
  const repo = repoFor(catalog, target);
  if (repo === undefined) {
    return [];
  }
  // Grep and Glob take a folder in `path`; only a file field names a file worth showing.
  const file = field === 'file_path' || field === 'notebook_path' ? basename(toolInput[field] as string) : undefined;
  return [{ repo, action, ...(file ? { file } : {}) }];
}

/** Records a hook event. Never throws: the map is a view, and must not affect the tool call. */
export async function recordToolActivity(
  root: string,
  tool: string,
  toolInput: Record<string, unknown>,
  now = new Date()
): Promise<void> {
  try {
    const catalog = await loadCatalog(root);
    const entries = detectActivity(catalog, tool, toolInput, root);
    if (entries.length === 0) {
      return;
    }
    const directory = join(root, AUDIT_DIRECTORY);
    await mkdir(directory, { recursive: true });
    const file = join(directory, ACTIVITY_FILE);
    const lines = entries.map((entry): ActivityEntry => ({ timestamp: now.toISOString(), tool, ...entry }));
    await appendFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
    await trim(file);
  } catch {
    // No catalog, or .tokio not writable: nothing to show.
  }
}

export function isActivityEntry(value: unknown): value is ActivityEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === 'string'
    && typeof record.tool === 'string'
    && typeof record.repo === 'string'
    && (record.action === 'reading' || record.action === 'editing' || record.action === 'running');
}

/** The deepest catalog repository holding `target`, so a nested repository wins over its parent. */
function repoFor(catalog: Catalog, target: string): string | undefined {
  return catalog.repos
    .filter((repo) => contains(repo.path, target))
    .sort((left, right) => right.path.length - left.path.length)[0]?.name;
}

function normalize(text: string): string {
  return text.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

async function trim(file: string): Promise<void> {
  const { size } = await stat(file);
  if (size <= MAX_BYTES) {
    return;
  }
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(KEEP_BYTES);
    await handle.read(buffer, 0, KEEP_BYTES, size - KEEP_BYTES);
    const text = buffer.toString('utf8');
    // Drop the partial first line.
    await writeFile(file, text.slice(text.indexOf('\n') + 1), 'utf8');
  } finally {
    await handle.close();
  }
}

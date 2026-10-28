import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isSecretPath } from '../context/discovery';
import { MAP_PATH, mapPaths, parseArchitectureMap, resolveMapAnchors, type MapArea, type MapFile, type MapRouting, type RankedArea } from '../context/archmap';
import { resolveRepoPath } from './policy';

/**
 * The repository's architecture map lives at `.tokio/map.md` and is used for every task, by repo_map and the
 * prompt hook alike. Areas already sent to an agent in a session are recorded, so the hook sends each area once.
 */

export const MAP_SESSION_FILE = '.tokio/map-session.json';
const MAX_MAP_BYTES = 128_000;
/** Routed files are only searched for line numbers, never sent whole, so they may exceed the scan's size cap. */
const MAX_ROUTED_FILE_BYTES = 512_000;
/** Sessions kept in the session file; older ones are dropped so it stays small. */
const MAX_SESSIONS = 5;

export interface LoadedMap {
  path: string;
  areas: MapArea[];
}

interface SessionState {
  sessions: { id: string; areas: string[]; at: string }[];
}

/**
 * Reads `.tokio/map.md` under root, or an explicit map path through the same path policy as read_symbol.
 * Undefined when the default map does not exist; an explicit path that cannot be read is an error.
 */
export async function loadArchitectureMap(root: string, explicitPath?: string, signal?: AbortSignal): Promise<LoadedMap | undefined> {
  let resolved: { absolute: string; relative: string };
  try {
    resolved = await resolveRepoPath(root, explicitPath ?? MAP_PATH);
  } catch (error) {
    if (explicitPath === undefined) {
      return undefined;
    }
    throw error;
  }
  if (!resolved.relative.toLowerCase().endsWith('.md')) {
    throw new Error(`mapPath must be a Markdown file (got ${resolved.relative}).`);
  }
  if ((await stat(resolved.absolute)).size > MAX_MAP_BYTES) {
    throw new Error(`${resolved.relative} is larger than ${MAX_MAP_BYTES / 1000} KB. Split it or trim the prose.`);
  }
  const areas = parseArchitectureMap(await readFile(resolved.absolute, { encoding: 'utf8', signal }));
  return { path: resolved.relative, areas };
}

/** Names of the areas already sent in this session. Empty for a new session or an unreadable file. */
export async function readSessionAreas(root: string, sessionId: string): Promise<Set<string>> {
  const state = await readSessionState(root);
  return new Set(state.sessions.find((session) => session.id === sessionId)?.areas ?? []);
}

/** Adds areas to this session's record. The newest session moves to the front. */
export async function recordSessionAreas(root: string, sessionId: string, areas: readonly string[], now = new Date()): Promise<void> {
  const state = await readSessionState(root);
  const previous = state.sessions.find((session) => session.id === sessionId)?.areas ?? [];
  const sessions = [
    { id: sessionId, areas: [...new Set([...previous, ...areas])], at: now.toISOString() },
    ...state.sessions.filter((session) => session.id !== sessionId)
  ].slice(0, MAX_SESSIONS);
  const file = join(root, MAP_SESSION_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
}

async function readSessionState(root: string): Promise<SessionState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, MAP_SESSION_FILE), 'utf8'));
    const sessions = (parsed as SessionState | undefined)?.sessions;
    if (!Array.isArray(sessions)) {
      return { sessions: [] };
    }
    return {
      sessions: sessions.filter((session) => typeof session?.id === 'string' && Array.isArray(session.areas))
        .map((session) => ({ id: session.id, areas: session.areas.filter((area) => typeof area === 'string'), at: String(session.at) }))
    };
  } catch {
    return { sessions: [] };
  }
}

/**
 * Resolves ranked areas to files and lines. Files come from the scan first; a routed file the scan skipped,
 * such as one over the scan's size cap, is read from root through the path policy. With several repositories,
 * prefix is the write target's name, which scanned paths carry.
 */
export async function resolveAgainstRepo(
  ranked: readonly RankedArea[],
  files: readonly MapFile[],
  target: { root: string; prefix?: string },
  task: string,
  signal?: AbortSignal
): Promise<MapRouting> {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const scanned = (path: string): MapFile | undefined => byPath.get(path)
    ?? (target.prefix !== undefined ? byPath.get(`${target.prefix}/${path}`) : undefined);
  const loaded = new Map<string, MapFile>();
  const folders = new Set<string>();
  for (const path of mapPaths(ranked).filter((candidate) => !scanned(candidate))) {
    const file = await readRoutedFile(target.root, path, signal);
    if (file) {
      loaded.set(path, { path: target.prefix !== undefined ? `${target.prefix}/${file.path}` : file.path, content: file.content });
    } else if (await isRoutedFolder(target.root, path)) {
      folders.add(path);
    }
  }
  return resolveMapAnchors(ranked, (path) => scanned(path) ?? loaded.get(path), task, (path) => folders.has(path));
}

/** True when a map path names a folder inside root. Secret folders and paths that leave root never count. */
async function isRoutedFolder(root: string, path: string): Promise<boolean> {
  if (!path || isAbsolute(path) || path.split('/').includes('..') || isSecretPath(path)) {
    return false;
  }
  try {
    return (await stat(join(root, path))).isDirectory();
  } catch {
    return false;
  }
}

/** A file a map routes to, or undefined when it is missing, blocked, or too large to search. */
async function readRoutedFile(root: string, path: string, signal?: AbortSignal): Promise<MapFile | undefined> {
  try {
    const { absolute, relative } = await resolveRepoPath(root, path);
    if ((await stat(absolute)).size > MAX_ROUTED_FILE_BYTES) {
      return undefined;
    }
    return { path: relative, content: await readFile(absolute, { encoding: 'utf8', signal }) };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    return undefined;
  }
}

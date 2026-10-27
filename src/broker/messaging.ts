import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { findMissingRepos, loadCatalog, type Catalog, type CatalogRepo } from './catalog';
import type { HookVerdict } from './hook';

/**
 * Which catalog repositories this one may message. The user switches each one on or off on the
 * repository map; nothing is on until they do. A switch is written to both repositories, so the agent
 * on either side is held to it. The PreToolUse hook checks Claude Code's SendMessage against it, which
 * delivers straight into the other repository's open session. Only the user changes it: the hook
 * refuses agent edits to the file, as it does for write scope.
 */

export const MESSAGING_FILE = '.tokio/messaging.json';
const MESSAGING_FILE_PATTERN = /(?:^|[\\/])\.tokio[\\/]+messaging\.json$/i;
const MESSAGING_FILE_MENTION = /\.tokio[\\/]+messaging\.json/i;
const SWITCH_ONLY_BY_USER = 'only the user can switch messaging. Ask the user to use the switch on the tokio repository map.';
/** Claude Code names a local session after its folder plus a short hex suffix, as in `hierpayroll-v3-api-b7`. */
const SESSION_SUFFIX = /-[0-9a-f]{2,8}$/i;
const FILE_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/**
 * The repository the root belongs to: the one whose path is the root. The default repository is
 * only a fallback, because a catalog may name another repository as its write target.
 */
export function ownRepo(catalog: Catalog, root: string): CatalogRepo {
  const key = (path: string): string => {
    const normal = resolve(path).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
  };
  const atRoot = catalog.repos.find((repo) => key(repo.path) === key(root));
  return atRoot ?? catalog.repos.find((repo) => repo.name === catalog.defaultRepo) ?? catalog.repos[0];
}

/** Repositories messaging is on for. A missing or unreadable file means none. */
export async function readConnections(root: string): Promise<string[]> {
  const text = await readFile(join(root, MESSAGING_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const connected = typeof parsed === 'object' && parsed !== null ? (parsed as { connected?: unknown }).connected : undefined;
    return Array.isArray(connected) ? connected.filter((name): name is string => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Switches messaging between the repository at root and `name`, in both repositories' files. The other
 * side records this repository under the name this catalog gives it, so both catalogs should agree on names.
 */
export async function setConnection(root: string, name: string, on: boolean): Promise<string[]> {
  const catalog = await loadCatalog(root);
  const own = ownRepo(catalog, root);
  const peer = catalog.repos.find((repo) => repo.name === name);
  if (!peer) {
    throw new Error(`Unknown repository "${name}". Repositories: ${catalog.repos.map((repo) => repo.name).join(', ')}.`);
  }
  if (peer.name === own.name) {
    throw new Error(`${name} is this repository.`);
  }
  // Writing the other side's file must not create a folder for a repository that is not there.
  if ((await findMissingRepos(catalog)).has(peer.name)) {
    throw new Error(`Repository folder not found: ${name}.`);
  }
  await writeConnection(peer.path, own.name, on);
  return writeConnection(own.path, peer.name, on);
}

async function writeConnection(repoPath: string, name: string, on: boolean): Promise<string[]> {
  const kept = (await readConnections(repoPath)).filter((existing) => existing !== name);
  const connected = on ? [...kept, name] : kept;
  const file = join(repoPath, MESSAGING_FILE);
  if (connected.length === 0) {
    await rm(file, { force: true });
  } else {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ connected }, null, 2)}\n`, 'utf8');
    await ignoreInTokioDirectory(dirname(file), basename(file));
  }
  return connected;
}

/**
 * The switch is per user, and the other repository may never have run tokio init, so the file is
 * ignored from inside .tokio. Other files there, such as a committed layout, are left as they are.
 */
async function ignoreInTokioDirectory(directory: string, name: string): Promise<void> {
  const ignore = join(directory, '.gitignore');
  const text = await readFile(ignore, 'utf8').catch(() => '');
  if (text.split(/\r?\n/).includes(name)) {
    return;
  }
  await writeFile(ignore, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${name}\n`, 'utf8');
}

/**
 * The catalog repository a SendMessage target names, or undefined when it names none: a teammate,
 * "main", or a reply address such as `uds:...`. A reply only follows a message that already got
 * through, so addresses are left to the sender's own switch.
 */
export function repoForSession(catalog: Catalog, to: string): CatalogRepo | undefined {
  const name = to.replace(/\s*\[[^\]]*\]\s*$/, '').trim().toLowerCase();
  if (name === '' || name.includes(':')) {
    return undefined;
  }
  const bare = name.replace(SESSION_SUFFIX, '');
  return catalog.repos.find((repo) => {
    const names = [repo.name.toLowerCase(), basename(repo.path).toLowerCase()];
    return names.includes(name) || names.includes(bare);
  });
}

/** `~api: why is this needed` at the start of a prompt addresses another repository's agent session. */
const ADDRESS = /^~\s*([A-Za-z0-9][\w.-]*)\s*:\s*([\s\S]*)$/;

export interface RepoAddress {
  name: string;
  question: string;
}

/** The repository name and question of an addressed prompt, or undefined for any other prompt. */
export function parseRepoAddress(prompt: string): RepoAddress | undefined {
  const match = ADDRESS.exec(prompt.trim());
  return match ? { name: match[1], question: match[2].trim() } : undefined;
}

/**
 * The repositories a short name points at: an exact repository or folder name, else every repository
 * with the name as one of its dash, underscore, or dot separated parts, so `api` finds `hierpayroll-v3-api`.
 */
export function resolveRepoName(catalog: Catalog, name: string): CatalogRepo[] {
  const wanted = name.toLowerCase();
  const exact = catalog.repos.filter((repo) => [repo.name, basename(repo.path)].some((candidate) => candidate.toLowerCase() === wanted));
  if (exact.length > 0) {
    return exact;
  }
  return catalog.repos.filter((repo) => repo.name.toLowerCase().split(/[-_.]+/).includes(wanted));
}

export interface AddressedPrompt {
  /** Context for the agent: how to relay the question, or why it cannot. */
  text: string;
  /** The repository the question goes to, when it resolved to one that messaging is on for. */
  repo?: string;
}

/**
 * Instructions for an addressed prompt. The agent relays the question with SendMessage instead of
 * answering it, so the PreToolUse messaging check still decides whether it gets through.
 */
export function routeAddressedPrompt(
  catalog: Catalog,
  root: string,
  address: RepoAddress,
  connections: readonly string[]
): AddressedPrompt {
  const names = catalog.repos.map((repo) => repo.name).join(', ');
  const matches = resolveRepoName(catalog, address.name);
  if (matches.length === 0) {
    return { text: `Tokio: the prompt starts with ~${address.name}:, but no repository in tokio.repos.json is called that. Repositories: ${names}. Tell the user, and do not message any session.` };
  }
  if (matches.length > 1) {
    return { text: `Tokio: ~${address.name}: matches more than one repository: ${matches.map((repo) => repo.name).join(', ')}. Ask the user which one they mean, and do not message any session yet.` };
  }
  const [peer] = matches;
  if (peer.name === ownRepo(catalog, root).name) {
    return { text: `Tokio: ~${address.name}: names this repository, so answer the question yourself.` };
  }
  if (address.question === '') {
    return { text: `Tokio: the prompt addresses ${peer.name} but has no question after ~${address.name}:. Ask the user what to send.` };
  }
  if (!connections.includes(peer.name)) {
    return { text: `Tokio: the user addressed this question to the agent session of ${peer.name}, but messaging with ${peer.name} is off. Tell the user to switch it on for ${peer.name} on the tokio repository map and send the prompt again. Do not answer the question yourself.` };
  }
  const folder = basename(peer.path);
  return {
    repo: peer.name,
    text: [
      `Tokio: the user addressed this question to the agent session of ${peer.name} (${peer.path}), not to you.`,
      `1. Call ListAgents and find the session for ${folder}. If none is open, call the tokio ask_repo tool with repo "${peer.name}" and the question instead, and skip step 2.`,
      '2. Call SendMessage to that session with the question below, word for word, and ask for feedback on the answer.',
      '3. Do not answer the question yourself. When the reply arrives, pass it to the user.',
      '<question>',
      address.question,
      '</question>'
    ].join('\n')
  };
}

/** The context for a prompt that starts with ~name:, or undefined for any other prompt or a root without a catalog. */
export async function addressedPromptContext(root: string, prompt: string): Promise<AddressedPrompt | undefined> {
  const address = parseRepoAddress(prompt);
  if (!address) {
    return undefined;
  }
  let catalog: Catalog;
  try {
    catalog = await loadCatalog(root);
  } catch {
    return undefined;
  }
  return routeAddressedPrompt(catalog, root, address, await readConnections(ownRepo(catalog, root).path));
}

/** The messaging verdict for a PreToolUse event, or undefined when the call may run. */
export async function evaluateMessaging(
  tool: string,
  toolInput: Record<string, unknown>,
  root: string
): Promise<HookVerdict | undefined> {
  if (typeof toolInput.command === 'string') {
    return MESSAGING_FILE_MENTION.test(toolInput.command) ? { blocked: true, tool, reason: SWITCH_ONLY_BY_USER, cwd: root } : undefined;
  }
  const field = FILE_TOOLS[tool];
  const path = field === undefined ? undefined : toolInput[field];
  if (typeof path === 'string' && MESSAGING_FILE_PATTERN.test(path)) {
    return { blocked: true, tool, path, reason: SWITCH_ONLY_BY_USER, cwd: root };
  }
  if (tool !== 'SendMessage' || typeof toolInput.to !== 'string') {
    return undefined;
  }

  let catalog: Catalog;
  try {
    catalog = await loadCatalog(root);
  } catch {
    // Without a catalog no session maps to a repository, so there is nothing to switch.
    return undefined;
  }
  const peer = repoForSession(catalog, toolInput.to);
  const own = ownRepo(catalog, root);
  if (!peer || peer.name === own.name || (await readConnections(own.path)).includes(peer.name)) {
    return undefined;
  }
  return {
    blocked: true,
    tool,
    reason: `messaging with ${peer.name} is off. Ask the user to switch it on for ${peer.name} on the tokio repository map.`,
    cwd: root,
    repo: peer.name
  };
}

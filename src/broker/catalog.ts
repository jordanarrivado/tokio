import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { isSecretPath } from '../context/discovery';

/**
 * The repository catalog lists the local repositories one agent may work across. It lives in
 * tokio.repos.json at the root and is read on every call, so edits apply without a restart.
 * Without the file, the root is the only repository, which keeps single-repository setups unchanged.
 */

export const CATALOG_FILE = 'tokio.repos.json';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export interface CatalogRepo {
  name: string;
  /** Absolute path. A relative path in the file is resolved against the root. */
  path: string;
  purpose?: string;
  dependsOn: string[];
  /** Raises or lowers this repository's scan cap; the default is 500 files. */
  maxFiles?: number;
}

/** The highest `maxFiles` a repository may set. Matches the scanner's limit. */
const MAX_FILES_LIMIT = 5000;

/** What a file link stands for. */
export const LINK_KINDS = ['api', 'type', 'event', 'schema', 'config', 'other'] as const;
export type LinkKind = typeof LINK_KINDS[number];

/** One end of a file link: a file inside a catalog repository. */
export interface LinkEnd {
  repo: string;
  /** Repository-relative, forward slashes. */
  path: string;
}

/**
 * A contract between files in two repositories that imports cannot reveal, such as an HTTP endpoint
 * and the frontend code that calls it. Written as `"repo:path"` in the file.
 */
export interface CatalogLink {
  from: LinkEnd;
  to: LinkEnd;
  kind: LinkKind;
  note?: string;
}

export interface Catalog {
  /** The write target. Every other repository is read-only. */
  defaultRepo: string;
  repos: CatalogRepo[];
  links: CatalogLink[];
  /** False when there is no catalog file and the root stands in as the only repository. */
  fromFile: boolean;
}

export class CatalogError extends Error {}

export async function loadCatalog(root: string, signal?: AbortSignal): Promise<Catalog> {
  let text: string;
  try {
    text = await readFile(join(root, CATALOG_FILE), { encoding: 'utf8', signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return implicitCatalog(root);
    }
    throw error;
  }
  return parseCatalog(text, root);
}

/** Validates catalog text. Throws a CatalogError that names the first problem found. */
export function parseCatalog(text: string, root: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(`not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!isRecord(raw)) {
    fail('expected an object with "default" and "repos".');
  }
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    fail('"repos" must be a non-empty array.');
  }

  const repos: CatalogRepo[] = [];
  const seen = new Set<string>();
  raw.repos.forEach((entry: unknown, index: number) => {
    const at = `repos[${index}]`;
    if (!isRecord(entry)) {
      fail(`${at} must be an object with "name" and "path".`);
    }
    const { name, path, purpose, dependsOn, maxFiles } = entry;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      fail(`${at}.name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.`);
    }
    if (seen.has(name.toLowerCase())) {
      fail(`repository name "${name}" is used twice.`);
    }
    seen.add(name.toLowerCase());
    if (typeof path !== 'string' || path.trim() === '') {
      fail(`${at}.path must be a non-empty string.`);
    }
    if (URL_PATTERN.test(path)) {
      fail(`${at}.path must be a local directory, not a URL.`);
    }
    if (purpose !== undefined && typeof purpose !== 'string') {
      fail(`${at}.purpose must be a string.`);
    }
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== 'string'))) {
      fail(`${at}.dependsOn must be an array of repository names.`);
    }
    if (maxFiles !== undefined && (typeof maxFiles !== 'number' || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES_LIMIT)) {
      fail(`${at}.maxFiles must be an integer from 1 to ${MAX_FILES_LIMIT}.`);
    }
    repos.push({
      name,
      path: resolve(root, path),
      ...(purpose !== undefined && purpose.trim() !== '' ? { purpose: purpose.trim() } : {}),
      dependsOn: [...new Set((dependsOn ?? []) as string[])],
      ...(maxFiles !== undefined ? { maxFiles } : {})
    });
  });

  const names = repos.map((repo) => repo.name);
  if (typeof raw.default !== 'string' || !names.includes(raw.default)) {
    const got = typeof raw.default === 'string' ? `got "${raw.default}"; ` : '';
    fail(`"default" must name a repository in "repos" (${got}names: ${names.join(', ')}).`);
  }

  repos.forEach((repo, index) => {
    for (const dependency of repo.dependsOn) {
      if (dependency === repo.name) {
        fail(`repos[${index}].dependsOn cannot name the repository itself.`);
      }
      if (!names.includes(dependency)) {
        fail(`repos[${index}].dependsOn names unknown repository "${dependency}".`);
      }
    }
  });
  // Run for its cycle check; list_repositories computes the order again when it needs it.
  dependencyOrder(repos);

  for (let left = 0; left < repos.length; left += 1) {
    for (let right = left + 1; right < repos.length; right += 1) {
      if (contains(repos[left].path, repos[right].path) || contains(repos[right].path, repos[left].path)) {
        fail(`repositories ${repos[left].name} and ${repos[right].name} overlap (one path is inside the other).`);
      }
    }
  }

  return { defaultRepo: raw.default, repos, links: parseLinks(raw.links, names), fromFile: true };
}

/** `"repo:path"` for one end of a link, as the catalog file writes it. */
export function formatLinkEnd(end: LinkEnd): string {
  return `${end.repo}:${end.path}`;
}

function parseLinks(value: unknown, names: readonly string[]): CatalogLink[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail('"links" must be an array.');
  }
  const links: CatalogLink[] = [];
  const seen = new Map<string, number>();
  value.forEach((entry: unknown, index: number) => {
    const at = `links[${index}]`;
    if (!isRecord(entry)) {
      fail(`${at} must be an object with "from" and "to".`);
    }
    const from = parseLinkEnd(entry.from, `${at}.from`, names);
    const to = parseLinkEnd(entry.to, `${at}.to`, names);
    if (from.repo === to.repo) {
      fail(`${at} must connect two different repositories.`);
    }
    const kind = entry.kind ?? 'other';
    if (typeof kind !== 'string' || !(LINK_KINDS as readonly string[]).includes(kind)) {
      fail(`${at}.kind must be one of ${LINK_KINDS.join(', ')}.`);
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      fail(`${at}.note must be a string.`);
    }
    // A link and its reverse are the same contract.
    const key = [formatLinkEnd(from), formatLinkEnd(to)].sort().join('\n');
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      fail(`${at} repeats links[${earlier}].`);
    }
    seen.set(key, index);
    const note = typeof entry.note === 'string' ? entry.note.trim() : '';
    links.push({ from, to, kind: kind as LinkKind, ...(note ? { note } : {}) });
  });
  return links;
}

function parseLinkEnd(value: unknown, at: string, names: readonly string[]): LinkEnd {
  const separator = typeof value === 'string' ? value.indexOf(':') : -1;
  if (typeof value !== 'string' || separator <= 0) {
    fail(`${at} must be "<repo>:<path>".`);
  }
  const repo = value.slice(0, separator);
  const path = value.slice(separator + 1).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!names.includes(repo)) {
    fail(`${at} names unknown repository "${repo}".`);
  }
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) {
    fail(`${at} must name a file inside ${repo}, relative to its root.`);
  }
  if (isSecretPath(path)) {
    fail(`${at} names a secret file.`);
  }
  return { repo, path };
}

/**
 * Repository names with dependencies first, which is also the merge order. Ties keep catalog order.
 * Throws a CatalogError naming the cycle when dependsOn loops.
 */
export function dependencyOrder(repos: readonly CatalogRepo[]): string[] {
  const byName = new Map(repos.map((repo, index) => [repo.name, { repo, index }]));
  const done = new Set<string>();
  const visiting: string[] = [];
  const order: string[] = [];

  function visit(name: string): void {
    if (done.has(name)) {
      return;
    }
    const loop = visiting.indexOf(name);
    if (loop >= 0) {
      fail(`dependsOn has a cycle: ${[...visiting.slice(loop), name].join(' -> ')}.`);
    }
    const entry = byName.get(name);
    if (!entry) {
      return;
    }
    visiting.push(name);
    const dependencies = [...entry.repo.dependsOn]
      .sort((left, right) => (byName.get(left)?.index ?? 0) - (byName.get(right)?.index ?? 0));
    for (const dependency of dependencies) {
      visit(dependency);
    }
    visiting.pop();
    done.add(name);
    order.push(name);
  }

  for (const repo of repos) {
    visit(repo.name);
  }
  return order;
}

/** Names of catalog repositories whose path is not an existing directory. */
export async function findMissingRepos(catalog: Catalog): Promise<Set<string>> {
  const missing = new Set<string>();
  for (const repo of catalog.repos) {
    const isDirectory = await stat(repo.path).then((info) => info.isDirectory(), () => false);
    if (!isDirectory) {
      missing.add(repo.name);
    }
  }
  return missing;
}

/** The list_repositories text: a header, one aligned line per repository, and the merge order. */
export function formatCatalog(catalog: Catalog, missing: ReadonlySet<string>): string {
  const header = catalog.fromFile
    ? `Repositories from ${CATALOG_FILE}. Write target: ${catalog.defaultRepo}; the others are read-only.`
    : `No ${CATALOG_FILE}; the root is the only repository and the write target.`;
  const nameWidth = Math.max(...catalog.repos.map((repo) => repo.name.length));
  const paths = catalog.repos.map((repo) => repo.path.replaceAll('\\', '/'));
  const pathWidth = Math.max(...paths.map((path) => path.length));

  const lines = catalog.repos.map((repo, index) => {
    const access = repo.name === catalog.defaultRepo ? 'write' : 'read';
    const dependsOn = repo.dependsOn.length > 0 ? `(depends on: ${repo.dependsOn.join(', ')})` : '';
    const about = [repo.purpose, dependsOn].filter((part) => part).join(' ');
    const status = missing.has(repo.name) ? '[missing]' : '';
    return [repo.name.padEnd(nameWidth), access.padEnd(5), about ? paths[index].padEnd(pathWidth) : paths[index], about, status]
      .filter((part) => part)
      .join('  ')
      .trimEnd();
  });

  const order = catalog.repos.length > 1 ? [`Merge order: ${dependencyOrder(catalog.repos).join(', ')}`] : [];
  return [header, ...lines, ...order].join('\n');
}

/** A valid repository name from a folder name: other characters become `-`. */
export function repoNameFor(path: string): string {
  return basename(resolve(path)).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'root';
}

/**
 * Adds a local directory to the catalog. The path is stored relative to the root when it can be, so the
 * file stays portable. Without a catalog file, the root is written as the first repository and the default.
 */
export async function addRepo(root: string, name: string, directory: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    const fromRoot = relative(resolve(root), resolve(directory)).replaceAll('\\', '/');
    const path = fromRoot === '' ? '.' : isAbsolute(fromRoot) ? resolve(directory).replaceAll('\\', '/') : fromRoot;
    raw.repos.push({ name, path });
  });
}

/**
 * Removes a repository, every dependsOn entry that names it, and every file link that touches it.
 * The write target cannot be removed.
 */
export async function removeRepo(root: string, name: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    if (raw.default === name) {
      throw new CatalogError(`${name} is the write target. Make another repository the write target first.`);
    }
    if (!raw.repos.some((repo) => repo.name === name)) {
      throw new CatalogError(`No repository named "${name}".`);
    }
    raw.repos = raw.repos.filter((repo) => repo.name !== name);
    for (const repo of raw.repos) {
      if (Array.isArray(repo.dependsOn)) {
        repo.dependsOn = repo.dependsOn.filter((dependency) => dependency !== name);
      }
    }
    if (Array.isArray(raw.links)) {
      const touches = (end: unknown): boolean => typeof end === 'string' && end.startsWith(`${name}:`);
      raw.links = raw.links.filter((entry) => !(isRecord(entry) && (touches(entry.from) || touches(entry.to))));
    }
  });
}

export async function setDefaultRepo(root: string, name: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    raw.default = name;
  });
}

/** Records that `from` depends on `to`. A cycle or an unknown name is refused by validation. */
export async function addDependency(root: string, from: string, to: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    const repo = raw.repos.find((candidate) => candidate.name === from);
    if (!repo) {
      throw new CatalogError(`No repository named "${from}".`);
    }
    const current = Array.isArray(repo.dependsOn) ? repo.dependsOn : [];
    if (current.includes(to)) {
      throw new CatalogError(`${from} already depends on ${to}.`);
    }
    repo.dependsOn = [...current, to];
  });
}

export async function removeDependency(root: string, from: string, to: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    const repo = raw.repos.find((candidate) => candidate.name === from);
    if (!repo || !Array.isArray(repo.dependsOn) || !repo.dependsOn.includes(to)) {
      throw new CatalogError(`${from} does not depend on ${to}.`);
    }
    repo.dependsOn = repo.dependsOn.filter((dependency) => dependency !== to);
  });
}

/** Adds a file link. `from` and `to` are `"repo:path"`; validation checks both ends. */
export async function addLink(root: string, link: { from: string; to: string; kind?: string; note?: string }): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    const links = Array.isArray(raw.links) ? raw.links : [];
    raw.links = [...links, {
      from: link.from,
      to: link.to,
      kind: link.kind ?? 'other',
      ...(link.note?.trim() ? { note: link.note.trim() } : {})
    }];
  });
}

/** Removes the link between two files, written in either direction. */
export async function removeLink(root: string, from: string, to: string): Promise<Catalog> {
  return editCatalogFile(root, (raw) => {
    const links = Array.isArray(raw.links) ? raw.links : [];
    const same = (entry: unknown): boolean => isRecord(entry)
      && ((entry.from === from && entry.to === to) || (entry.from === to && entry.to === from));
    if (!links.some(same)) {
      throw new CatalogError(`No link between ${from} and ${to}.`);
    }
    raw.links = links.filter((entry) => !same(entry));
  });
}

interface RawRepo extends Record<string, unknown> {
  name: string;
  path: string;
  dependsOn?: unknown[];
}

interface RawCatalog extends Record<string, unknown> {
  default: string;
  repos: RawRepo[];
  links?: unknown[];
}

/**
 * Rewrites tokio.repos.json through `edit`, keeping paths and unknown fields as written. The result must
 * pass parseCatalog, so an edit can never leave an invalid file behind.
 */
async function editCatalogFile(root: string, edit: (raw: RawCatalog) => void): Promise<Catalog> {
  const file = join(root, CATALOG_FILE);
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  let raw: RawCatalog;
  if (text === undefined) {
    const name = repoNameFor(root);
    raw = { default: name, repos: [{ name, path: '.' }] };
  } else {
    // Validate first, so an edit never builds on a broken file.
    parseCatalog(text, root);
    raw = JSON.parse(text) as RawCatalog;
  }
  edit(raw);
  const next = `${JSON.stringify(raw, null, 2)}\n`;
  const catalog = parseCatalog(next, root);
  await writeFile(file, next, 'utf8');
  return catalog;
}

function implicitCatalog(root: string): Catalog {
  const name = repoNameFor(root);
  return { defaultRepo: name, repos: [{ name, path: resolve(root), dependsOn: [] }], links: [], fromFile: false };
}

/** True when child is parent itself or a path inside it. Lexical: symlinks are not followed. */
export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path));
}

function fail(message: string): never {
  throw new CatalogError(`Invalid ${CATALOG_FILE}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

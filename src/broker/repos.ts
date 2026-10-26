import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { linkPackageImports } from '../context/packages';
import { findRelevantFiles } from '../context/routing';
import { buildImportEdges, type RepoFile } from '../context/repomap';
import { loadCatalog, type Catalog, type CatalogRepo } from './catalog';
import { resolveRepoScope } from './policy';
import { scanRepository } from './scan';

/**
 * The catalog repositories one tool call covers. With one repository, paths stay repository-relative
 * and every output is unchanged. With more than one, Tokio keys each file as `<repo>/<path>` and shows
 * it to the agent as `[repo] path`. Repository names cannot contain a slash, so the first one splits them.
 */

export interface Selection {
  catalog: Catalog;
  /** Repositories this call covers, in catalog order. */
  repos: CatalogRepo[];
  /** Catalog repositories left out because their directory is missing. */
  skipped: string[];
  /** True when the catalog lists more than one repository, so every path carries its repository. */
  multi: boolean;
}

export interface SelectionScan {
  files: RepoFile[];
  coChange: Map<string, string[]>;
  /**
   * Import edges per repository plus package links across repositories. Only set with more than one
   * repository; with one, buildRepoMap reads the imports itself.
   */
  edges?: Map<string, string[]>;
  /** Repositories whose scan stopped at the file cap. */
  truncated: string[];
}

/** `repo: "*"` asks for every repository, turning off the automatic pick in repo_map. */
export const ALL_REPOS = '*';

/**
 * The named repository, or every repository when none is named or the name is `*`. Missing directories
 * are skipped unless named.
 */
export async function selectRepos(root: string, requested: string | undefined, signal?: AbortSignal): Promise<Selection> {
  const catalog = await loadCatalog(root, signal);
  const multi = catalog.repos.length > 1;
  const name = requested === ALL_REPOS ? undefined : requested;
  if (name !== undefined || !multi) {
    return { catalog, repos: [await existingRepo(catalog, name ?? catalog.defaultRepo)], skipped: [], multi };
  }
  const present = await Promise.all(catalog.repos.map((repo) => isDirectory(repo.path)));
  return {
    catalog,
    repos: catalog.repos.filter((_, index) => present[index]),
    skipped: catalog.repos.filter((_, index) => !present[index]).map((repo) => repo.name),
    multi
  };
}

/** The named repository, or the default when none is named. */
export async function selectRepo(
  root: string,
  name: string | undefined,
  signal?: AbortSignal
): Promise<{ catalog: Catalog; repo: CatalogRepo; multi: boolean }> {
  const catalog = await loadCatalog(root, signal);
  return { catalog, repo: await existingRepo(catalog, name ?? catalog.defaultRepo), multi: catalog.repos.length > 1 };
}

/** Scans the selected repositories in parallel, each with its own file cap. */
export async function scanSelection(
  selection: Selection,
  { signal, history = true, edges = true }: { signal?: AbortSignal; history?: boolean; edges?: boolean } = {}
): Promise<SelectionScan> {
  const scans = await Promise.all(selection.repos.map((repo) => scanRepository(repo.path, { signal, history, maxFiles: repo.maxFiles })));
  const truncated = selection.repos.filter((_, index) => scans[index].truncated).map((repo) => repo.name);
  if (!selection.multi) {
    const [scan] = scans;
    return { files: scan?.files ?? [], coChange: scan?.coChange ?? new Map(), truncated };
  }

  const files: RepoFile[] = [];
  const coChange = new Map<string, string[]>();
  const importEdges = new Map<string, string[]>();
  selection.repos.forEach((repo, index) => {
    const scan = scans[index];
    const prefix = (path: string): string => `${repo.name}/${path}`;
    files.push(...scan.files.map((file) => ({ path: prefix(file.path), content: file.content })));
    for (const [path, partners] of scan.coChange) {
      coChange.set(prefix(path), partners.map(prefix));
    }
    if (edges) {
      const known = new Set(scan.files.map((file) => file.path));
      for (const [path, targets] of buildImportEdges(scan.files, known)) {
        importEdges.set(prefix(path), targets.map(prefix));
      }
    }
  });
  if (!edges) {
    return { files, coChange, truncated };
  }

  const goModules = await Promise.all(selection.repos.map((repo) => readGoModule(repo.path, signal)));
  const links = linkPackageImports(selection.repos.map((repo, index) => ({
    name: repo.name,
    files: scans[index].files,
    ...(goModules[index] ? { goModule: goModules[index] } : {})
  })));
  const addEdge = (path: string, target: string): void => {
    importEdges.set(path, [...new Set([...(importEdges.get(path) ?? []), target])]);
  };
  for (const [path, targets] of links) {
    targets.forEach((target) => addEdge(path, target));
  }
  // Declared file links are contracts both ways, so each side ranks the other. Ends outside the scan are skipped.
  const known = new Set(files.map((file) => file.path));
  for (const link of selection.catalog.links) {
    const from = `${link.from.repo}/${link.from.path}`;
    const to = `${link.to.repo}/${link.to.path}`;
    if (known.has(from) && known.has(to)) {
      addEdge(from, to);
      addEdge(to, from);
    }
  }
  return { files, coChange, edges: importEdges, truncated };
}

/** A file pair across two repositories, found from imports of a published package. */
export interface DetectedLink {
  from: { repo: string; path: string };
  to: { repo: string; path: string };
}

const MAX_DETECTED_LINKS = 300;

/**
 * Cross-repository file pairs that imports reveal, for the repository map. Scans every existing catalog
 * repository without git history. Capped, because the map shows them grouped per repository pair.
 */
export async function detectCrossRepoLinks(root: string, signal?: AbortSignal): Promise<DetectedLink[]> {
  const selection = await selectRepos(root, ALL_REPOS, signal);
  if (!selection.multi) {
    return [];
  }
  const scans = await Promise.all(selection.repos.map((repo) => scanRepository(repo.path, { signal, history: false, maxFiles: repo.maxFiles })));
  const goModules = await Promise.all(selection.repos.map((repo) => readGoModule(repo.path, signal)));
  const links = linkPackageImports(selection.repos.map((repo, index) => ({
    name: repo.name,
    files: scans[index].files,
    ...(goModules[index] ? { goModule: goModules[index] } : {})
  })));
  const split = (key: string): { repo: string; path: string } => ({ repo: repoOf(key), path: key.slice(key.indexOf('/') + 1) });
  const detected: DetectedLink[] = [];
  for (const [from, targets] of links) {
    for (const to of targets) {
      if (detected.length >= MAX_DETECTED_LINKS) {
        return detected;
      }
      detected.push({ from: split(from), to: split(to) });
    }
  }
  return detected;
}

/**
 * A path or scope inside the named repository, or the default one, keyed as the selection keys files.
 * Blocks paths outside that repository.
 */
export function scopeIn(selection: Selection, name: string | undefined, requested: string): string {
  const repoName = name === undefined || name === ALL_REPOS ? selection.catalog.defaultRepo : name;
  const repo = selection.catalog.repos.find((candidate) => candidate.name === repoName);
  const scope = resolveRepoScope(repo?.path ?? '', requested);
  if (!selection.multi) {
    return scope;
  }
  return scope === '' ? repoName : `${repoName}/${scope}`;
}

/**
 * The repositories a task is about, for a map the agent did not scope: the ones the task names, else the
 * ones with relevant files; then the write target, each pick's direct dependencies, and the repositories
 * its declared file links reach, so shared contracts still rank. Undefined when nothing matched or the
 * pick covers every scanned repository.
 */
export function pickReposForTask(selection: Selection, files: readonly RepoFile[], task: string): string[] | undefined {
  const { catalog } = selection;
  const scanned = selection.repos.map((repo) => repo.name);
  const named = scanned.filter((name) => mentions(task, name));
  const matched = named.length > 0 ? named : [...new Set(findRelevantFiles(files, task).map(repoOf))];
  if (matched.length === 0) {
    return undefined;
  }

  const picked = new Set([...matched, catalog.defaultRepo]);
  for (const repo of catalog.repos) {
    if (matched.includes(repo.name)) {
      repo.dependsOn.forEach((dependency) => picked.add(dependency));
    }
  }
  // A declared file link is a contract, so the repository on its other end comes along too.
  for (const link of catalog.links) {
    if (matched.includes(link.from.repo)) {
      picked.add(link.to.repo);
    }
    if (matched.includes(link.to.repo)) {
      picked.add(link.from.repo);
    }
  }
  const result = scanned.filter((name) => picked.has(name));
  return result.length < scanned.length ? result : undefined;
}

/** Keeps only the files, co-change links, and import edges inside the given repositories. */
export function narrowScan(scan: SelectionScan, names: readonly string[]): SelectionScan {
  const keep = new Set(names);
  const inside = (path: string): boolean => keep.has(repoOf(path));
  const narrowMap = (links: ReadonlyMap<string, string[]>): Map<string, string[]> => new Map([...links]
    .filter(([path]) => inside(path))
    .map(([path, targets]) => [path, targets.filter(inside)]));
  return {
    files: scan.files.filter((file) => inside(file.path)),
    coChange: narrowMap(scan.coChange),
    ...(scan.edges ? { edges: narrowMap(scan.edges) } : {}),
    truncated: scan.truncated.filter((name) => keep.has(name))
  };
}

/** True when the task names the repository as a whole word, ignoring case. */
function mentions(task: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, 'i').test(task);
}

/** `[repo] path` for a key with a repository prefix, else the path as is. */
export function displayPath(multi: boolean, path: string): string {
  if (!multi) {
    return path;
  }
  const slash = path.indexOf('/');
  return slash < 0 ? `[${path}]` : `[${path.slice(0, slash)}] ${path.slice(slash + 1)}`;
}

/** The repository name of a key with a repository prefix. */
export function repoOf(path: string): string {
  const slash = path.indexOf('/');
  return slash < 0 ? path : path.slice(0, slash);
}

/** The repositories behind a list of keys, in first-seen order. Empty with one repository. */
export function reposOf(multi: boolean, paths: readonly string[]): string[] {
  return multi ? [...new Set(paths.map(repoOf))] : [];
}

/** Why a map or search over several repositories may be incomplete. Empty with one repository. */
export function scanNotes(selection: Selection, scan: SelectionScan, fileCap: number): string[] {
  if (!selection.multi) {
    return scan.truncated.length > 0 ? [`scan stopped at ${scan.files.length} files`] : [];
  }
  return [
    scan.truncated.length > 0
      ? `scan stopped at the file cap in ${scan.truncated.join(', ')} (default ${fileCap}; raise maxFiles in tokio.repos.json)`
      : undefined,
    selection.skipped.length > 0 ? `skipped missing ${selection.skipped.join(', ')}` : undefined
  ].filter((note): note is string => note !== undefined);
}

/**
 * The route_task lines for several repositories: the write target, the read-only repositories with
 * relevant files, and a warning when most relevant files are outside the write target.
 */
export function formatRepoRoute(catalog: Catalog, relevantFiles: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const path of relevantFiles) {
    counts.set(repoOf(path), (counts.get(repoOf(path)) ?? 0) + 1);
  }
  const reads = catalog.repos
    .filter((repo) => repo.name !== catalog.defaultRepo && (counts.get(repo.name) ?? 0) > 0)
    .map((repo) => repo.name);
  const lines = [`Repositories: write ${catalog.defaultRepo}; read ${reads.join(', ') || 'none'}`];

  const top = [...reads].sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0))[0];
  if (top !== undefined && (counts.get(top) ?? 0) > (counts.get(catalog.defaultRepo) ?? 0)) {
    lines.push(`Most relevant files are in ${top}, which is read-only. Ask the user before editing it.`);
  }
  return lines.join('\n');
}

async function existingRepo(catalog: Catalog, name: string): Promise<CatalogRepo> {
  const repo = catalog.repos.find((candidate) => candidate.name === name);
  if (!repo) {
    throw new Error(`Unknown repository "${name}". Repositories: ${catalog.repos.map((candidate) => candidate.name).join(', ')}.`);
  }
  if (!(await isDirectory(repo.path))) {
    throw new Error(`Repository "${name}" is missing: ${repo.path.replaceAll('\\', '/')} is not a directory.`);
  }
  return repo;
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

async function readGoModule(root: string, signal?: AbortSignal): Promise<string | undefined> {
  const text = await readFile(join(root, 'go.mod'), { encoding: 'utf8', signal }).catch(() => undefined);
  return text === undefined ? undefined : /^module\s+(\S+)/m.exec(text)?.[1];
}

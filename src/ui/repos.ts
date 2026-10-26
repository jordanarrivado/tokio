import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { ACTIVITY_FILE, isActivityEntry, type ActivityAction } from '../broker/activity';
import { AUDIT_DIRECTORY, AUDIT_FILE } from '../broker/audit';
import {
  addDependency,
  addLink,
  addRepo,
  dependencyOrder,
  findMissingRepos,
  formatLinkEnd,
  loadCatalog,
  removeDependency,
  removeLink,
  removeRepo,
  repoNameFor,
  setDefaultRepo,
  type Catalog,
  type LinkKind
} from '../broker/catalog';
import { detectCrossRepoLinks } from '../broker/repos';
import { clearScope, grantScope, readGrants, revokeScope } from '../broker/scope';
import { isStoredEntry } from '../broker/stats';

/**
 * The panel's and the repository map's view of tokio.repos.json, the write scope, and the map layout.
 * It has no VS Code dependency: the caller passes in the workspace root and the pickers, so the logic is
 * testable on its own.
 */

/** Node positions on the repository map. Per user, so it lives in .tokio, which is git-ignored. */
export const LAYOUT_FILE = '.tokio/layout.json';
const MAX_COORDINATE = 20_000;

export interface RepoRow {
  name: string;
  /** Absolute path with forward slashes. */
  path: string;
  purpose?: string;
  dependsOn: string[];
  /** write: the default repository. granted: writable until grantedUntil. read: read-only. */
  access: 'write' | 'granted' | 'read';
  grantedUntil?: string;
  missing: boolean;
}

/** A declared file link, with ends written as `"repo:path"`. */
export interface MapLink {
  from: string;
  to: string;
  kind: LinkKind;
  note?: string;
}

export interface RepoCatalogView {
  fromFile: boolean;
  defaultRepo: string;
  repos: RepoRow[];
  mergeOrder: string[];
  links: MapLink[];
}

export type MapPosition = { x: number; y: number };

export const LINE_SHAPES = ['curved', 'straight', 'step'] as const;
export const LINE_STYLES = ['solid', 'dashed', 'dotted', 'longdash'] as const;
export type LineShape = typeof LINE_SHAPES[number];
export type LineStyle = typeof LINE_STYLES[number];

/** How the map draws connectors, saved per user with the layout. */
export interface MapSettings {
  shape: LineShape;
  styles: { dependency: LineStyle; link: LineStyle; detected: LineStyle };
  snap: boolean;
}

export const DEFAULT_MAP_SETTINGS: MapSettings = {
  shape: 'curved',
  styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' },
  snap: false
};

/** Everything the repository map draws: the catalog, detected file pairs, saved node positions, and view settings. */
export interface RepoGraph extends RepoCatalogView {
  detected: { from: string; to: string }[];
  layout: Record<string, MapPosition>;
  settings: MapSettings;
}

/** A tool call within this long counts as an agent working in the repository right now. */
export const WORKING_MS = 15_000;
/** After that, the repository shows as recently used for this long. */
export const RECENT_MS = 120_000;
/** Only the end of the audit log is read; the log grows for the life of the workspace. */
const AUDIT_TAIL_BYTES = 64 * 1024;

/** What an agent last did in one repository, from the audit and activity logs. Idle repositories are left out. */
export interface RepoActivity {
  repo: string;
  /** working: a call touched it just now. blocked: the hook just refused a call there. recent: used a little earlier. */
  state: 'working' | 'blocked' | 'recent';
  action: ActivityAction;
  tool: string;
  /** File name of the last call, when it named one. */
  file?: string;
  /** Milliseconds since that call. */
  ageMs: number;
}

export interface RepoCatalogService {
  list(): Promise<RepoCatalogView>;
  activity(): Promise<RepoActivity[]>;
  grant(name: string, hours: number): Promise<RepoCatalogView>;
  revoke(name: string): Promise<RepoCatalogView>;
  clearGrants(): Promise<RepoCatalogView>;
  setDefault(name: string): Promise<RepoCatalogView>;
  /** Undefined when the user cancels the folder picker. */
  add(): Promise<RepoCatalogView | undefined>;
  /** Undefined when the user cancels the confirmation. */
  remove(name: string): Promise<RepoCatalogView | undefined>;
  graph(): Promise<RepoGraph>;
  addDependency(from: string, to: string): Promise<RepoCatalogView>;
  removeDependency(from: string, to: string): Promise<RepoCatalogView>;
  addLink(link: MapLink): Promise<RepoCatalogView>;
  removeLink(from: string, to: string): Promise<RepoCatalogView>;
  saveLayout(positions: Record<string, MapPosition>, settings?: MapSettings): Promise<void>;
  /** A repository-relative path, or undefined when the user cancels. */
  pickFile(repo: string): Promise<string | undefined>;
  openMap(): void;
}

export interface RepoPrompts {
  /** The workspace root. Throws when there is none or it is not trusted. */
  root(): string;
  pickFolder(): Promise<string | undefined>;
  /** An absolute file path picked inside `directory`, or undefined when cancelled. */
  pickFile?(directory: string): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  openMap?(): void;
}

export function createRepoCatalogService(prompts: RepoPrompts): RepoCatalogService {
  const view = async (): Promise<RepoCatalogView> => describeCatalog(prompts.root());
  return {
    list: view,
    activity: () => readRepoActivity(prompts.root()),
    async grant(name, hours) {
      await grantScope(prompts.root(), [name], hours);
      return view();
    },
    async revoke(name) {
      await revokeScope(prompts.root(), name);
      return view();
    },
    async clearGrants() {
      await clearScope(prompts.root());
      return view();
    },
    async setDefault(name) {
      await setDefaultRepo(prompts.root(), name);
      // The write target needs no grant. The old one becomes read-only, because it has none.
      await revokeScope(prompts.root(), name);
      return view();
    },
    async add() {
      const folder = await prompts.pickFolder();
      if (folder === undefined) {
        return undefined;
      }
      const root = prompts.root();
      const taken = new Set((await loadCatalog(root)).repos.map((repo) => repo.name.toLowerCase()));
      await addRepo(root, uniqueName(repoNameFor(folder), taken), folder);
      return view();
    },
    async remove(name) {
      if (!(await prompts.confirm(`Remove ${name} from tokio.repos.json? Its files are not touched.`))) {
        return undefined;
      }
      await removeRepo(prompts.root(), name);
      await revokeScope(prompts.root(), name);
      return view();
    },
    async graph() {
      const root = prompts.root();
      const [catalogView, detected, layout, settings] = await Promise.all([
        describeCatalog(root),
        detectCrossRepoLinks(root),
        readLayout(root),
        readMapSettings(root)
      ]);
      return {
        ...catalogView,
        detected: detected.map((link) => ({ from: formatLinkEnd(link.from), to: formatLinkEnd(link.to) })),
        layout,
        settings
      };
    },
    async addDependency(from, to) {
      await addDependency(prompts.root(), from, to);
      return view();
    },
    async removeDependency(from, to) {
      await removeDependency(prompts.root(), from, to);
      return view();
    },
    async addLink(link) {
      await addLink(prompts.root(), link);
      return view();
    },
    async removeLink(from, to) {
      await removeLink(prompts.root(), from, to);
      return view();
    },
    async saveLayout(positions, settings) {
      const root = prompts.root();
      const names = new Set((await loadCatalog(root)).repos.map((repo) => repo.name));
      // Settings are kept when a save only moves nodes.
      const keep = settings ?? await readMapSettings(root);
      await writeLayout(root, Object.fromEntries(Object.entries(positions).filter(([name]) => names.has(name))), keep);
    },
    async pickFile(repoName) {
      const catalog = await loadCatalog(prompts.root());
      const repo = catalog.repos.find((candidate) => candidate.name === repoName);
      if (!repo) {
        throw new Error(`Unknown repository "${repoName}".`);
      }
      const picked = await prompts.pickFile?.(repo.path);
      if (picked === undefined) {
        return undefined;
      }
      const inside = relative(repo.path, picked).replaceAll('\\', '/');
      if (inside === '' || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
        throw new Error(`Pick a file inside ${repoName}.`);
      }
      return inside;
    },
    openMap() {
      prompts.openMap?.();
    }
  };
}

export async function describeCatalog(root: string, now = new Date()): Promise<RepoCatalogView> {
  const catalog: Catalog = await loadCatalog(root);
  const missing = await findMissingRepos(catalog);
  const grants = await readGrants(root, now);
  return {
    fromFile: catalog.fromFile,
    defaultRepo: catalog.defaultRepo,
    mergeOrder: catalog.repos.length > 1 ? dependencyOrder(catalog.repos) : [],
    repos: catalog.repos.map((repo): RepoRow => {
      const grant = grants.find((candidate) => candidate.repo === repo.name);
      const access = repo.name === catalog.defaultRepo ? 'write' : grant ? 'granted' : 'read';
      return {
        name: repo.name,
        path: repo.path.replaceAll('\\', '/'),
        ...(repo.purpose ? { purpose: repo.purpose } : {}),
        dependsOn: repo.dependsOn,
        access,
        ...(access === 'granted' && grant ? { grantedUntil: grant.expiresAt } : {}),
        missing: missing.has(repo.name)
      };
    }),
    links: catalog.links.map((link) => ({
      from: formatLinkEnd(link.from),
      to: formatLinkEnd(link.to),
      kind: link.kind,
      ...(link.note ? { note: link.note } : {})
    }))
  };
}

/**
 * The latest call per repository in the last RECENT_MS, from two logs: the audit log, with Tokio's own
 * tools and the hook's blocks, and the activity log, with the built-in tools the hook let through.
 * An audit entry names its repositories when the catalog lists more than one; otherwise one that
 * returned files was in the default repository.
 */
export async function readRepoActivity(root: string, now = new Date()): Promise<RepoActivity[]> {
  const catalog = await loadCatalog(root);
  const names = new Set(catalog.repos.map((repo) => repo.name));
  const calls: { at: number; repo: string; tool: string; action: ActivityAction; blocked: boolean; file?: string }[] = [];

  for (const line of await readTailLines(join(root, AUDIT_DIRECTORY, AUDIT_FILE), AUDIT_TAIL_BYTES)) {
    const entry = parseLine(line);
    if (!isStoredEntry(entry)) {
      continue;
    }
    const files = Array.isArray(entry.files) ? entry.files : [];
    const repos = Array.isArray(entry.repos) ? entry.repos : files.length > 0 ? [catalog.defaultRepo] : [];
    const at = Date.parse(entry.timestamp);
    repos.forEach((repo) => calls.push({ at, repo, tool: entry.tool, action: 'reading', blocked: entry.blocked === true }));
  }
  for (const line of await readTailLines(join(root, AUDIT_DIRECTORY, ACTIVITY_FILE), AUDIT_TAIL_BYTES)) {
    const entry = parseLine(line);
    if (isActivityEntry(entry)) {
      calls.push({
        at: Date.parse(entry.timestamp),
        repo: entry.repo,
        tool: entry.tool,
        action: entry.action,
        blocked: false,
        ...(typeof entry.file === 'string' ? { file: entry.file } : {})
      });
    }
  }

  const latest = new Map<string, RepoActivity>();
  // Oldest first, so a later call replaces an earlier one.
  calls.sort((left, right) => left.at - right.at).forEach((call) => {
    const ageMs = now.getTime() - call.at;
    // NaN fails both bounds. A little clock skew between processes still counts as now.
    if (!names.has(call.repo) || !(ageMs >= -5_000 && ageMs <= RECENT_MS)) {
      return;
    }
    latest.set(call.repo, {
      repo: call.repo,
      state: ageMs > WORKING_MS ? 'recent' : call.blocked ? 'blocked' : 'working',
      action: call.action,
      tool: call.tool,
      ...(call.file ? { file: call.file } : {}),
      ageMs: Math.max(0, ageMs)
    });
  });
  return [...latest.values()];
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // A partial or damaged line must not hide the rest of the log.
    return undefined;
  }
}

/** The complete lines in the last `bytes` of a file; none when it does not exist. */
async function readTailLines(file: string, bytes: number): Promise<string[]> {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // A read that starts mid-file starts mid-line.
    return (start > 0 ? lines.slice(1) : lines).filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

/** Saved node positions. A missing or damaged file means no saved layout, so the map lays nodes out itself. */
export async function readLayout(root: string): Promise<Record<string, MapPosition>> {
  const text = await readFile(join(root, LAYOUT_FILE), 'utf8').catch(() => undefined);
  if (text === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const positions = typeof parsed === 'object' && parsed !== null ? (parsed as { positions?: unknown }).positions : undefined;
    if (typeof positions !== 'object' || positions === null) {
      return {};
    }
    return Object.fromEntries(Object.entries(positions as Record<string, unknown>)
      .map(([name, value]) => [name, toPosition(value)] as const)
      .filter((entry): entry is readonly [string, MapPosition] => entry[1] !== undefined));
  } catch {
    return {};
  }
}

/** Saved connector settings. Anything missing or unknown falls back to the default. */
export async function readMapSettings(root: string): Promise<MapSettings> {
  const text = await readFile(join(root, LAYOUT_FILE), 'utf8').catch(() => undefined);
  try {
    return toSettings(text === undefined ? undefined : (JSON.parse(text) as { settings?: unknown }).settings);
  } catch {
    return toSettings(undefined);
  }
}

async function writeLayout(root: string, positions: Record<string, MapPosition>, settings: MapSettings): Promise<void> {
  const clean = Object.fromEntries(Object.entries(positions)
    .map(([name, value]) => [name, toPosition(value)] as const)
    .filter((entry): entry is readonly [string, MapPosition] => entry[1] !== undefined));
  await mkdir(dirname(join(root, LAYOUT_FILE)), { recursive: true });
  const content = { version: 1, positions: clean, settings: toSettings(settings) };
  await writeFile(join(root, LAYOUT_FILE), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
}

function toSettings(value: unknown): MapSettings {
  const raw = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const styles = typeof raw.styles === 'object' && raw.styles !== null ? raw.styles as Record<string, unknown> : {};
  const style = (key: keyof MapSettings['styles']): LineStyle => (
    (LINE_STYLES as readonly unknown[]).includes(styles[key]) ? styles[key] as LineStyle : DEFAULT_MAP_SETTINGS.styles[key]
  );
  return {
    shape: (LINE_SHAPES as readonly unknown[]).includes(raw.shape) ? raw.shape as LineShape : DEFAULT_MAP_SETTINGS.shape,
    styles: { dependency: style('dependency'), link: style('link'), detected: style('detected') },
    snap: raw.snap === true
  };
}

/** A position with finite coordinates, rounded and kept on the board; otherwise undefined. */
function toPosition(value: unknown): MapPosition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  const clamp = (coordinate: number): number => Math.round(Math.min(Math.max(coordinate, 0), MAX_COORDINATE));
  return { x: clamp(x), y: clamp(y) };
}

/** `name`, or `name-2`, `name-3`, ... when the catalog already uses it, ignoring case. */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  let candidate = name;
  for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) {
    candidate = `${name.slice(0, 60)}-${suffix}`;
  }
  return candidate;
}

import * as vscode from 'vscode';

import type { ContextPreview, ContextScope } from '../core/types';
import {
  countTermHits,
  extractPathReferences,
  extractRelativeImports,
  extractSearchTerms,
  findRelatedTests,
  isSafeTextPath,
  isSecretPath,
  rankContextPaths,
  resolveMentionedPaths,
  type RankSignals
} from './discovery';
import { detectConventionFiles, detectValidationCommands } from './project';
import { checkMap, formatAnchor, MAP_PATH, MAP_TEMPLATE, mapPaths, parseArchitectureMap, rankMapAreas, resolveMapAnchors, type MapArea, type MapFile } from './archmap';

const MAX_DISCOVERED_FILES = 500;
const MAX_READ_BYTES = 32_000;
const MAX_CONTENT_SCAN_FILES = 150;
const CONTENT_SCAN_BATCH = 20;
const MAX_ARCHITECTURE_CHARS = 1200;
const MAX_MAP_BYTES = 128_000;
/** Routed files are only searched for line numbers, never sent whole, so they may be larger than scanned files. */
const MAX_ROUTED_FILE_BYTES = 512_000;
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.next,vendor}/**';
const ARCHITECTURE_PATH = '.tokio/architecture.md';
const LEGACY_ARCHITECTURE_PATH = '.token-saver/architecture.md';

export interface ContextScanInput {
  rawPrompt: string;
  targetPath: string;
  scope: Exclude<ContextScope, 'none'>;
}

export class WorkspaceContextService {
  public routeMap(input: { rawPrompt: string }): Promise<{ areas: string[]; routes: string[]; stale: string[] } | undefined> {
    return routeArchitectureMap(input.rawPrompt);
  }

  public mapStatus(): Promise<MapStatus> {
    return architectureMapStatus();
  }

  public async scan(input: ContextScanInput): Promise<ContextPreview> {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before scanning repository context.');
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('Open a workspace folder before scanning repository context.');
    }

    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_DISCOVERED_FILES);
    const entries = uris
      .map((uri) => ({ uri, path: toWorkspacePath(uri) }))
      .filter((entry): entry is { uri: vscode.Uri; path: string } => (
        entry.path !== undefined && isSafeTextPath(entry.path)
      ));
    const notices: string[] = [];
    const inspectedFiles: string[] = [];
    let relativeImports: string[] = [];

    const targetEntry = await resolveTargetEntry(input.targetPath, folders);
    if (input.targetPath.trim() && !targetEntry) {
      notices.push('The provided target path was not found in the open workspace.');
    }

    if (targetEntry) {
      const source = await readSmallTextFile(targetEntry.uri);
      if (source === undefined) {
        notices.push('The target file was too large or could not be read; only its path was used.');
      } else {
        inspectedFiles.push(targetEntry.path);
        relativeImports = extractRelativeImports(source);
      }
    }

    const candidates = entries.filter((entry) => (
      entry.path !== ARCHITECTURE_PATH && entry.path !== LEGACY_ARCHITECTURE_PATH
    ));
    const known = new Set(candidates.map((entry) => entry.path));
    const allPaths = new Set(uris.flatMap((uri) => toWorkspacePath(uri) ?? []));
    const mentionedPaths = resolveMentionedPaths(extractPathReferences(input.rawPrompt), known);
    const changedPaths = await collectChangedPaths(known);
    const openPaths = collectOpenPaths(known);
    const contentHits = await collectContentHits(
      candidates,
      extractSearchTerms(input.rawPrompt),
      new Set([...changedPaths, ...openPaths])
    );
    const signals: RankSignals = { changedPaths, openPaths, contentHits, mentionedPaths };
    const signalSummary = [
      changedPaths.size > 0 ? `${changedPaths.size} changed file(s)` : undefined,
      openPaths.size > 0 ? `${openPaths.size} open tab(s)` : undefined,
      contentHits.size > 0 ? `${contentHits.size} content match(es)` : undefined,
      mentionedPaths.size > 0 ? `${mentionedPaths.size} path(s) named in the prompt` : undefined
    ].filter(Boolean);
    if (signalSummary.length > 0) {
      notices.push(`Ranking also considered ${signalSummary.join(', ')}.`);
    }

    const ranked = rankContextPaths([
      ...(targetEntry ? [targetEntry.path] : []),
      ...candidates.map((entry) => entry.path)
    ], input.rawPrompt, targetEntry?.path, relativeImports, signals);
    if (ranked.length === 0) {
      notices.push('No likely files were found from the task terms; provide a target path for better results.');
    }

    const relatedTests = findRelatedTests(
      [...(targetEntry ? [targetEntry.path] : []), ...ranked],
      [...allPaths]
    ).filter((path) => !ranked.includes(path));

    const rootPaths = new Set([...allPaths].filter((path) => (
      !path.includes('/') || path === '.github/copilot-instructions.md'
    )));
    const conventionFiles = detectConventionFiles(rootPaths);
    const packageJsonEntry = rootPaths.has('package.json')
      ? await resolveTargetEntry('package.json', folders)
      : undefined;
    const validationCommands = detectValidationCommands({
      packageJson: packageJsonEntry ? await readSmallTextFile(packageJsonEntry.uri) : undefined,
      rootPaths
    });

    let architectureNotes: string | undefined;
    if (input.scope === 'architecture') {
      const architectureEntry = await resolveTargetEntry(ARCHITECTURE_PATH, folders)
        ?? await resolveTargetEntry(LEGACY_ARCHITECTURE_PATH, folders);
      if (!architectureEntry) {
        notices.push(`No ${ARCHITECTURE_PATH} profile was found.`);
      } else {
        const architecture = await readSmallTextFile(architectureEntry.uri);
        if (architecture === undefined) {
          notices.push('The architecture profile was too large or could not be read.');
        } else {
          architectureNotes = architecture.trim().slice(0, MAX_ARCHITECTURE_CHARS);
          inspectedFiles.push(architectureEntry.path);
          if (architectureEntry.path === LEGACY_ARCHITECTURE_PATH) {
            notices.push(`Using legacy ${LEGACY_ARCHITECTURE_PATH}; rename it to ${ARCHITECTURE_PATH}.`);
          }
          if (architecture.trim().length > MAX_ARCHITECTURE_CHARS) {
            notices.push(`Architecture profile was capped at ${MAX_ARCHITECTURE_CHARS} characters.`);
          }
        }
      }
    }

    if (uris.length === MAX_DISCOVERED_FILES) {
      notices.push(`Repository discovery was capped at ${MAX_DISCOVERED_FILES} files.`);
    }

    return {
      scope: input.scope,
      files: ranked,
      architectureNotes,
      relatedTests,
      conventionFiles,
      validationCommands,
      notices,
      inspectedFiles: [...new Set(inspectedFiles)]
    };
  }
}

export interface MapStatus {
  path: string;
  exists: boolean;
  areas: number;
  routes: number;
  /** Entries whose file or symbol no longer exists. */
  stale: string[];
  /** Set when the map exists but cannot be used. */
  error?: string;
}

interface WorkspaceMap {
  folder: vscode.WorkspaceFolder;
  path: string;
  areas: MapArea[];
}

/**
 * The workspace's architecture map, from the first folder that has one. Undefined when no folder has a map;
 * an error when one exists but cannot be read.
 */
async function loadWorkspaceMap(): Promise<WorkspaceMap | undefined> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace to use its architecture map.');
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const entry = await resolveTargetEntry(MAP_PATH, folders);
  const folder = entry && vscode.workspace.getWorkspaceFolder(entry.uri);
  if (!entry || !folder) {
    return undefined;
  }
  const text = await readSmallTextFile(entry.uri, MAX_MAP_BYTES);
  if (text === undefined) {
    throw new Error(`${MAP_PATH} is larger than ${MAX_MAP_BYTES / 1000} KB or could not be read.`);
  }
  return { folder, path: entry.path, areas: parseArchitectureMap(text) };
}

/** Reads the files a map names, relative to the folder that holds the map. Missing files are left out. */
async function loadMappedFiles(paths: readonly string[], folder: vscode.WorkspaceFolder): Promise<Map<string, MapFile>> {
  const loaded = new Map<string, MapFile>();
  await Promise.all(paths.map(async (path) => {
    const entry = await resolveTargetEntry(path, [folder]);
    const content = entry ? await readSmallTextFile(entry.uri, MAX_ROUTED_FILE_BYTES) : undefined;
    if (entry && content !== undefined) {
      loaded.set(path, { path: entry.path, content });
    }
  }));
  return loaded;
}

/** Map paths that name a folder in the workspace folder, so they are listed as folders instead of reported stale. */
async function findMappedFolders(paths: readonly string[], folder: vscode.WorkspaceFolder): Promise<Set<string>> {
  const folders = new Set<string>();
  await Promise.all(paths.map(async (path) => {
    if (!path || path.startsWith('/') || path.includes(':') || path.split('/').includes('..') || isSecretPath(path)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ...path.split('/')));
      if (stat.type === vscode.FileType.Directory) {
        folders.add(path);
      }
    } catch {
      // Missing: reported as stale.
    }
  }));
  return folders;
}

/**
 * Routes a task through the workspace's architecture map. Only the map and the files its best areas name
 * are read, so this stays cheap however large the workspace is. Undefined when there is no usable map.
 */
export async function routeArchitectureMap(rawPrompt: string): Promise<{ areas: string[]; routes: string[]; stale: string[] } | undefined> {
  const map = await loadWorkspaceMap();
  if (!map || map.areas.length === 0) {
    return undefined;
  }
  const ranked = rankMapAreas(map.areas, rawPrompt);
  const paths = mapPaths(ranked);
  const loaded = await loadMappedFiles(paths, map.folder);
  const folders = await findMappedFolders(paths.filter((path) => !loaded.has(path)), map.folder);
  const routing = resolveMapAnchors(ranked, (path) => loaded.get(path), rawPrompt, (path) => folders.has(path));
  return { areas: routing.areas, routes: routing.anchors.map((anchor) => formatAnchor(anchor)), stale: routing.stale };
}

/** Checks every entry in the workspace's map, for the panel's status line. Never throws. */
export async function architectureMapStatus(): Promise<MapStatus> {
  const empty = { path: MAP_PATH, exists: false, areas: 0, routes: 0, stale: [] };
  try {
    const map = await loadWorkspaceMap();
    if (!map) {
      return empty;
    }
    if (map.areas.length === 0) {
      return { ...empty, path: map.path, exists: true, error: 'No areas yet. Add "## Area" headings with "- label -> path#symbol" lines.' };
    }
    const all = map.areas.map((area) => ({ area, score: 0 }));
    const paths = mapPaths(all);
    const loaded = await loadMappedFiles(paths, map.folder);
    const folders = await findMappedFolders(paths.filter((path) => !loaded.has(path)), map.folder);
    return { path: map.path, exists: true, ...checkMap(map.areas, (path) => loaded.get(path), (path) => folders.has(path)) };
  } catch (error: unknown) {
    return { ...empty, error: error instanceof Error ? error.message : 'The architecture map could not be read.' };
  }
}

/**
 * Opens the workspace's architecture map, creating it from a template in the first folder when there is none.
 * Returns the map's workspace-relative path.
 */
export async function openArchitectureMap(): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace to create an architecture map.');
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const existing = await resolveTargetEntry(MAP_PATH, folders);
  let uri = existing?.uri;
  if (!uri) {
    const folder = folders[0];
    if (!folder) {
      throw new Error('Open a workspace folder first.');
    }
    uri = vscode.Uri.joinPath(folder.uri, ...MAP_PATH.split('/'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(MAP_TEMPLATE));
  }
  await vscode.window.showTextDocument(uri, { preview: false });
  return existing?.path ?? MAP_PATH;
}

interface GitApi {
  repositories: ReadonlyArray<{
    state: {
      workingTreeChanges: ReadonlyArray<{ uri: vscode.Uri }>;
      indexChanges: ReadonlyArray<{ uri: vscode.Uri }>;
    };
  }>;
}

/** Files with uncommitted changes, via the built-in Git extension. Empty if Git is unavailable. */
async function collectChangedPaths(known: ReadonlySet<string>): Promise<Set<string>> {
  const changed = new Set<string>();
  try {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) {
      return changed;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    for (const repository of exports.getAPI(1).repositories) {
      for (const change of [...repository.state.workingTreeChanges, ...repository.state.indexChanges]) {
        const path = toWorkspacePath(change.uri);
        if (path !== undefined && known.has(path)) {
          changed.add(path);
        }
      }
    }
  } catch {
    // Git is optional; ranking continues without it.
  }
  return changed;
}

function collectOpenPaths(known: ReadonlySet<string>): Set<string> {
  const open = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText) {
        const path = toWorkspacePath(tab.input.uri);
        if (path !== undefined && known.has(path)) {
          open.add(path);
        }
      }
    }
  }
  return open;
}

/**
 * Bounded, read-only content scan. Files already signalled by Git or open tabs are read first
 * so the file cap never crowds out the most likely candidates.
 */
async function collectContentHits(
  entries: ReadonlyArray<{ uri: vscode.Uri; path: string }>,
  terms: readonly string[],
  priority: ReadonlySet<string>
): Promise<Map<string, number>> {
  const hits = new Map<string, number>();
  if (terms.length === 0) {
    return hits;
  }

  const ordered = [
    ...entries.filter((entry) => priority.has(entry.path)),
    ...entries.filter((entry) => !priority.has(entry.path))
  ].slice(0, MAX_CONTENT_SCAN_FILES);

  for (let index = 0; index < ordered.length; index += CONTENT_SCAN_BATCH) {
    await Promise.all(ordered.slice(index, index + CONTENT_SCAN_BATCH).map(async (entry) => {
      const text = await readSmallTextFile(entry.uri);
      const count = text === undefined ? 0 : countTermHits(text, terms);
      if (count > 0) {
        hits.set(entry.path, count);
      }
    }));
  }
  return hits;
}

function toWorkspacePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }

  const relative = uri.path.slice(folder.uri.path.replace(/\/$/, '').length).replace(/^\//, '');
  return relative.replaceAll('\\', '/');
}

async function resolveTargetEntry(
  targetPath: string,
  folders: readonly vscode.WorkspaceFolder[]
): Promise<{ uri: vscode.Uri; path: string } | undefined> {
  const normalized = targetPath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized
    || normalized.includes('../')
    || normalized.startsWith('/')
    || normalized.includes(':')
    || !isSafeTextPath(normalized)) {
    return undefined;
  }

  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, ...normalized.split('/'));
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.File) {
        return { uri, path: normalized };
      }
    } catch {
      // Try the next workspace folder.
    }
  }

  return undefined;
}

async function readSmallTextFile(uri: vscode.Uri, maxBytes = MAX_READ_BYTES): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > maxBytes) {
      return undefined;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

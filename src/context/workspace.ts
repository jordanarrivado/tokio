import * as vscode from 'vscode';

import type { ContextPreview, ContextScope } from '../core/types';
import {
  countTermHits,
  extractPathReferences,
  extractRelativeImports,
  extractSearchTerms,
  findRelatedTests,
  isSafeTextPath,
  rankContextPaths,
  resolveMentionedPaths,
  type RankSignals
} from './discovery';
import { detectConventionFiles, detectValidationCommands } from './project';

const MAX_DISCOVERED_FILES = 500;
const MAX_READ_BYTES = 32_000;
const MAX_CONTENT_SCAN_FILES = 150;
const CONTENT_SCAN_BATCH = 20;
const MAX_ARCHITECTURE_CHARS = 1200;
const EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.next,vendor}/**';
const ARCHITECTURE_PATH = '.tokio/architecture.md';
const LEGACY_ARCHITECTURE_PATH = '.token-saver/architecture.md';

export interface ContextScanInput {
  rawPrompt: string;
  targetPath: string;
  scope: Exclude<ContextScope, 'none'>;
}

export class WorkspaceContextService {
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

async function readSmallTextFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > MAX_READ_BYTES) {
      return undefined;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

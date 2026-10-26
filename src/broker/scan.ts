import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isSafeTextPath, isSecretPath } from '../context/discovery';
import { readCoChangeLinks } from '../context/history';
import type { RepoFile } from '../context/repomap';

/** Mirrors the extension's workspace rules, plus common Rust, Python, and virtualenv output. */
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'vendor',
  'target', '__pycache__', '.venv', 'venv'
]);
export const MAX_SCANNED_FILES = 500;
/** The most a catalog repository may raise its own cap to, with `maxFiles`. */
export const MAX_SCANNED_FILES_LIMIT = 5000;
export const MAX_FILE_BYTES = 32_000;
/**
 * Generated folders, matched from the repository root only, so a source folder that happens to share
 * a name deeper down is still scanned. Laravel writes compiled views, logs, and caches here.
 */
const EXCLUDED_ROOT_PATHS = new Set(['storage/framework', 'storage/logs', 'bootstrap/cache']);

export interface ScanResult {
  files: RepoFile[];
  truncated: boolean;
  /** Co-change links from recent git history, empty when git is unavailable. */
  coChange: Map<string, string[]>;
}

/**
 * Reads safe text files under a repository root. Symlinks are skipped, so a link cannot
 * point the scan outside the root. Secret paths are never read. An aborted signal stops the scan
 * with an AbortError. history: false skips the git co-change read for callers that do not use it.
 */
export async function scanRepository(
  root: string,
  { signal, history = true, maxFiles = MAX_SCANNED_FILES }: { signal?: AbortSignal; history?: boolean; maxFiles?: number } = {}
): Promise<ScanResult> {
  const files: RepoFile[] = [];
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        const fromRoot = relative(root, fullPath).replaceAll('\\', '/');
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !EXCLUDED_ROOT_PATHS.has(fromRoot)) {
          await walk(fullPath);
        }
        continue;
      }

      const path = relative(root, fullPath).replaceAll('\\', '/');
      if (!entry.isFile() || isSecretPath(path) || !isSafeTextPath(path)) {
        continue;
      }
      const info = await stat(fullPath);
      if (info.size > MAX_FILE_BYTES) {
        continue;
      }
      files.push({ path, content: await readFile(fullPath, { encoding: 'utf8', signal }) });
    }
  }

  await walk(root);
  signal?.throwIfAborted();
  const coChange = history
    ? await readCoChangeLinks(root, new Set(files.map((file) => file.path)))
    : new Map<string, string[]>();
  return { files, truncated, coChange };
}

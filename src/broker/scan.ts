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
export const MAX_FILE_BYTES = 32_000;

export interface ScanResult {
  files: RepoFile[];
  truncated: boolean;
  /** Co-change links from recent git history, empty when git is unavailable. */
  coChange: Map<string, string[]>;
}

/**
 * Reads safe text files under a repository root. Symlinks are skipped, so a link cannot
 * point the scan outside the root. Secret paths are never read.
 */
export async function scanRepository(root: string): Promise<ScanResult> {
  const files: RepoFile[] = [];
  let truncated = false;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }

      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
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
      files.push({ path, content: await readFile(fullPath, 'utf8') });
    }
  }

  await walk(root);
  const coChange = await readCoChangeLinks(root, new Set(files.map((file) => file.path)));
  return { files, truncated, coChange };
}

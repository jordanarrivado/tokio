import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Files that change together in recent commits are often related even when no import links them.
 * Only co-change links for known repository files are returned, so deleted and secret paths never appear.
 */

export const HISTORY_COMMITS = 300;
/** Bulk commits such as formatting or dependency updates touch many files and say little about coupling. */
const MAX_FILES_PER_COMMIT = 25;
const MIN_CO_CHANGES = 2;
const MAX_PARTNERS_PER_FILE = 5;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Parses `git log --name-only --format=%x1e%H`: one record per commit, each starting with a record separator. */
export function parseCommitFiles(output: string): string[][] {
  return output
    .split('\x1e')
    .slice(1)
    .map((record) => record
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0));
}

/** Symmetric co-change links: each file maps to the files it most often changed with. */
export function buildCoChangeLinks(
  commits: readonly (readonly string[])[],
  known: ReadonlySet<string>
): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const commit of commits) {
    const files = [...new Set(commit.filter((path) => known.has(path)))];
    if (files.length < 2 || files.length > MAX_FILES_PER_COMMIT) {
      continue;
    }
    for (const left of files) {
      for (const right of files) {
        if (left === right) {
          continue;
        }
        const row = counts.get(left) ?? new Map<string, number>();
        row.set(right, (row.get(right) ?? 0) + 1);
        counts.set(left, row);
      }
    }
  }

  const links = new Map<string, string[]>();
  for (const [path, row] of counts) {
    const partners = [...row]
      .filter(([, count]) => count >= MIN_CO_CHANGES)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_PARTNERS_PER_FILE)
      .map(([partner]) => partner);
    if (partners.length > 0) {
      links.set(path, partners);
    }
  }
  return links;
}

/**
 * Reads recent history for co-change links. Returns no links when git is not installed, the folder is
 * not a repository, the repository has no history, or git refuses to run. Never throws.
 */
export async function readCoChangeLinks(root: string, known: ReadonlySet<string>): Promise<Map<string, string[]>> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'log', '-n', String(HISTORY_COMMITS), '--relative', '--name-only', '--format=%x1e%H'],
      { maxBuffer: MAX_GIT_OUTPUT_BYTES }
    );
    return buildCoChangeLinks(parseCommitFiles(stdout), known);
  } catch {
    return new Map();
  }
}

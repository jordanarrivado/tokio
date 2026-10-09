const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'before', 'bug', 'change', 'code',
  'could', 'file', 'fix', 'from', 'have', 'into', 'issue', 'make', 'need', 'only',
  'please', 'should', 'that', 'the', 'their', 'there', 'these', 'this', 'update',
  'when', 'where', 'which', 'with'
]);

const SAFE_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.graphql', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.md', '.php', '.py', '.rb', '.rs',
  '.scss', '.sql', '.svelte', '.swift', '.toml', '.ts', '.tsx', '.vue', '.yaml', '.yml'
]);

const SECRET_PATH_PATTERN = /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)(?:\/|$)|\.(?:key|pem|p12|pfx)$/i;

export function extractSearchTerms(rawPrompt: string): string[] {
  const words = rawPrompt.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
  return [...new Set(words
    .filter((word) => !STOP_WORDS.has(word))
    .map(normalizeTerm)
    .filter((word) => word.length >= 3))]
    .slice(0, 20);
}

export function isSafeTextPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (SECRET_PATH_PATTERN.test(normalized)) {
    return false;
  }

  const lastSegment = normalized.split('/').at(-1) ?? '';
  const extensionIndex = lastSegment.lastIndexOf('.');
  const extension = extensionIndex >= 0 ? lastSegment.slice(extensionIndex).toLowerCase() : '';
  return SAFE_TEXT_EXTENSIONS.has(extension);
}

export function extractRelativeImports(source: string): string[] {
  const imports = new Set<string>();
  const pattern = /(?:from\s*|import\s*\(|require\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null && imports.size < 20) {
    imports.add(match[1]);
  }

  return [...imports];
}

/**
 * Corroborating evidence gathered from the workspace. Each signal only adds to a
 * path's score; weak signals alone do not clear the suggestion threshold.
 */
export interface RankSignals {
  changedPaths?: ReadonlySet<string>;
  openPaths?: ReadonlySet<string>;
  contentHits?: ReadonlyMap<string, number>;
}

const CHANGED_BOOST = 20;
const OPEN_BOOST = 10;
const CONTENT_HIT_BOOST = 10;
const MAX_CONTENT_BOOST = 30;

/** Counts how many distinct task terms appear in a file's text (case-insensitive). */
export function countTermHits(content: string, terms: readonly string[]): number {
  const lower = content.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length;
}

export function rankContextPaths(
  paths: readonly string[],
  rawPrompt: string,
  targetPath?: string,
  relativeImports: readonly string[] = [],
  signals: RankSignals = {}
): string[] {
  const normalizedTarget = normalizePath(targetPath ?? '');
  const terms = extractSearchTerms(rawPrompt);
  const importNames = relativeImports.map((specifier) => (
    (normalizePath(specifier).split('/').at(-1) ?? '').replace(/\.[^.]+$/, '').toLowerCase()
  ));
  const allowAuditPaths = /\baudits?\b/i.test(rawPrompt);
  const relatedLimit = normalizedTarget ? 4 : 3;

  return paths
    .filter(isSafeTextPath)
    .map((path) => {
      const normalized = normalizePath(path);
      const directImport = isDirectImportPath(normalized, importNames);
      return {
        path: normalized,
        directImport,
        isTarget: normalized === normalizedTarget,
        score: scorePath(normalized, normalizedTarget, terms, importNames) + signalScore(normalized, signals)
      };
    })
    .filter(({ path, directImport, isTarget }) => (
      allowAuditPaths || !/audit/i.test(path) || directImport || isTarget
    ))
    .filter(({ score, directImport, isTarget }) => (
      isTarget || directImport || score >= (normalizedTarget ? 24 : 30)
    ))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map(({ path }) => path)
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, relatedLimit);
}

function scorePath(path: string, targetPath: string, terms: readonly string[], imports: readonly string[]): number {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();
  const stem = (lower.split('/').at(-1) ?? '').replace(/\.[^.]+$/, '');
  let score = normalized === targetPath ? 1000 : 0;

  if (isDirectImportPath(normalized, imports)) {
    score += 100;
  }

  for (const term of terms) {
    if (stem === term) {
      score += 30;
    } else if (stem.includes(term)) {
      score += 12;
    } else if (lower.includes(`/${term}/`)) {
      score += 5;
    }
  }

  return score;
}

function signalScore(path: string, signals: RankSignals): number {
  let score = 0;
  if (signals.changedPaths?.has(path)) {
    score += CHANGED_BOOST;
  }
  if (signals.openPaths?.has(path)) {
    score += OPEN_BOOST;
  }
  score += Math.min((signals.contentHits?.get(path) ?? 0) * CONTENT_HIT_BOOST, MAX_CONTENT_BOOST);
  return score;
}

function isDirectImportPath(path: string, imports: readonly string[]): boolean {
  const lower = path.toLowerCase();
  const stem = (lower.split('/').at(-1) ?? '').replace(/\.[^.]+$/, '');
  return imports.some((imported) => imported && (stem === imported || lower.endsWith(`/${imported}`)));
}

function normalizeTerm(word: string): string {
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  if (word.length > 5 && word.endsWith('ed')) {
    return word.slice(0, -2);
  }
  if (word.length > 6 && word.endsWith('ing')) {
    return word.slice(0, -3);
  }
  return word;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

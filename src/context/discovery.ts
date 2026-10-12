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
  /** Paths the prompt names directly, for example from a pasted stack trace. */
  mentionedPaths?: ReadonlySet<string>;
}

const CHANGED_BOOST = 20;
const OPEN_BOOST = 10;
const CONTENT_HIT_BOOST = 10;
const MAX_CONTENT_BOOST = 30;
const MENTIONED_BOOST = 60;

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
  if (signals.mentionedPaths?.has(path)) {
    score += MENTIONED_BOOST;
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

const SOURCE_PATH_REFERENCE = /(?:[A-Za-z]:)?[\w@.\\/-]*[\w-]\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|vue|svelte|css|scss|html|sql|json|ya?ml|md)(?=$|[\s:()'"`,;\]])/g;

/** File paths mentioned in the prompt, such as those inside a pasted stack trace. */
export function extractPathReferences(rawPrompt: string): string[] {
  const found = new Set<string>();
  for (const match of rawPrompt.matchAll(SOURCE_PATH_REFERENCE)) {
    const reference = normalizePath(match[0]).replace(/^[A-Za-z]:/, '').replace(/^\/+/, '');
    if (reference.includes('/') || reference.includes('.')) {
      found.add(reference);
    }
    if (found.size >= 20) {
      break;
    }
  }
  return [...found];
}

/** Maps prompt path references onto known workspace paths (exact or trailing-segment match). */
export function resolveMentionedPaths(
  references: readonly string[],
  knownPaths: Iterable<string>
): Set<string> {
  const known = [...knownPaths];
  const resolved = new Set<string>();
  for (const reference of references) {
    const lower = reference.toLowerCase();
    for (const path of known) {
      const candidate = path.toLowerCase();
      if (candidate === lower || candidate.endsWith(`/${lower}`) || lower.endsWith(`/${candidate}`)) {
        resolved.add(path);
      }
    }
  }
  return resolved;
}

const TEST_FILE_PATTERN = /(?:\.(?:test|spec)\.[^./]+$)|(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py|rs)|[^/]+(?:Test|Tests)\.(?:java|kt|cs))$|(?:^|\/)__tests__\//;

export function isTestPath(path: string): boolean {
  return TEST_FILE_PATTERN.test(normalizePath(path));
}

/** Test files that sit next to the given source files, by conventional naming. */
export function findRelatedTests(
  sources: readonly string[],
  allPaths: readonly string[],
  limit = 3
): string[] {
  const tests = allPaths.map(normalizePath).filter(isTestPath);
  const related: string[] = [];

  for (const source of sources) {
    const normalized = normalizePath(source);
    if (isTestPath(normalized)) {
      continue;
    }
    const stem = (normalized.split('/').at(-1) ?? '').replace(/\.[^.]+$/, '').toLowerCase();
    if (!stem) {
      continue;
    }
    for (const test of tests) {
      if (extensionFamily(test) !== extensionFamily(normalized)) {
        continue;
      }
      const testStem = (test.split('/').at(-1) ?? '')
        .replace(/\.(?:test|spec)(?=\.)/i, '')
        .replace(/\.[^.]+$/, '')
        .replace(/^test_/i, '')
        .replace(/_test$/i, '')
        .replace(/Tests?$/, '')
        .toLowerCase();
      if (testStem === stem && !related.includes(test)) {
        related.push(test);
      }
    }
  }
  return related.slice(0, limit);
}

function extensionFamily(path: string): string {
  const extension = (path.split('/').at(-1) ?? '').split('.').at(-1)?.toLowerCase() ?? '';
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension) ? 'js' : extension;
}

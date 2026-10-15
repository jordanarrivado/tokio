import { posix } from 'node:path';
import { estimateTokens } from '../core/tokens';
import { countTermHits, extractRelativeImports, extractSearchTerms } from './discovery';

/**
 * Pure repository map: ranks files by task relevance and import relationships, then lists
 * top-level signatures until a token budget is reached. Bodies are fetched separately.
 */

export interface RepoFile {
  path: string;
  content: string;
}

export interface RepoSymbol {
  line: number;
  signature: string;
}

export interface RepoMapOptions {
  task: string;
  budgetTokens: number;
  targetPath?: string;
  maxSymbolsPerFile?: number;
}

export interface RepoMap {
  text: string;
  tokens: number;
  files: string[];
  /** Files that had symbols but did not fit in the budget. */
  omittedFiles: number;
}

const HEADER = 'Repository map: files ranked by relevance to the task, with top-level signatures. '
  + 'Use read_symbol with a line number to fetch a body.';
const DEFAULT_MAX_SYMBOLS = 8;
const MAX_SYMBOLS_PER_FILE = 200;
const MAX_SIGNATURE_CHARS = 160;
const PAGERANK_DAMPING = 0.85;
const PAGERANK_ITERATIONS = 30;
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const TARGET_SEED_WEIGHT = 100;
const PATH_HIT_WEIGHT = 10;
const CONTENT_HIT_WEIGHT = 2;
const MAX_CONTENT_SEED_WEIGHT = 40;

/** Top-level declarations only, so nested members do not crowd the map. */
const SYMBOL_RULES: readonly { extensions: readonly string[]; pattern: RegExp }[] = [
  {
    extensions: SCRIPT_EXTENSIONS,
    pattern: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+[A-Za-z_$][\w$]*/
  },
  { extensions: ['.py'], pattern: /^(?:async\s+)?(?:def|class)\s+[A-Za-z_]\w*/ },
  { extensions: ['.go'], pattern: /^(?:func|type)\s+/ },
  { extensions: ['.rs'], pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+[A-Za-z_]\w*/ }
];

export function buildRepoMap(files: readonly RepoFile[], options: RepoMapOptions): RepoMap {
  const known = new Set(files.map((file) => file.path));
  const targetPath = options.targetPath ? normalizePath(options.targetPath) : undefined;
  const ranks = rankFiles(
    files,
    buildImportEdges(files, known),
    seedWeights(files, extractSearchTerms(options.task), targetPath)
  );
  const maxSymbols = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS;
  const ordered = [...files].sort((left, right) => (
    (ranks.get(right.path) ?? 0) - (ranks.get(left.path) ?? 0) || left.path.localeCompare(right.path)
  ));

  let text = HEADER;
  const included: string[] = [];
  let omittedFiles = 0;

  for (const file of ordered) {
    const symbols = extractSymbols(file.content, file.path);
    if (symbols.length === 0) {
      continue;
    }
    const candidate = `${text}\n${formatBlock(file.path, symbols, maxSymbols)}`;
    if (estimateTokens(candidate) > options.budgetTokens) {
      omittedFiles += 1;
      continue;
    }
    text = candidate;
    included.push(file.path);
  }

  return { text, tokens: estimateTokens(text), files: included, omittedFiles };
}

/** Top-level symbols with 1-based line numbers. Supports TypeScript/JavaScript, Python, Go, and Rust. */
export function extractSymbols(content: string, path: string): RepoSymbol[] {
  const extension = extensionOf(path);
  const rule = SYMBOL_RULES.find((candidate) => candidate.extensions.includes(extension));
  if (!rule) {
    return [];
  }

  const symbols: RepoSymbol[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = lines[index];
    if (!rule.pattern.test(line)) {
      continue;
    }
    // Plain constants are noise in a map; keep only bindings that hold a function.
    if (/^(?:export\s+)?(?:const|let)\b/.test(line) && !/=>|\bfunction\b/.test(line)) {
      continue;
    }
    symbols.push({ line: index + 1, signature: formatSignature(line) });
  }
  return symbols;
}

/** Resolves a relative JS/TS import to a known file, including `.js`→`.ts` and `index` files. */
export function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  known: ReadonlySet<string>
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => `${stripped}${extension}`),
    ...SCRIPT_EXTENSIONS.map((extension) => posix.join(base, `index${extension}`))
  ];
  return candidates.find((candidate) => known.has(candidate) && candidate !== fromPath);
}

function buildImportEdges(files: readonly RepoFile[], known: ReadonlySet<string>): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of extractRelativeImports(file.content)) {
      const resolved = resolveRelativeImport(file.path, specifier, known);
      if (resolved) {
        targets.add(resolved);
      }
    }
    edges.set(file.path, [...targets]);
  }
  return edges;
}

function seedWeights(
  files: readonly RepoFile[],
  terms: readonly string[],
  targetPath: string | undefined
): Map<string, number> {
  const seeds = new Map<string, number>();
  for (const file of files) {
    const path = normalizePath(file.path);
    const contentHits = Math.min(countTermHits(file.content, terms) * CONTENT_HIT_WEIGHT, MAX_CONTENT_SEED_WEIGHT);
    seeds.set(path, (path === targetPath ? TARGET_SEED_WEIGHT : 0)
      + countTermHits(path, terms) * PATH_HIT_WEIGHT
      + contentHits);
  }
  return seeds;
}

/**
 * Personalized PageRank over the import graph. Task-relevant files are the teleport targets, so
 * their direct dependencies rise too. With no relevant seeds, the ranking is uniform.
 */
function rankFiles(
  files: readonly RepoFile[],
  edges: ReadonlyMap<string, readonly string[]>,
  seeds: ReadonlyMap<string, number>
): Map<string, number> {
  const count = files.length;
  const totalSeed = [...seeds.values()].reduce((sum, value) => sum + value, 0);
  const teleport = new Map<string, number>();
  for (const file of files) {
    const seed = seeds.get(file.path) ?? 0;
    teleport.set(file.path, totalSeed > 0 ? seed / totalSeed : 1 / count);
  }

  let rank = new Map(teleport);
  for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration += 1) {
    const next = new Map<string, number>();
    for (const file of files) {
      next.set(file.path, (1 - PAGERANK_DAMPING) * (teleport.get(file.path) ?? 0));
    }

    let danglingMass = 0;
    for (const file of files) {
      const value = rank.get(file.path) ?? 0;
      const outgoing = edges.get(file.path) ?? [];
      if (outgoing.length === 0) {
        danglingMass += value;
        continue;
      }
      const share = (PAGERANK_DAMPING * value) / outgoing.length;
      for (const target of outgoing) {
        next.set(target, (next.get(target) ?? 0) + share);
      }
    }

    for (const file of files) {
      next.set(file.path, (next.get(file.path) ?? 0) + PAGERANK_DAMPING * danglingMass * (teleport.get(file.path) ?? 0));
    }
    rank = next;
  }
  return rank;
}

function formatBlock(path: string, symbols: readonly RepoSymbol[], maxSymbols: number): string {
  const lines = [path, ...symbols.slice(0, maxSymbols).map((symbol) => `  ${symbol.line}: ${symbol.signature}`)];
  if (symbols.length > maxSymbols) {
    lines.push(`  ... ${symbols.length - maxSymbols} more`);
  }
  return lines.join('\n');
}

function formatSignature(line: string): string {
  return line.trim().replace(/\s*\{\s*$/, '').slice(0, MAX_SIGNATURE_CHARS);
}

function extensionOf(path: string): string {
  const name = normalizePath(path).split('/').at(-1) ?? '';
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

import { posix } from 'node:path';
import { estimateTokens } from '../core/tokens';
import { countTermHits, extractRelativeImports, extractSearchTerms } from './discovery';
import { createImportIndex, resolveLanguageImports } from './imports';

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
  /** Files that often change together (see history.ts). Each link adds a ranking edge between two files. */
  coChange?: ReadonlyMap<string, readonly string[]>;
  /**
   * Import edges built by the caller, used instead of reading imports from the files. Needed when paths
   * carry a repository prefix, because Python and Go imports resolve from each repository's own root.
   */
  edges?: ReadonlyMap<string, string[]>;
  /** Paths with this prefix rank first among files with the same score. */
  preferPrefix?: string;
  /** How a path is shown in the map. Defaults to the path itself. */
  formatPath?: (path: string) => string;
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
  // PHP keeps nearly everything inside one class, so methods count too: indented `function` lines with
  // any visibility. Types and functions at the top level start the line.
  {
    extensions: ['.php'],
    pattern: /^(?:(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+[A-Za-z_]\w*|function\s+&?[A-Za-z_]\w*|\s+(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?[A-Za-z_]\w*)/
  },
  { extensions: ['.rs'], pattern: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+[A-Za-z_]\w*/ }
];

export function buildRepoMap(files: readonly RepoFile[], options: RepoMapOptions): RepoMap {
  const known = new Set(files.map((file) => file.path));
  const targetPath = options.targetPath ? normalizePath(options.targetPath) : undefined;
  const seeds = seedWeights(files, extractSearchTerms(options.task), targetPath);
  const ranks = rankFiles(
    files,
    withCoChangeEdges(options.edges ?? buildImportEdges(files, known), options.coChange, known),
    seeds
  );
  const scores = blendScores(files, ranks, seeds);
  const maxSymbols = options.maxSymbolsPerFile ?? DEFAULT_MAX_SYMBOLS;
  const preferred = (path: string): number => (options.preferPrefix && path.startsWith(options.preferPrefix) ? 1 : 0);
  const ordered = [...files].sort((left, right) => (
    (scores.get(right.path) ?? 0) - (scores.get(left.path) ?? 0)
      || preferred(right.path) - preferred(left.path)
      || left.path.localeCompare(right.path)
  ));

  let text = HEADER;
  const included: string[] = [];
  let omittedFiles = 0;

  for (const file of ordered) {
    const symbols = extractSymbols(file.content, file.path);
    if (symbols.length === 0) {
      continue;
    }
    const candidate = `${text}\n${formatBlock(options.formatPath?.(file.path) ?? file.path, symbols, maxSymbols)}`;
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
  // PHP shares the JS comment and string syntax, so the same mask keeps docblocks out of the map.
  const masked = (SCRIPT_EXTENSIONS as readonly string[]).includes(extension) || extension === '.php';
  const code = masked ? maskJsComments(content) : lines;
  for (let index = 0; index < lines.length && symbols.length < MAX_SYMBOLS_PER_FILE; index += 1) {
    const line = code[index];
    if (!rule.pattern.test(line)) {
      continue;
    }
    // Plain constants are noise in a map; keep only bindings that hold a function.
    if (/^(?:export\s+)?(?:const|let)\b/.test(line) && !/=>|\bfunction\b/.test(line)) {
      continue;
    }
    symbols.push({ line: index + 1, signature: formatSignature(lines[index]) });
  }
  return symbols;
}

/**
 * Blanks out comments and string contents, so a declaration written inside a comment or template
 * literal is not mistaken for code. Columns are kept, so each masked line lines up with the original.
 * Limits: regex literals are not recognised, and a `${}` expression that contains a backtick ends the template early.
 */
export function maskJsComments(content: string): string[] {
  let inBlockComment = false;
  let inTemplate = false;
  return content.split(/\r?\n/).map((line) => {
    let out = '';
    let quote: string | undefined;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (inBlockComment) {
        if (char === '*' && next === '/') {
          out += '  ';
          index += 1;
          inBlockComment = false;
        } else {
          out += ' ';
        }
      } else if (inTemplate || quote) {
        if (char === '\\') {
          out += '  ';
          index += 1;
        } else {
          out += ' ';
          if (inTemplate && char === '`') {
            inTemplate = false;
          } else if (quote && char === quote) {
            quote = undefined;
          }
        }
      } else if (char === '/' && next === '/') {
        out += ' '.repeat(line.length - index);
        break;
      } else if (char === '/' && next === '*') {
        out += '  ';
        index += 1;
        inBlockComment = true;
      } else if (char === '`') {
        out += ' ';
        inTemplate = true;
      } else if (char === '"' || char === "'") {
        out += ' ';
        quote = char;
      } else {
        out += char;
      }
    }
    return out;
  });
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

/** Each file's imports that resolve to another file in the list: relative JS/TS, Python, Go, and Rust. */
export function buildImportEdges(files: readonly RepoFile[], known: ReadonlySet<string>): Map<string, string[]> {
  // composer.json gives PHP's PSR-4 namespace map; it is scanned like any other JSON file.
  const composer = files.find((file) => file.path === 'composer.json')?.content;
  const index = createImportIndex(files.map((file) => file.path), composer);
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const specifier of extractRelativeImports(file.content)) {
      const resolved = resolveRelativeImport(file.path, specifier, known);
      if (resolved) {
        targets.add(resolved);
      }
    }
    for (const resolved of resolveLanguageImports(file.path, file.content, index)) {
      targets.add(resolved);
    }
    edges.set(file.path, [...targets]);
  }
  return edges;
}

/** Adds co-change partners to each file's edges. Partners outside the scanned files are ignored. */
function withCoChangeEdges(
  edges: ReadonlyMap<string, string[]>,
  coChange: ReadonlyMap<string, readonly string[]> | undefined,
  known: ReadonlySet<string>
): Map<string, string[]> {
  if (!coChange) {
    return new Map(edges);
  }
  const merged = new Map<string, string[]>();
  for (const [path, targets] of edges) {
    const partners = (coChange.get(path) ?? []).filter((partner) => known.has(partner) && partner !== path);
    merged.set(path, [...new Set([...targets, ...partners])]);
  }
  return merged;
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

/**
 * Ordering score: half import rank, half direct task match, each scaled to its maximum. PageRank alone
 * lets a file imported by many matching files outrank the files the task names, which happens in
 * frameworks where dozens of similar controllers share the same enums and base classes.
 */
function blendScores(
  files: readonly RepoFile[],
  ranks: ReadonlyMap<string, number>,
  seeds: ReadonlyMap<string, number>
): Map<string, number> {
  const maxRank = Math.max(0, ...files.map((file) => ranks.get(file.path) ?? 0));
  const maxSeed = Math.max(0, ...files.map((file) => seeds.get(normalizePath(file.path)) ?? 0));
  const scores = new Map<string, number>();
  for (const file of files) {
    const rank = maxRank > 0 ? (ranks.get(file.path) ?? 0) / maxRank : 0;
    const seed = maxSeed > 0 ? (seeds.get(normalizePath(file.path)) ?? 0) / maxSeed : 0;
    scores.set(file.path, rank + seed);
  }
  return scores;
}

function formatBlock(path: string, symbols: readonly RepoSymbol[], maxSymbols: number): string {
  const lines = [path, ...symbols.slice(0, maxSymbols).map((symbol) => `  ${symbol.line}: ${symbol.signature}`)];
  if (symbols.length > maxSymbols) {
    lines.push(`  ... ${symbols.length - maxSymbols} more`);
  }
  return lines.join('\n');
}

/** The declared name in a signature such as `export class Broker` or `func (r *T) Run(`. */
export function symbolName(signature: string): string {
  const match = /^(?:(?:export|default|declare|abstract|async|public|private|protected|static|final|readonly|pub(?:\([^)]*\))?|unsafe)\s+)*(?:(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl|namespace|module)\s+)?&?(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/
    .exec(signature);
  return match ? match[1] : '';
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

import { isStopWord, normalizeTerm } from './discovery';
import { extractSymbols, symbolName } from './repomap';

/**
 * Architecture map: a user-written Markdown file that names each area of the system, its routes, and the
 * files and symbols that serve them. Each heading is one area:
 *
 *   ## Auth
 *   Keywords: login, token, session
 *   - POST /api/login -> src/auth/login.ts#handleLogin
 *   - Related: src/auth/session.ts, src/db/users.ts
 *
 * Areas are ranked against the task with BM25, so the agent starts from the exact files and lines the
 * map names instead of searching the repository. Everything here is pure; callers load the files.
 */

export interface MapRoute {
  /** The text before the arrow, such as `POST /api/login` or `nightly payroll job`. */
  label: string;
  file: string;
  symbol?: string;
}

export interface MapArea {
  name: string;
  keywords: string[];
  routes: MapRoute[];
  related: string[];
  /** Other text under the heading. Ranked, never shown. */
  prose: string;
}

export interface RankedArea {
  area: MapArea;
  score: number;
}

export interface MapAnchor {
  area: string;
  path: string;
  label?: string;
  symbol?: string;
  /** Set when the map entry names a folder rather than a file. */
  folder?: boolean;
  /** Present when the symbol was found. Without a symbol the whole file is meant. */
  startLine?: number;
  endLine?: number;
}

export interface MapRouting {
  areas: string[];
  anchors: MapAnchor[];
  /** Map entries whose file or symbol no longer exists. */
  stale: string[];
}

export interface MapFile {
  path: string;
  content: string;
}

/** Where each repository keeps its map. Committed with the code, so it is reviewed when the code moves. */
export const MAP_PATH = '.tokio/map.md';

/** Starting content for a new map: one area for routes and one for data structures. */
export const MAP_TEMPLATE = [
  '# Architecture map',
  '',
  'One heading per area. Tokio matches the task against each area and sends the agent only the matched',
  'files and lines. Route lines: `- <label> -> <path>[#symbol]`. Paths are relative to the repository root.',
  '',
  '## Auth',
  'Keywords: login, token, session',
  '- POST /api/login -> src/auth/login.ts#handleLogin',
  '- Related: src/auth/session.ts',
  '',
  '## Employee data',
  'Keywords: employee, record, model, table',
  '- Employee model -> src/models/employee.ts#Employee',
  '- employees table -> db/migrations/001_create_employees.sql',
  ''
].join('\n');

/** Every entry in the map checked at once: area count, route count, and entries that no longer resolve. */
export function checkMap(
  areas: readonly MapArea[],
  lookup: (path: string) => MapFile | undefined,
  isFolder: (path: string) => boolean = () => false
): { areas: number; routes: number; stale: string[] } {
  const routing = resolveMapAnchors(areas.map((area) => ({ area, score: 0 })), lookup, '', isFolder);
  return { areas: areas.length, routes: areas.reduce((sum, area) => sum + area.routes.length, 0), stale: routing.stale };
}

const DEFAULT_MAX_AREAS = 3;
/** Areas scoring below this share of the best area are dropped, so one strong match is not padded with noise. */
const MIN_RELATIVE_SCORE = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** A route path written in the task, such as /api/login, names the area outright. */
const ROUTE_PATH_BONUS = 5;
const FIELD_WEIGHTS = { heading: 3, keyword: 3, label: 2, symbol: 2, path: 1, related: 1, prose: 1 } as const;
const MAX_STALE = 10;
/**
 * An area must share at least this many distinct task terms in its heading, keywords, route labels, or symbols.
 * Paths and prose alone never qualify an area, since words like "user" or "request" appear in many of them.
 */
const MIN_STRONG_HITS = 2;
/** A single strong hit is enough when it covers this share of the task's terms, as in "fix the login". */
const MIN_SINGLE_HIT_SHARE = 0.34;
const STRONG_WEIGHT = FIELD_WEIGHTS.label;
/**
 * Verbs and filler that say what to do, not where. They match prose and route labels in every area, so a short
 * prompt made of them, such as "is this worth it for the team", would otherwise match on a single word.
 */
const GENERIC_TERMS = new Set([
  'ask', 'send', 'check', 'problem', 'worth', 'want', 'help', 'try', 'look', 'thing', 'something', 'can', 'two', 'one',
  'for', 'you', 'your', 'are', 'was', 'were', 'but', 'not', 'all', 'any', 'its', 'our', 'has', 'had', 'how', 'why',
  'what', 'who', 'does', 'did', 'get', 'them', 'they', 'then', 'than', 'too', 'very', 'just', 'still', 'now', 'team', 'use'
]);

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;
const KEYWORDS = /^(?:keywords?|tags?)\s*:\s*(.*)$/i;
const RELATED = /^(?:related|files?|see also)\s*:\s*(.*)$/i;
const ROUTE = /^(.+?)\s*(?:->|→|=>)\s*(\S+)\s*$/;
const ROUTE_PATH = /(?:^|\s)(\/[\w.:{}\-/]*\w)/g;

export function parseArchitectureMap(text: string): MapArea[] {
  const areas: MapArea[] = [];
  let current: MapArea | undefined;
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const heading = HEADING.exec(raw);
    if (heading) {
      current = { name: stripMarkup(heading[1]), keywords: [], routes: [], related: [], prose: '' };
      areas.push(current);
      continue;
    }
    if (!current) {
      continue;
    }

    const line = stripMarkup(raw.replace(LIST_ITEM, ''));
    const keywords = KEYWORDS.exec(line);
    const related = RELATED.exec(line);
    const route = LIST_ITEM.test(raw) ? ROUTE.exec(line) : null;
    if (keywords) {
      current.keywords.push(...splitList(keywords[1]));
    } else if (related) {
      current.related.push(...splitList(related[1]).map((item) => normalizePath(item.split('#')[0])));
    } else if (route) {
      const [file, symbol] = route[2].split('#');
      current.routes.push({ label: route[1], file: normalizePath(file), ...(symbol ? { symbol } : {}) });
    } else if (line.trim()) {
      current.prose += `${line.trim()}\n`;
    }
  }
  // A heading with nothing to route to, such as the document title, is not an area.
  return areas.filter((area) => area.routes.length > 0 || area.related.length > 0);
}

/** Areas that match the task, best first. Empty when nothing in the map shares a term with the task. */
export function rankMapAreas(
  areas: readonly MapArea[],
  task: string,
  maxAreas = DEFAULT_MAX_AREAS
): RankedArea[] {
  const scored = scoreMapAreas(areas, task).map(({ area, score, clear }) => ({ area, score: clear ? score : 0 }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  return scored
    .filter((entry) => entry.score > 0 && entry.score >= best * MIN_RELATIVE_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, maxAreas);
}

export interface AreaScore {
  area: MapArea;
  /** BM25 score before the match rules, plus the route path bonus. */
  score: number;
  /** True when the area passes the strong-hit rule or the task names one of its route paths. */
  clear: boolean;
  /** Task terms found in the area. */
  terms: string[];
  /** The subset of terms found in its heading, keywords, route labels, or symbols. */
  strongTerms: string[];
}

/** Every area's score for a task, in map order, with the terms behind it. rankMapAreas applies the cutoffs. */
export function scoreMapAreas(areas: readonly MapArea[], task: string): AreaScore[] {
  const query = [...new Set(tokenize(task))].filter((term) => !GENERIC_TERMS.has(term));
  const documents = areas.map(areaTerms);
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(documents.length, 1);
  const frequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of doc.terms.keys()) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }

  const taskPaths = [...task.matchAll(ROUTE_PATH)].map((match) => match[1].toLowerCase());
  return areas.map((area, index) => {
    const doc = documents[index];
    let score = 0;
    const terms: string[] = [];
    const strongTerms: string[] = [];
    for (const term of query) {
      const count = doc.terms.get(term) ?? 0;
      if (count === 0) {
        continue;
      }
      terms.push(term);
      if (doc.strong.has(term)) {
        strongTerms.push(term);
      }
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (areas.length - df + 0.5) / (df + 0.5));
      score += idf * (count * (BM25_K1 + 1))
        / (count + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / Math.max(averageLength, 1))));
    }
    const namesRoute = taskPaths.some((path) => area.routes.some((route) => routePath(route.label) === path));
    if (namesRoute) {
      score += ROUTE_PATH_BONUS;
    }
    const strongHits = strongTerms.length;
    const clear = strongHits >= MIN_STRONG_HITS || (strongHits === 1 && strongHits / Math.max(query.length, 1) >= MIN_SINGLE_HIT_SHARE);
    return { area, score, clear: namesRoute || clear, terms, strongTerms };
  });
}

/** Why a ranked-out area missed: no clear terms, under the relative cutoff, or past the area limit. */
export function explainMissedArea(scores: readonly AreaScore[], name: string, maxAreas = DEFAULT_MAX_AREAS): string {
  const entry = scores.find((candidate) => candidate.area.name === name);
  if (!entry || entry.terms.length === 0) {
    return 'no task term found in the area';
  }
  if (!entry.clear) {
    return `only ${entry.strongTerms.length} strong term (${entry.strongTerms.join(', ') || 'none'}; others: ${entry.terms.filter((term) => !entry.strongTerms.includes(term)).join(', ') || 'none'})`;
  }
  const best = Math.max(...scores.filter((candidate) => candidate.clear).map((candidate) => candidate.score));
  const share = entry.score / best;
  if (share < MIN_RELATIVE_SCORE) {
    return `scored ${share.toFixed(2)} of the best area, under the ${MIN_RELATIVE_SCORE} cutoff (via ${entry.strongTerms.join(', ')})`;
  }
  return `outranked: only the top ${maxAreas} areas are sent`;
}

/** Every file the ranked areas point to, so the caller can load just those. */
export function mapPaths(ranked: readonly RankedArea[]): string[] {
  return [...new Set(ranked.flatMap(({ area }) => [...area.routes.map((route) => route.file), ...area.related]))];
}

/**
 * Turns ranked areas into files and line ranges. lookup returns a loaded file for a map path, or
 * undefined when it does not exist. Entries that cannot be found are reported as stale, not dropped silently.
 */
export function resolveMapAnchors(
  ranked: readonly RankedArea[],
  lookup: (path: string) => MapFile | undefined,
  task = '',
  isFolder: (path: string) => boolean = () => false
): MapRouting {
  const query = new Set(tokenize(task));
  const anchors: MapAnchor[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();
  const add = (anchor: MapAnchor): void => {
    const key = `${anchor.path}#${anchor.symbol ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      anchors.push(anchor);
    }
  };

  for (const { area } of ranked) {
    // Routes the task names come first inside an area; the map order breaks ties.
    const routes = area.routes
      .map((route, index) => ({ route, index, hits: routeTerms(route).filter((term) => query.has(term)).length }))
      .sort((left, right) => right.hits - left.hits || left.index - right.index)
      .map((entry) => entry.route);
    for (const route of routes) {
      const file = lookup(route.file);
      if (!file) {
        if (isFolder(route.file)) {
          add({ area: area.name, path: route.file, label: route.label, folder: true });
        } else {
          stale.push(`${area.name}: no file or folder at ${route.file}`);
        }
        continue;
      }
      const range = route.symbol ? findSymbolRange(file, route.symbol) : undefined;
      if (route.symbol && !range) {
        stale.push(`${area.name}: symbol ${route.symbol} not found in ${route.file}`);
      }
      add({ area: area.name, path: file.path, label: route.label, ...(route.symbol ? { symbol: route.symbol } : {}), ...range });
    }
    for (const related of area.related) {
      const file = lookup(related);
      if (file) {
        add({ area: area.name, path: file.path });
      } else if (isFolder(related)) {
        add({ area: area.name, path: related, folder: true });
      } else {
        stale.push(`${area.name}: no file or folder at ${related}`);
      }
    }
  }
  return { areas: ranked.map(({ area }) => area.name), anchors, stale };
}

/** Text for an agent or a refined prompt: one line per anchor, then any stale entries. */
export function formatMapRouting(routing: MapRouting, formatPath: (path: string) => string = (path) => path): string {
  if (routing.areas.length === 0) {
    return 'Architecture map: no area matched the task.';
  }
  const lines = [`Architecture map: ${routing.areas.join(', ')}. Start from these; read only the listed lines.`];
  for (const anchor of routing.anchors) {
    lines.push(`- ${formatAnchor(anchor, formatPath)}`);
  }
  if (routing.stale.length > 0) {
    const shown = routing.stale.slice(0, MAX_STALE);
    const more = routing.stale.length - shown.length;
    lines.push(`Map entries not found (the map may be out of date): ${shown.join('; ')}${more > 0 ? `; ${more} more` : ''}.`);
  }
  return lines.join('\n');
}

/** `src/auth/login.ts:12-40 handleLogin (POST /api/login)`, or just the path for a related file. */
export function formatAnchor(anchor: MapAnchor, formatPath: (path: string) => string = (path) => path): string {
  const lines = anchor.startLine !== undefined
    ? `:${anchor.startLine}${anchor.endLine !== undefined && anchor.endLine !== anchor.startLine ? `-${anchor.endLine}` : ''}`
    : '';
  const symbol = anchor.symbol ? ` ${anchor.symbol}` : '';
  const label = anchor.label ? ` (${anchor.label})` : anchor.symbol ? '' : anchor.folder ? ' (folder)' : ' (related)';
  const path = anchor.folder ? `${formatPath(anchor.path)}/` : formatPath(anchor.path);
  return `${path}${lines}${symbol}${label}`;
}

/**
 * Line range of a symbol: a top-level declaration first, then any line that declares the name, so
 * methods and nested handlers resolve too. `Class.method` matches the method. The range ends at the body's closing
 * line, and never past the next top-level symbol.
 */
export function findSymbolRange(file: MapFile, symbol: string): { startLine: number; endLine: number } | undefined {
  const name = symbol.split(/[.:]+/).at(-1) ?? symbol;
  const lines = file.content.split(/\r?\n/);
  const symbols = extractSymbols(file.content, file.path);
  let start = symbols.find((candidate) => symbolName(candidate.signature) === name)?.line;
  if (start === undefined) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
      `(?:\\b(?:function|def|fn|func|class|interface|type|enum|struct|trait|const|let|var)\\s+\\*?${escaped}\\b)|(?:^\\s*(?:(?:public|private|protected|static|async|override|readonly)\\s+)*${escaped}\\s*(?:\\(|=|:))`
    );
    const index = lines.findIndex((line) => declaration.test(line));
    start = index >= 0 ? index + 1 : undefined;
  }
  if (start === undefined) {
    return undefined;
  }
  const next = symbols.find((candidate) => candidate.line > start!);
  let end = next ? next.line - 1 : lines.length;
  // The body ends at the first line back at the declaration's indentation: a closing brace is kept, anything
  // else (the next method, a Python def) is not. A line starting with `)` continues a multi-line signature.
  const indent = indentOf(lines[start - 1]);
  for (let line = start + 1; line <= end; line += 1) {
    const text = lines[line - 1];
    if (text.trim() === '' || indentOf(text) > indent || (indentOf(text) === indent && /^\s*\)/.test(text))) {
      continue;
    }
    end = indentOf(text) === indent && /^\s*}/.test(text) ? line : line - 1;
    break;
  }
  // Blank lines before the next symbol are not part of the body.
  while (end > start && lines[end - 1].trim() === '') {
    end -= 1;
  }
  return { startLine: start, endLine: end };
}

/** Lowercase words with camelCase, snake_case, and path parts split, stop words dropped, endings normalized. */
export function tokenize(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((word) => word.length >= 3 && !isStopWord(word))
    .map(normalizeTerm)
    .filter((word) => word.length >= 3);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function areaTerms(area: MapArea): { terms: Map<string, number>; strong: Set<string>; length: number } {
  const terms = new Map<string, number>();
  const strong = new Set<string>();
  let length = 0;
  const add = (text: string, weight: number): void => {
    for (const term of tokenize(text)) {
      terms.set(term, (terms.get(term) ?? 0) + weight);
      length += weight;
      if (weight >= STRONG_WEIGHT) {
        strong.add(term);
      }
    }
  };
  add(area.name, FIELD_WEIGHTS.heading);
  area.keywords.forEach((keyword) => add(keyword, FIELD_WEIGHTS.keyword));
  for (const route of area.routes) {
    add(route.label, FIELD_WEIGHTS.label);
    add(route.symbol ?? '', FIELD_WEIGHTS.symbol);
    add(route.file, FIELD_WEIGHTS.path);
  }
  area.related.forEach((path) => add(path, FIELD_WEIGHTS.related));
  add(area.prose, FIELD_WEIGHTS.prose);
  return { terms, strong, length };
}

function routeTerms(route: MapRoute): string[] {
  return tokenize(`${route.label} ${route.symbol ?? ''} ${route.file}`);
}

/** The path in a route label, such as `/api/login` in `POST /api/login`. */
function routePath(label: string): string | undefined {
  return [...label.matchAll(ROUTE_PATH)][0]?.[1].toLowerCase();
}

function splitList(text: string): string[] {
  return text.split(/[,;]/).map((item) => stripMarkup(item).trim()).filter(Boolean);
}

/** Drops backticks, bold, and link syntax, keeping the text. Underscores stay, since paths use them. */
function stripMarkup(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`/g, '');
}

function normalizePath(path: string): string {
  // A trailing slash marks a folder; the folder check does not need it.
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

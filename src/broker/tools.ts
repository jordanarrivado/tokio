import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refinePrompt } from '../core/refine';
import { classifyWorkCategory } from '../core/category';
import type { Mode, PromptTarget, WorkCategory } from '../core/types';
import { countTermHits, extractSearchTerms } from '../context/discovery';
import { buildRepoMap, extractSymbols } from '../context/repomap';
import { estimateTokens } from '../core/tokens';
import { appendAuditEntry } from './audit';
import { PolicyError, redactSecrets, resolveRepoPath } from './policy';
import { scanRepository } from './scan';
import { formatFooter, formatStats, readAuditEntries, summarizeAudit } from './stats';
import { detectValidationCommands } from '../context/project';
import { findRelevantFiles, formatRoutePlan, planRoute } from '../context/routing';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolOutcome {
  text: string;
  isError?: boolean;
  files?: string[];
  redactions?: string[];
  /** Set for policy blocks so the audit log can count them. */
  blocked?: boolean;
  /** Estimated tokens of the full-file or full-text alternative. Absent means no savings estimate. */
  baselineTokens?: number;
  /** False for results that should not carry an estimate footer, such as session_stats itself. */
  estimate?: boolean;
  /** Routing decision for the audit log. Tier and confidence only. */
  route?: { tier: string; confidence: string };
}

const MODES: readonly Mode[] = ['minimal', 'adaptive', 'strict'];
const TARGETS: readonly PromptTarget[] = ['generic', 'claude', 'codex'];
const CATEGORIES: readonly WorkCategory[] = [
  'general', 'bug', 'feature', 'enhancement', 'refactor', 'performance',
  'tests', 'documentation', 'investigation', 'other'
];

const DEFAULT_BUDGET_TOKENS = 1500;
const MAX_BUDGET_TOKENS = 8000;
const MAX_READ_LINES = 200;
const MAX_SEARCH_RESULT_TOKENS = 1500;
const CHUNK_CHARS = 800;
const MAX_STORED_OUTPUTS = 20;

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'refine_task',
    description: 'Turn the user task into a scoped prompt. Redacts secrets. Call once per task.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        target: { type: 'string', enum: TARGETS },
        mode: { type: 'string', enum: MODES },
        category: { type: 'string', enum: CATEGORIES },
        targetPath: { type: 'string' }
      },
      required: ['task']
    }
  },
  {
    name: 'repo_map',
    description: 'Ranked repository map of files and top-level signatures (with line numbers) for a task, within a token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        targetPath: { type: 'string' },
        budgetTokens: { type: 'integer', minimum: 200, maximum: MAX_BUDGET_TOKENS }
      },
      required: ['task']
    }
  },
  {
    name: 'read_symbol',
    description: 'Read a body by startLine (up to the next top-level symbol). Repeat reads return only changed lines unless full is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        full: { type: 'boolean' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_output',
    description: 'Search the rest of a truncated read by its output id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 10 }
      },
      required: ['id', 'query']
    }
  },
  {
    name: 'session_stats',
    description: 'Estimated tokens returned and saved by Tokio calls since this server started.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'route_task',
    description: 'Advisory: estimate a task tier (small/medium/large) and the model for each phase. Switches nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        targetPath: { type: 'string' }
      },
      required: ['task']
    }
  }
];

/**
 * Session-scoped broker. State such as served ranges and stored outputs lives only as long as
 * the process, and every call is appended to the audit log without its contents.
 */
export class Broker {
  private readonly servedRanges = new Map<string, string[]>();
  private readonly storedOutputs = new Map<string, string>();
  private outputCounter = 0;
  private readonly startedAt = new Date();

  constructor(private readonly root: string) {}

  listTools(): ToolDefinition[] {
    return [...TOOLS];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    let outcome: ToolOutcome;
    try {
      // Arguments are checked against the advertised schema first, so a handler never sees bad input.
      const definition = TOOLS.find((tool) => tool.name === name);
      const invalid = definition ? validateArgs(definition.inputSchema, args) : undefined;
      outcome = invalid !== undefined ? { text: invalid, isError: true } : await this.dispatch(name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { text: message, isError: true, blocked: error instanceof PolicyError };
    }

    // Only successful, non-blocked results get an estimate, so errors never claim savings.
    const returned = estimateTokens(outcome.text);
    const measured = !outcome.isError && !outcome.blocked && outcome.estimate !== false;
    const baseline = measured ? (outcome.baselineTokens ?? returned) : undefined;
    if (baseline !== undefined) {
      outcome = { ...outcome, text: `${outcome.text}\n${formatFooter(returned, baseline)}` };
    }

    try {
      await appendAuditEntry(this.root, {
        tool: name,
        inputTokens: estimateTokens(JSON.stringify(args)),
        outputTokens: estimateTokens(outcome.text),
        files: outcome.files ?? [],
        redactions: outcome.redactions ?? [],
        blocked: outcome.blocked ?? false,
        ...(baseline !== undefined ? { baselineTokens: baseline, savedTokens: baseline - returned } : {}),
        ...(outcome.route ? { route: outcome.route } : {})
      });
    } catch (error) {
      // The audit log must not break a tool call; report the failure on stderr, which MCP does not use.
      process.stderr.write(`Tokio audit write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return outcome;
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case 'refine_task':
        return this.refineTask(args);
      case 'repo_map':
        return this.repoMap(args);
      case 'read_symbol':
        return this.readSymbol(args);
      case 'search_output':
        return this.searchOutput(args);
      case 'session_stats':
        return this.sessionStats();
      case 'route_task':
        return this.routeTask(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private refineTask(args: Record<string, unknown>): ToolOutcome {
    const rawTask = requireString(args, 'task');
    const redacted = redactSecrets(rawTask);
    const category = optionalEnum(args, 'category', CATEGORIES)
      ?? classifyWorkCategory(redacted.text).category;
    const result = refinePrompt({
      rawPrompt: redacted.text,
      target: optionalEnum(args, 'target', TARGETS) ?? 'claude',
      mode: optionalEnum(args, 'mode', MODES),
      category,
      targetPath: optionalString(args, 'targetPath')
    });

    const note = redacted.redactions.length > 0
      ? `Redacted ${redacted.redactions.length} secret value(s): ${[...new Set(redacted.redactions)].join(', ')}.\n\n`
      : '';
    // Baseline is the raw task, so a refined prompt that grows shows as added tokens.
    return {
      text: `${note}${result.refinedPrompt}`,
      redactions: redacted.redactions,
      baselineTokens: estimateTokens(rawTask)
    };
  }

  private async repoMap(args: Record<string, unknown>): Promise<ToolOutcome> {
    const task = requireString(args, 'task');
    const budgetTokens = optionalInteger(args, 'budgetTokens', DEFAULT_BUDGET_TOKENS, 200, MAX_BUDGET_TOKENS);
    const scan = await scanRepository(this.root);
    const map = buildRepoMap(scan.files, {
      task,
      targetPath: optionalString(args, 'targetPath'),
      budgetTokens,
      coChange: scan.coChange
    });

    const notes = [
      scan.truncated ? `scan stopped at ${scan.files.length} files` : undefined,
      map.omittedFiles > 0 ? `${map.omittedFiles} ranked files omitted by budget` : undefined
    ].filter((note): note is string => note !== undefined);
    const footer = `[${map.tokens} tokens${notes.length > 0 ? `; ${notes.join('; ')}` : ''}]`;
    // Baseline: the full text of every file the map lists, which is what reading them would cost.
    const listed = new Set(map.files);
    const baselineTokens = scan.files
      .filter((file) => listed.has(file.path))
      .reduce((total, file) => total + estimateTokens(file.content), 0);
    return { text: `${map.text}\n${footer}`, files: map.files, baselineTokens };
  }

  private async readSymbol(args: Record<string, unknown>): Promise<ToolOutcome> {
    const requested = requireString(args, 'path');
    const startLine = optionalInteger(args, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER);
    const explicitEnd = optionalInteger(args, 'endLine', 0, 0, Number.MAX_SAFE_INTEGER);
    const full = args.full === true;

    const { absolute, relative } = await resolveRepoPath(this.root, requested);
    const content = await readFile(absolute, 'utf8');
    const lines = content.split(/\r?\n/);
    // Baseline: a full-file read of the same file.
    const baselineTokens = estimateTokens(content);
    if (startLine > lines.length) {
      throw new Error(`startLine ${startLine} is past the end of ${relative} (${lines.length} lines).`);
    }

    const naturalEnd = explicitEnd > 0
      ? Math.min(explicitEnd, lines.length)
      : nextSymbolLine(content, relative, startLine) ?? lines.length;
    if (naturalEnd < startLine) {
      throw new Error('endLine must be at least startLine.');
    }
    const end = Math.min(naturalEnd, startLine + MAX_READ_LINES - 1);
    const body = lines.slice(startLine - 1, end);
    const key = `${relative}:${startLine}-${end}`;

    const previous = this.servedRanges.get(key);
    this.servedRanges.set(key, body);
    if (previous && !full) {
      const text = sameLines(previous, body)
        ? `Unchanged since the last read of ${key} in this session. Pass full: true to receive it again.`
        : `Changed since the last read of ${key}; showing changed lines only.\n${diffLines(previous, body, startLine)}`;
      return { text, files: [relative], baselineTokens };
    }

    let text = body.map((line, index) => `${startLine + index}| ${line}`).join('\n');
    if (naturalEnd > end) {
      const outputId = this.storeOutput(lines.slice(startLine - 1, naturalEnd).join('\n'));
      text += `\n[Truncated at ${MAX_READ_LINES} lines. Lines ${end + 1}-${naturalEnd} stored as output ${outputId}; use search_output.]`;
    }
    return { text, files: [relative], baselineTokens };
  }

  private searchOutput(args: Record<string, unknown>): ToolOutcome {
    const id = requireString(args, 'id');
    const query = requireString(args, 'query');
    const limit = optionalInteger(args, 'limit', 3, 1, 10);
    const stored = this.storedOutputs.get(id);
    if (stored === undefined) {
      throw new Error(`No stored output with id ${id}. It may have expired when the server restarted.`);
    }

    const chunks = chunkText(stored);
    const terms = extractSearchTerms(query);
    const ranked = chunks
      .map((chunk, index) => ({ chunk, index, hits: terms.length > 0 ? countTermHits(chunk, terms) : 0 }))
      .filter((entry) => terms.length === 0 || entry.hits > 0)
      .sort((left, right) => right.hits - left.hits || left.index - right.index)
      .slice(0, limit);

    const parts: string[] = [];
    let tokens = 0;
    for (const entry of ranked) {
      const part = `[chunk ${entry.index + 1}/${chunks.length}]\n${entry.chunk}`;
      tokens += estimateTokens(part);
      if (tokens > MAX_SEARCH_RESULT_TOKENS) {
        break;
      }
      parts.push(part);
    }

    return {
      text: parts.length > 0 ? parts.join('\n\n') : `No stored chunks matched "${query}".`,
      baselineTokens: estimateTokens(stored)
    };
  }

  /**
   * Advisory routing only. The task is redacted before analysis, and the result carries no savings
   * estimate, because it changes nothing the agent reads.
   */
  private async routeTask(args: Record<string, unknown>): Promise<ToolOutcome> {
    const task = redactSecrets(requireString(args, 'task')).text;
    const targetPath = optionalString(args, 'targetPath');
    const scan = await scanRepository(this.root);
    const relevantFiles = findRelevantFiles(scan.files, task, targetPath);
    const classification = classifyWorkCategory(task);
    const plan = planRoute({
      task,
      relevantFiles,
      category: classification.category,
      categoryConfidence: classification.confidence
    });

    const rootNames = new Set(await readdir(this.root));
    const packageJson = rootNames.has('package.json')
      ? await readFile(join(this.root, 'package.json'), 'utf8')
      : undefined;
    const validation = detectValidationCommands({ packageJson, rootPaths: rootNames });

    return {
      text: formatRoutePlan(plan, validation),
      files: relevantFiles.slice(0, 20),
      route: { tier: plan.tier, confidence: plan.confidence },
      estimate: false
    };
  }

  /** Summarizes audit entries written since this server started. Its own result carries no estimate. */
  private async sessionStats(): Promise<ToolOutcome> {
    const entries = (await readAuditEntries(this.root))
      .filter((entry) => new Date(entry.timestamp) >= this.startedAt);
    return { text: formatStats(summarizeAudit(entries), 'this session'), estimate: false };
  }

  private storeOutput(text: string): string {
    this.outputCounter += 1;
    const id = `out-${this.outputCounter}`;
    this.storedOutputs.set(id, text);
    if (this.storedOutputs.size > MAX_STORED_OUTPUTS) {
      const oldest = this.storedOutputs.keys().next().value;
      if (oldest !== undefined) {
        this.storedOutputs.delete(oldest);
      }
    }
    return id;
  }
}

/** Line of the next top-level symbol after startLine, minus one, so a body stops before it. */
function nextSymbolLine(content: string, path: string, startLine: number): number | undefined {
  const next = extractSymbols(content, path).find((symbol) => symbol.line > startLine);
  return next ? next.line - 1 : undefined;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * Line diff for one range. Trims the common prefix and suffix, so the output is a single hunk
 * that may include unchanged lines between separate edits. It is correct, but not minimal.
 */
function diffLines(previous: readonly string[], current: readonly string[], startLine: number): string {
  const shortest = Math.min(previous.length, current.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === current[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === current[current.length - 1 - suffix]) {
    suffix += 1;
  }

  const removed = previous.slice(prefix, previous.length - suffix);
  const added = current.slice(prefix, current.length - suffix);
  return [
    `@@ line ${startLine + prefix} @@`,
    ...removed.map((line) => `- ${line}`),
    ...added.map((line) => `+ ${line}`)
  ].join('\n');
}

function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length > CHUNK_CHARS) {
      chunks.push(current);
      current = '';
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** First problem with args under a tool's inputSchema, as text for the agent, or undefined when valid. */
function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const required = (schema.required ?? []) as readonly string[];
  for (const field of required) {
    if (args[field] === undefined) {
      return `Invalid input: ${field} is required.`;
    }
  }
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const [field, rule] of Object.entries(properties)) {
    const value = args[field];
    if (value === undefined || rule.type === undefined) {
      continue;
    }
    if (!matchesType(value, rule.type)) {
      const article = /^[aeiou]/.test(rule.type) ? 'an' : 'a';
      return `Invalid input: ${field} must be ${article} ${rule.type} (got ${JSON.stringify(value)}).`;
    }
  }
  return undefined;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return typeof value === type;
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function optionalEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function optionalInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

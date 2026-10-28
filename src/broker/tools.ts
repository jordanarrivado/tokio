import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refinePrompt } from '../core/refine';
import { classifyWorkCategory } from '../core/category';
import type { Mode, PromptTarget, WorkCategory } from '../core/types';
import { countTermHits, extractSearchTerms } from '../context/discovery';
import { buildRepoMap, extractSymbols, symbolName, type RepoFile } from '../context/repomap';
import { formatMapRouting, MAP_PATH, rankMapAreas, type MapRouting } from '../context/archmap';
import { loadArchitectureMap, resolveAgainstRepo } from './mapfile';
import { estimateTokens } from '../core/tokens';
import { appendAuditEntry } from './audit';
import { findMissingRepos, formatCatalog, loadCatalog } from './catalog';
import { PolicyError, redactSecrets, resolveRepoPath } from './policy';
import { displayPath, formatRepoRoute, narrowScan, pickReposForTask, repoOf, reposOf, scanNotes, scanSelection, scopeIn, selectRepo, selectRepos } from './repos';
import { MAX_SCANNED_FILES } from './scan';
import { formatFooter, formatStats, formatTokens, readAuditEntries, summarizeAudit } from './stats';
import { detectValidationCommands } from '../context/project';
import { findRelevantFiles, formatRoutePlan, planRoute } from '../context/routing';
import { ASK_TIMEOUT_MS, buildAskPrompt, MAX_ANSWER_CHARS, parseAnswer, runAnswerAgent } from './ask';
import { ownRepo, readConnections, resolveRepoName } from './messaging';
import { readSavedOutput } from './compact';

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
  /** Set when the call did not finish normally. Recorded as the audit entry's outcome. */
  ended?: 'timeout' | 'cancelled';
  /** Catalog repositories the result drew on, for the audit log. Only with more than one repository. */
  repos?: string[];
}

const MODES: readonly Mode[] = ['minimal', 'adaptive', 'strict'];
const TARGETS: readonly PromptTarget[] = ['generic', 'claude', 'codex'];
const CATEGORIES: readonly WorkCategory[] = [
  'general', 'bug', 'hotfix', 'feature', 'enhancement', 'ui', 'refactor', 'performance',
  'tests', 'documentation', 'investigation', 'decision', 'planning', 'workflow', 'security', 'migration', 'dependency',
  'review', 'other'
];

const DEFAULT_BUDGET_TOKENS = 1500;
const MAX_BUDGET_TOKENS = 8000;
const MAX_READ_LINES = 200;
const MAX_SEARCH_RESULT_TOKENS = 1500;
const CHUNK_CHARS = 800;
const MAX_STORED_OUTPUTS = 20;
const TOOL_TIMEOUT_MS = 10_000;
const MAX_SYMBOL_HITS = 10;

const CANCELLED: ToolOutcome = { text: 'Cancelled.', isError: true, ended: 'cancelled' };
const timedOut = (timeoutMs: number, hint: string): ToolOutcome => ({
  text: `Timed out after ${timeoutMs / 1000}s. ${hint}`,
  isError: true,
  ended: 'timeout'
});
/** ask_repo runs a whole agent, so it gets minutes instead of the seconds a local lookup gets. */
const TIMEOUTS: Record<string, { ms: number; hint: string }> = {
  ask_repo: { ms: ASK_TIMEOUT_MS, hint: 'Ask a narrower question.' }
};
const DEFAULT_TIMEOUT = { ms: TOOL_TIMEOUT_MS, hint: 'Narrow targetPath or the request.' };

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
    description: 'Ranked repository map of files and top-level signatures (with line numbers) for a task, within a token budget. '
      + `Uses the repository's architecture map (${MAP_PATH}) when it exists, so matched routes come first with exact lines; mapPath picks another map.`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        repo: { type: 'string' },
        targetPath: { type: 'string' },
        mapPath: { type: 'string', description: `Workspace-relative architecture map (.md). Defaults to ${MAP_PATH}.` },
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
        repo: { type: 'string' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        full: { type: 'boolean' }
      },
      required: ['path']
    }
  },
  {
    name: 'search_output',
    description: 'Search the rest of a truncated read or a compacted command output by its output id.',
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
        repo: { type: 'string' },
        targetPath: { type: 'string' }
      },
      required: ['task']
    }
  },
  {
    name: 'find_symbol',
    description: 'Find a top-level definition by name. Returns path:line and signature; then use read_symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        repo: { type: 'string' },
        targetPath: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SYMBOL_HITS }
      },
      required: ['name']
    }
  },
  {
    name: 'list_repositories',
    description: 'List the local repositories in this workspace: name, path, purpose, write target or read-only, and merge order.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'ask_repo',
    description: 'Ask another catalog repository\'s agent a question and get its answer. Runs a read-only agent in that repository; takes up to 3 minutes. Use when a prompt starts with ~name: and you cannot SendMessage to an open session.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository name, folder name, or one part of the name, such as api.' },
        question: { type: 'string' }
      },
      required: ['repo', 'question']
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

  /** cancel aborts the call: it resolves at once with outcome 'cancelled'. */
  async callTool(name: string, args: Record<string, unknown>, cancel?: AbortSignal): Promise<ToolOutcome> {
    let outcome: ToolOutcome;
    try {
      // Arguments are checked against the advertised schema first, so a handler never sees bad input.
      const definition = TOOLS.find((tool) => tool.name === name);
      const invalid = definition
        ? validateArgs(definition.inputSchema, args)
        : `Unknown tool: ${name}. Valid tools: ${TOOLS.map((tool) => tool.name).join(', ')}.`;
      outcome = invalid !== undefined ? { text: invalid, isError: true } : await this.dispatchWithTimeout(name, args, cancel);
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
        ...(outcome.route ? { route: outcome.route } : {}),
        ...(outcome.ended ? { outcome: outcome.ended } : {}),
        ...(outcome.repos && outcome.repos.length > 0 ? { repos: outcome.repos } : {})
      });
    } catch (error) {
      // The audit log must not break a tool call; report the failure on stderr, which MCP does not use.
      process.stderr.write(`Tokio audit write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    return outcome;
  }

  /**
   * Runs the handler with a signal that aborts on timeout or when the caller's signal aborts.
   * Either one resolves the call at once, so a stuck handler cannot hold the caller.
   */
  private async dispatchWithTimeout(name: string, args: Record<string, unknown>, cancel?: AbortSignal): Promise<ToolOutcome> {
    // Cancelled while still queued: the handler never runs.
    if (cancel?.aborted) {
      return CANCELLED;
    }
    const controller = new AbortController();
    let stop: (outcome: ToolOutcome) => void = () => {};
    const stopped = new Promise<ToolOutcome>((resolve) => {
      stop = (outcome) => {
        controller.abort();
        resolve(outcome);
      };
    });
    const timeout = TIMEOUTS[name] ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => stop(timedOut(timeout.ms, timeout.hint)), timeout.ms);
    const onCancel = (): void => stop(CANCELLED);
    cancel?.addEventListener('abort', onCancel, { once: true });
    try {
      return await Promise.race([this.dispatch(name, args, controller.signal), stopped]);
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
    }
  }

  private async dispatch(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    switch (name) {
      case 'refine_task':
        return this.refineTask(args);
      case 'repo_map':
        return this.repoMap(args, signal);
      case 'read_symbol':
        return this.readSymbol(args, signal);
      case 'search_output':
        return this.searchOutput(args);
      case 'session_stats':
        return this.sessionStats();
      case 'route_task':
        return this.routeTask(args, signal);
      case 'find_symbol':
        return this.findSymbol(args, signal);
      case 'list_repositories':
        return this.listRepositories(signal);
      case 'ask_repo':
        return this.askRepo(args, signal);
      default:
        // callTool rejects unknown names before dispatch; this only guards the switch.
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private refineTask(args: Record<string, unknown>): ToolOutcome {
    const rawTask = requireString(args, 'task');
    const redacted = redactSecrets(rawTask);
    const manualCategory = args.category as WorkCategory | undefined;
    const classification = classifyWorkCategory(redacted.text);
    const category = manualCategory ?? classification.category;
    const result = refinePrompt({
      rawPrompt: redacted.text,
      target: (args.target as PromptTarget | undefined) ?? 'claude',
      mode: args.mode as Mode | undefined,
      category,
      additionalCategories: manualCategory ? undefined : classification.additional,
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

  private async repoMap(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const task = requireString(args, 'task');
    const budgetTokens = optionalInteger(args, 'budgetTokens', DEFAULT_BUDGET_TOKENS);
    const repo = optionalString(args, 'repo');
    const targetPath = optionalString(args, 'targetPath');
    const selection = await selectRepos(this.root, repo, signal);
    const fullScan = await scanSelection(selection, { signal });
    const { multi, catalog } = selection;
    // Without a repo, the map covers only the repositories the task is about. repo: "*" keeps them all.
    const picked = multi && repo === undefined ? pickReposForTask(selection, fullScan.files, task) : undefined;
    const scan = picked ? narrowScan(fullScan, picked) : fullScan;
    const mapPath = optionalString(args, 'mapPath');
    const writeRepo = catalog.repos.find((candidate) => candidate.name === catalog.defaultRepo);
    const routing = await this.routeFromMap(mapPath, task, fullScan.files, {
      root: writeRepo?.path ?? this.root,
      ...(multi ? { prefix: catalog.defaultRepo } : {})
    }, signal);
    const map = buildRepoMap(scan.files, {
      task,
      // With one repository the target is matched as given, as before catalogs existed.
      targetPath: multi && targetPath !== undefined ? scopeIn(selection, repo, targetPath) : targetPath,
      budgetTokens,
      coChange: scan.coChange,
      pinnedPaths: routing?.anchors.map((anchor) => anchor.path),
      ...(multi ? { edges: scan.edges, preferPrefix: `${catalog.defaultRepo}/`, formatPath: (path: string) => displayPath(true, path) } : {})
    });

    const notes = [
      picked ? `repos ${picked.join(', ')} picked for this task; pass repo: "*" for all` : undefined,
      ...scanNotes(selection, scan, MAX_SCANNED_FILES),
      map.omittedFiles > 0 ? `${map.omittedFiles} ranked files omitted by budget` : undefined
    ].filter((note): note is string => note !== undefined);
    const footer = `[${map.tokens} tokens${notes.length > 0 ? `; ${notes.join('; ')}` : ''}]`;
    const routed = routing ? `${formatMapRouting(routing, (path) => displayPath(multi, path))}\n\n` : '';
    // Baseline: the full text of every file the map lists, which is what reading them would cost.
    const listed = new Set([...map.files, ...(routing?.anchors.map((anchor) => anchor.path) ?? [])]);
    const baselineTokens = fullScan.files
      .filter((file) => listed.has(file.path))
      .reduce((total, file) => total + estimateTokens(file.content), 0);
    return { text: `${routed}${map.text}\n${footer}`, files: [...listed], baselineTokens, repos: reposOf(multi, [...listed]) };
  }

  /**
   * Routes the task through an architecture map: the write target's own map by default, or mapPath in this
   * workspace. The map and every routed file go through the same path policy as read_symbol. Without a default
   * map, or when no area matches, the result is undefined and repo_map is unchanged. An explicit map always reports.
   */
  private async routeFromMap(
    mapPath: string | undefined,
    task: string,
    files: readonly RepoFile[],
    target: { root: string; prefix?: string },
    signal: AbortSignal
  ): Promise<MapRouting | undefined> {
    const map = await loadArchitectureMap(mapPath === undefined ? target.root : this.root, mapPath, signal);
    if (!map) {
      return undefined;
    }
    if (map.areas.length === 0) {
      if (mapPath === undefined) {
        return undefined;
      }
      throw new Error(`${map.path} has no areas. Use "## Area" headings with "- label -> path#symbol" lines.`);
    }
    const routing = await resolveAgainstRepo(rankMapAreas(map.areas, task), files, target, task, signal);
    return routing.areas.length > 0 || mapPath !== undefined ? routing : undefined;
  }

  private async readSymbol(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const requested = requireString(args, 'path');
    const startLine = optionalInteger(args, 'startLine', 1);
    // 0 means no explicit end; the schema already rejects an endLine below 1.
    const explicitEnd = optionalInteger(args, 'endLine', 0);
    const full = args.full === true;

    const { repo, multi } = await selectRepo(this.root, optionalString(args, 'repo'), signal);
    const { absolute, relative } = await resolveRepoPath(repo.path, requested);
    // With several repositories the repository is part of the key, so the same path in two of them never reads as unchanged.
    const shown = multi ? `[${repo.name}] ${relative}` : relative;
    const audited = multi ? `${repo.name}/${relative}` : relative;
    const content = await readFile(absolute, { encoding: 'utf8', signal });
    const lines = content.split(/\r?\n/);
    // Baseline: a full-file read of the same file.
    const baselineTokens = estimateTokens(content);
    if (startLine > lines.length) {
      throw new Error(`startLine ${startLine} is past the end of ${shown} (${lines.length} lines).`);
    }

    const naturalEnd = explicitEnd > 0
      ? Math.min(explicitEnd, lines.length)
      : nextSymbolLine(content, relative, startLine) ?? lines.length;
    if (naturalEnd < startLine) {
      throw new Error('endLine must be at least startLine.');
    }
    const end = Math.min(naturalEnd, startLine + MAX_READ_LINES - 1);
    const body = lines.slice(startLine - 1, end);
    const key = `${shown}:${startLine}-${end}`;

    const previous = this.servedRanges.get(key);
    this.servedRanges.set(key, body);
    if (previous && !full) {
      const text = sameLines(previous, body)
        ? `Unchanged since the last read of ${key} in this session. Pass full: true to receive it again.`
        : `Changed since the last read of ${key}; showing changed lines only.\n${diffLines(previous, body, startLine)}`;
      return { text, files: [audited], baselineTokens, repos: reposOf(multi, [audited]) };
    }

    let text = body.map((line, index) => `${startLine + index}| ${line}`).join('\n');
    if (naturalEnd > end) {
      const outputId = this.storeOutput(lines.slice(startLine - 1, naturalEnd).join('\n'));
      text += `\n[Truncated at ${MAX_READ_LINES} lines. Lines ${end + 1}-${naturalEnd} stored as output ${outputId}; use search_output.]`;
    }
    return { text, files: [audited], baselineTokens, repos: reposOf(multi, [audited]) };
  }

  private async searchOutput(args: Record<string, unknown>): Promise<ToolOutcome> {
    const id = requireString(args, 'id');
    const query = requireString(args, 'query');
    const limit = optionalInteger(args, 'limit', 3);
    // run- ids are command outputs the PostToolUse hook saved to disk.
    const stored = this.storedOutputs.get(id) ?? await readSavedOutput(id);
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
   * Top-level symbols ranked against a name: exact, then case-insensitive, then prefix. Ties put the
   * default repository first, then sort by path.
   */
  private async findSymbol(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const name = requireString(args, 'name');
    const limit = optionalInteger(args, 'limit', MAX_SYMBOL_HITS);
    const repo = optionalString(args, 'repo');
    const targetPath = optionalString(args, 'targetPath');
    const selection = await selectRepos(this.root, repo, signal);
    const { multi, catalog } = selection;
    const scope = targetPath === undefined ? '' : scopeIn(selection, repo, targetPath);
    const scan = await scanSelection(selection, { signal, history: false, edges: false });
    const preferred = (path: string): number => (multi && repoOf(path) === catalog.defaultRepo ? 1 : 0);
    const inScope = scan.files
      .filter((file) => scope === '' || file.path === scope || file.path.startsWith(`${scope}/`));
    const symbolsIn = (files: readonly RepoFile[]) => files.flatMap((file) => extractSymbols(file.content, file.path)
      .map((symbol) => ({ file, ...symbol, name: symbolName(symbol.signature) })));

    // Every hit's name contains the query ignoring case, so only files containing it need parsing.
    const query = name.toLowerCase();
    const hits = symbolsIn(inScope.filter((file) => file.content.toLowerCase().includes(query)))
      .map((symbol) => ({ ...symbol, rank: rankSymbolName(symbol.name, name) }))
      .filter((hit) => hit.rank >= 0)
      .sort((left, right) => left.rank - right.rank
        || preferred(right.file.path) - preferred(left.file.path)
        || left.file.path.localeCompare(right.file.path)
        || left.line - right.line);
    if (hits.length === 0) {
      const close = closeNames([...new Set(symbolsIn(inScope).map((symbol) => symbol.name))], name);
      throw new Error(`No symbol "${name}".${close.length > 0 ? ` Close names: ${close.join(', ')}.` : ''}`);
    }

    const shown = hits.slice(0, limit);
    const lines = shown.map((hit) => `${displayPath(multi, hit.file.path)}:${hit.line}  ${hit.signature}`);
    if (hits.length > shown.length) {
      lines.push(`${hits.length - shown.length} more; narrow with ${multi ? 'repo or targetPath' : 'targetPath'}`);
    }
    // Baseline: reading every file with a shown hit in full.
    const files = [...new Set(shown.map((hit) => hit.file))];
    return {
      text: lines.join('\n'),
      files: files.map((file) => file.path),
      repos: reposOf(multi, files.map((file) => file.path)),
      baselineTokens: files.reduce((total, file) => total + estimateTokens(file.content), 0)
    };
  }

  /**
   * Advisory routing only. The task is redacted before analysis, and the result carries no savings
   * estimate, because it changes nothing the agent reads.
   */
  private async routeTask(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const task = redactSecrets(requireString(args, 'task')).text;
    const repo = optionalString(args, 'repo');
    const targetPath = optionalString(args, 'targetPath');
    const selection = await selectRepos(this.root, repo, signal);
    const { multi, catalog } = selection;
    const scan = await scanSelection(selection, { signal, history: false, edges: false });
    const target = multi && targetPath !== undefined ? scopeIn(selection, repo, targetPath) : targetPath;
    const relevantFiles = findRelevantFiles(scan.files, task, target);
    const classification = classifyWorkCategory(task);
    const plan = planRoute({
      task,
      relevantFiles,
      category: classification.category,
      categoryConfidence: classification.confidence
    });

    // Validation runs in the write target. A missing write target has no commands to detect.
    const writeRepo = catalog.repos.find((candidate) => candidate.name === catalog.defaultRepo);
    const writeRoot = writeRepo && !selection.skipped.includes(writeRepo.name) ? writeRepo.path : undefined;
    const rootNames = new Set(writeRoot ? await readdir(writeRoot) : []);
    const packageJson = writeRoot && rootNames.has('package.json')
      ? await readFile(join(writeRoot, 'package.json'), 'utf8')
      : undefined;
    const validation = detectValidationCommands({ packageJson, rootPaths: rootNames });

    const planText = formatRoutePlan(plan, validation);
    return {
      text: multi ? `${planText}\n${formatRepoRoute(catalog, relevantFiles)}` : planText,
      files: relevantFiles.slice(0, 20),
      repos: reposOf(multi, relevantFiles),
      route: { tier: plan.tier, confidence: plan.confidence },
      estimate: false
    };
  }

  /** Summarizes audit entries written since this server started. Its own result carries no estimate. */
  private async sessionStats(): Promise<ToolOutcome> {
    const all = await readAuditEntries(this.root);
    const session = all.filter((entry) => new Date(entry.timestamp) >= this.startedAt);
    // The audit log survives restarts, so the all-time total is shown beside the session total.
    const lifetime = summarizeAudit(all);
    const sign = lifetime.savedTokens < 0 ? '-' : '+';
    const text = [
      formatStats(summarizeAudit(session), 'this session'),
      `All recorded calls for this project: ${lifetime.calls}, estimated net saved ${sign}${formatTokens(Math.abs(lifetime.savedTokens))}. Run tokio stats for detail.`
    ].join('\n');
    return { text, estimate: false };
  }

  /**
   * Catalog summaries only, the first step of a task across repositories. The result carries no
   * savings estimate, because it replaces no file read.
   */
  private async listRepositories(signal: AbortSignal): Promise<ToolOutcome> {
    const catalog = await loadCatalog(this.root, signal);
    const missing = await findMissingRepos(catalog);
    return { text: formatCatalog(catalog, missing), estimate: false };
  }

  /** Starts the answering agent. A field, so tests can run ask_repo without a real agent. */
  runAgent = runAnswerAgent;

  /**
   * Relays a question to another repository's agent. The same messaging switch as SendMessage applies,
   * so an agent without SendMessage gets no way around it.
   */
  private async askRepo(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const name = requireString(args, 'repo');
    const question = requireString(args, 'question').trim();
    const catalog = await loadCatalog(this.root, signal);
    const matches = resolveRepoName(catalog, name);
    if (matches.length !== 1) {
      const known = catalog.repos.map((repo) => repo.name).join(', ');
      return {
        text: matches.length === 0
          ? `No repository is called "${name}". Repositories: ${known}.`
          : `"${name}" matches ${matches.map((repo) => repo.name).join(', ')}. Pass the full name.`,
        isError: true,
        estimate: false
      };
    }
    const [peer] = matches;
    const own = ownRepo(catalog, this.root);
    if (peer.name === own.name) {
      return { text: `${peer.name} is this repository. Answer the question yourself.`, isError: true, estimate: false };
    }
    if (question === '') {
      return { text: 'The question is empty.', isError: true, estimate: false };
    }
    if (!(await readConnections(own.path)).includes(peer.name)) {
      return {
        text: `Messaging with ${peer.name} is off. Ask the user to switch it on for ${peer.name} on the tokio repository map.`,
        isError: true,
        blocked: true,
        estimate: false,
        repos: [peer.name]
      };
    }
    if ((await findMissingRepos(catalog)).has(peer.name)) {
      return { text: `Repository folder not found: ${peer.path}.`, isError: true, estimate: false };
    }

    // The question is the user's own text, but it leaves this session, so it is redacted like a refined prompt.
    const asked = redactSecrets(question);
    const run = await this.runAgent(peer.path, buildAskPrompt(peer, own.name, asked.text), signal);
    const answer = parseAnswer(run.stdout);
    if (answer.isError && run.exitCode !== 0 && run.stderr.trim() !== '') {
      answer.text = `${answer.text}\n${run.stderr.trim().slice(0, 500)}`;
    }
    const redacted = redactSecrets(answer.text);
    const text = redacted.text.length > MAX_ANSWER_CHARS
      ? `${redacted.text.slice(0, MAX_ANSWER_CHARS)}\n[Answer cut at ${MAX_ANSWER_CHARS} characters.]`
      : redacted.text;
    return {
      text: `Answer from the ${peer.name} agent:\n\n${text}`,
      isError: answer.isError,
      redactions: [...asked.redactions, ...redacted.redactions],
      estimate: false,
      repos: [peer.name]
    };
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

/** 0 exact, 1 exact ignoring case, 2 prefix ignoring case, -1 no match. */
function rankSymbolName(candidate: string, wanted: string): number {
  if (candidate === wanted) {
    return 0;
  }
  const lower = candidate.toLowerCase();
  const target = wanted.toLowerCase();
  if (lower === target) {
    return 1;
  }
  return lower.startsWith(target) ? 2 : -1;
}

/** Up to 3 names within edit distance 2 of wanted or containing it, ignoring case; nearest first. */
function closeNames(names: readonly string[], wanted: string): string[] {
  const target = wanted.toLowerCase();
  return names
    .filter((name) => name.length > 0)
    .map((name) => ({ name, distance: editDistance(name.toLowerCase(), target) }))
    .filter((entry) => entry.distance <= 2 || entry.name.toLowerCase().includes(target))
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, 3)
    .map((entry) => entry.name);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
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

/** The subset of JSON Schema that TOOLS uses for a property. */
interface PropertyRule {
  type: string;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
}

/** First problem with args under a tool's inputSchema, as text for the agent, or undefined when valid. */
function validateArgs(schema: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const required = (schema.required ?? []) as readonly string[];
  for (const field of required) {
    if (args[field] === undefined) {
      return `Invalid input: ${field} is required.`;
    }
  }
  const properties = (schema.properties ?? {}) as Record<string, PropertyRule>;
  for (const [field, rule] of Object.entries(properties)) {
    const value = args[field];
    if (value === undefined) {
      continue;
    }
    const got = `(got ${JSON.stringify(value)})`;
    if (!matchesType(value, rule.type)) {
      const article = /^[aeiou]/.test(rule.type) ? 'an' : 'a';
      return `Invalid input: ${field} must be ${article} ${rule.type} ${got}.`;
    }
    if (rule.enum && !rule.enum.includes(value)) {
      return `Invalid input: ${field} must be one of: ${rule.enum.join(', ')} ${got}.`;
    }
    const tooLow = rule.minimum !== undefined && (value as number) < rule.minimum;
    const tooHigh = rule.maximum !== undefined && (value as number) > rule.maximum;
    if (tooLow || tooHigh) {
      const range = rule.maximum === undefined ? `of at least ${rule.minimum}` : `from ${rule.minimum} to ${rule.maximum}`;
      return `Invalid input: ${field} must be an integer ${range} ${got}.`;
    }
  }
  return undefined;
}

function matchesType(value: unknown, type: string): boolean {
  return type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === type;
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

/** Type and range are already checked by validateArgs against the schema; this only applies the default. */
function optionalInteger(args: Record<string, unknown>, key: string, fallback: number): number {
  return (args[key] as number | undefined) ?? fallback;
}

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { estimateTokens } from '../core/tokens';
import { SECRET_DENY_PATTERNS } from '../context/discovery';
import { redactSecrets } from './policy';

const execFileAsync = promisify(execFile);

export interface BenchTask {
  id: string;
  task: string;
  /** Shell command run in the run's workspace after the agent exits. Exit code 0 means the task passed. */
  verify?: string;
  /**
   * A fix commit to rebuild the task from, SWE-bench style: the code starts at the commit's parent and the
   * commit's own test files are checked out on top, so verify runs the tests that the fix made pass.
   */
  commit?: string;
  /** Test files to take from the commit. Defaults to the files it changed under a tests folder. */
  tests?: string[];
}

export interface AgentCommand {
  command: string;
  args: readonly string[];
}

/** Usage reported by a headless agent run. Null when the agent did not report the field. */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  isError: boolean;
}

export type BenchArm = 'raw' | 'tokio';

export interface BenchRun {
  taskId: string;
  arm: BenchArm;
  promptTokens: number;
  usage: AgentUsage;
  /** Result of the task's verify command. Null when the task has no verify command. */
  verified: boolean | null;
  /** Live mode, Tokio arm: calls per tool, read from the run's own audit log. */
  tokioCalls?: Record<string, number>;
}

/** Live mode: one task's runs per arm, as medians so one unusual run does not decide the result. */
export interface LiveTaskSummary {
  taskId: string;
  raw: { medianBillable: number; minBillable: number; maxBillable: number; passed: number; runs: number };
  tokio: { medianBillable: number; minBillable: number; maxBillable: number; passed: number; runs: number };
  /** Tokio median divided by raw median. Below 1 means fewer tokens with Tokio. */
  ratio: number | null;
}

export interface ArmSummary {
  runs: number;
  errors: number;
  promptTokens: number;
  /** Input, cache-creation, and output tokens. Cache reads are excluded because they are billed at a lower rate. */
  billableTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
  verifyPassed: number;
  verifyFailed: number;
}

export interface BenchSummary {
  raw: ArmSummary;
  tokio: ArmSummary;
  /** Tokio billable tokens divided by raw billable tokens. Below 1 means Tokio used fewer tokens. */
  billableRatio: number | null;
}

export interface BenchReport {
  generatedAt: string;
  agent: string;
  mode: BenchMode;
  runs: BenchRun[];
  summary: BenchSummary;
  /** Live mode only. */
  tasks?: LiveTaskSummary[];
}

/**
 * `prompt` compares the raw task text with the Tokio prompt under the same agent setup. `live` sends the same
 * task text to both arms and changes only the setup: no Tokio hooks or MCP server, or both.
 */
export type BenchMode = 'prompt' | 'live';

export interface BenchOptions {
  tasks: readonly BenchTask[];
  agent: AgentCommand;
  /**
   * Builds the prompt for the Tokio arm from the task text and the directory the agent will run in.
   * The raw arm always sends the task text unchanged.
   */
  buildTokioPrompt: (task: string, workspace: string) => Promise<string>;
  /** Git repository used for tasks with a verify command. Defaults to the current directory. */
  root?: string;
  /**
   * What verified runs start from. `head` (default) uses a git worktree at the last commit, so only committed
   * changes count. `working-tree` copies the directory as it is, including uncommitted changes.
   */
  workspaceSource?: 'head' | 'working-tree';
  repeats?: number;
  timeoutMs?: number;
  mode?: BenchMode;
  /** Live mode: the Tokio CLI the Tokio arm's hooks and MCP server run from. */
  cliPath?: string;
  /** Folders linked from the repository into each workspace, such as node_modules or vendor. */
  shared?: readonly string[];
  /**
   * Files copied from the repository into each workspace, such as an ignored test environment file.
   * The user names them; both arms get secret-file deny rules, and the Tokio arm's hook also blocks them.
   */
  copyFiles?: readonly string[];
  /** Called as each run or check starts, so a long bench shows where it is. */
  onProgress?: (line: string) => void;
}

export interface Workspace {
  path: string;
  dispose: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const COMMIT = /^[0-9a-f]{7,40}$/i;
/** Default test files taken from a fix commit: anything under a tests folder or named like a test. */
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[a-z]+$|Test\.php$/i;
/** Architecture map files a live workspace needs, copied from the repository even when they are not committed. */
const MAP_FILES = ['.tokio/map.md', '.tokio/map-prompts.json'];

/**
 * Parses a tasks file: a JSON array of `{ "task": string, "id"?: string, "verify"?: string }`.
 * A verify command runs in a fresh checkout of the repository's HEAD, so it checks committed state.
 */
export function parseBenchTasks(json: string): BenchTask[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('Tasks file must contain a JSON array.');
  }

  return parsed.map((item: unknown, index) => {
    if (!isRecord(item) || typeof item.task !== 'string' || item.task.trim().length === 0) {
      throw new Error(`Task ${index + 1} must be an object with a non-empty "task" string.`);
    }
    if (item.verify !== undefined && (typeof item.verify !== 'string' || item.verify.trim().length === 0)) {
      throw new Error(`Task ${index + 1} "verify" must be a non-empty command string.`);
    }
    if (item.commit !== undefined && (typeof item.commit !== 'string' || !COMMIT.test(item.commit))) {
      throw new Error(`Task ${index + 1} "commit" must be a commit hash.`);
    }
    if (item.commit !== undefined && item.verify === undefined) {
      throw new Error(`Task ${index + 1} has a "commit" but no "verify" command to check the fix with.`);
    }
    if (item.tests !== undefined && (!Array.isArray(item.tests) || item.tests.some((test) => typeof test !== 'string' || test.trim() === ''))) {
      throw new Error(`Task ${index + 1} "tests" must be an array of file paths.`);
    }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `task-${index + 1}`;
    return {
      id,
      task: item.task,
      ...(typeof item.verify === 'string' ? { verify: item.verify } : {}),
      ...(typeof item.commit === 'string' ? { commit: item.commit } : {}),
      ...(Array.isArray(item.tests) ? { tests: item.tests as string[] } : {})
    };
  });
}

/** Reads usage from `claude -p --output-format json` output (a result object, or an array ending in one). */
export function parseAgentUsage(output: string): AgentUsage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return emptyUsage(true);
  }

  const result = Array.isArray(parsed)
    ? [...parsed].reverse().find((item: unknown) => isRecord(item) && item.type === 'result')
    : parsed;
  if (!isRecord(result)) {
    return emptyUsage(true);
  }

  const usage = isRecord(result.usage) ? result.usage : {};
  return {
    inputTokens: numberOrNull(usage.input_tokens),
    outputTokens: numberOrNull(usage.output_tokens),
    cacheReadTokens: numberOrNull(usage.cache_read_input_tokens),
    cacheCreationTokens: numberOrNull(usage.cache_creation_input_tokens),
    costUsd: numberOrNull(result.total_cost_usd),
    turns: numberOrNull(result.num_turns),
    durationMs: numberOrNull(result.duration_ms),
    isError: result.is_error === true
  };
}

export function summarizeRuns(runs: readonly BenchRun[]): BenchSummary {
  const raw = summarizeArm(runs, 'raw');
  const tokio = summarizeArm(runs, 'tokio');
  const billableRatio = raw.billableTokens > 0
    ? Math.round((tokio.billableTokens / raw.billableTokens) * 1000) / 1000
    : null;
  return { raw, tokio, billableRatio };
}

/**
 * Runs every task twice per repeat: once with the raw task text and once with the Tokio prompt.
 * The prompt is sent to the agent on stdin, so task text is never placed on a command line.
 */
export async function runBench(options: BenchOptions): Promise<BenchReport> {
  const repeats = Math.max(1, options.repeats ?? 1);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const root = options.root ?? process.cwd();
  const runs: BenchRun[] = [];
  await pruneWorktrees(root);

  const total = options.tasks.length * repeats * 2;
  for (const task of options.tasks) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const arm of ['raw', 'tokio'] as const) {
        const label = options.mode === 'live' ? (arm === 'raw' ? 'off' : 'on') : arm;
        options.onProgress?.(`[${runs.length + 1}/${total}] ${task.id} ${label} (repeat ${repeat + 1}/${repeats})`);
        runs.push(await runArm(options, task, arm, root, timeoutMs));
      }
    }
  }

  const mode = options.mode ?? 'prompt';
  return {
    generatedAt: new Date().toISOString(),
    agent: options.agent.command,
    mode,
    runs,
    summary: summarizeRuns(runs),
    ...(mode === 'live' ? { tasks: summarizeLiveTasks(runs) } : {})
  };
}

/** Per task: median, lowest, and highest billable tokens per arm, verify passes, and the median ratio. */
export function summarizeLiveTasks(runs: readonly BenchRun[]): LiveTaskSummary[] {
  const ids = [...new Set(runs.map((run) => run.taskId))];
  return ids.map((taskId) => {
    const arm = (name: BenchArm) => {
      const own = runs.filter((run) => run.taskId === taskId && run.arm === name);
      const billable = own.map(billableOf).sort((left, right) => left - right);
      return {
        medianBillable: median(billable),
        minBillable: billable[0] ?? 0,
        maxBillable: billable.at(-1) ?? 0,
        passed: own.filter((run) => run.verified === true).length,
        runs: own.length
      };
    };
    const raw = arm('raw');
    const tokio = arm('tokio');
    return { taskId, raw, tokio, ratio: raw.medianBillable > 0 ? round3(tokio.medianBillable / raw.medianBillable) : null };
  });
}

/** One line per task, then the median of the per-task ratios and the pass rate per arm. */
export function formatLiveSummary(tasks: readonly LiveTaskSummary[]): string {
  const lines = ['Live bench: same task text; "off" has no Tokio hooks or MCP server, "on" has both.'];
  for (const task of tasks) {
    const arm = (label: string, value: LiveTaskSummary['raw']) =>
      `${label} median ${value.medianBillable} (${value.minBillable}-${value.maxBillable}) passed ${value.passed}/${value.runs}`;
    lines.push(`${task.taskId}: ${arm('off', task.raw)} | ${arm('on', task.tokio)} | ratio ${task.ratio ?? 'n/a'}`);
  }
  const ratios = tasks.map((task) => task.ratio).filter((ratio): ratio is number => ratio !== null).sort((left, right) => left - right);
  const passRate = (key: 'raw' | 'tokio') => {
    const runs = tasks.reduce((sum, task) => sum + task[key].runs, 0);
    const passed = tasks.reduce((sum, task) => sum + task[key].passed, 0);
    return runs > 0 ? `${passed}/${runs}` : 'n/a';
  };
  lines.push(`median ratio (on/off billable tokens): ${ratios.length > 0 ? median(ratios) : 'n/a'}; passed off ${passRate('raw')}, on ${passRate('tokio')}`);
  return lines.join('\n');
}

/**
 * Checks that each commit task is a fair test before any agent runs: the commit's tests must fail on the parent's
 * code and pass at the commit. A task that already passes before the fix measures nothing.
 */
export async function checkBenchTasks(
  options: Pick<BenchOptions, 'tasks' | 'root' | 'shared' | 'copyFiles' | 'timeoutMs' | 'onProgress'>
): Promise<{ taskId: string; ok: boolean; detail: string }[]> {
  const root = options.root ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: { taskId: string; ok: boolean; detail: string }[] = [];
  await pruneWorktrees(root);
  for (const [index, task] of options.tasks.entries()) {
    if (!task.commit || !task.verify) {
      results.push({ taskId: task.id, ok: true, detail: 'no commit; nothing to check' });
      continue;
    }
    options.onProgress?.(`[${index + 1}/${options.tasks.length}] ${task.id}: running verify before and at ${task.commit}`);
    const before = await createWorkspace(root, { ref: `${task.commit}^`, testsFrom: task.commit, tests: task.tests, shared: options.shared, copyFiles: options.copyFiles });
    const beforeRun = await runVerifyWithOutput(task.verify, before.path, timeoutMs).finally(() => before.dispose());
    const after = await createWorkspace(root, { ref: task.commit, shared: options.shared, copyFiles: options.copyFiles });
    const afterRun = await runVerifyWithOutput(task.verify, after.path, timeoutMs).finally(() => after.dispose());
    const failsBefore = !beforeRun.passed;
    const passesAfter = afterRun.passed;
    // A verify that fails at the fix commit usually means the environment is broken; its first error says how.
    const why = passesAfter ? '' : `\n    at the fix, verify printed:\n${indent(explainOutput(afterRun.output), '      ')}`;
    results.push({
      taskId: task.id,
      ok: failsBefore && passesAfter,
      detail: `before the fix: ${failsBefore ? 'fails (good)' : 'passes (task measures nothing)'}; at the fix: ${passesAfter ? 'passes (good)' : 'fails (verify command or environment is wrong)'}${why}`
    });
  }
  return results;
}

/** Agent flags for one live arm. Both arms get the same edit permission and secret-file deny rules. */
export async function liveArmArgs(arm: BenchArm, cliPath: string, workspace: string, configDirectory: string): Promise<string[]> {
  const cli = cliPath.replaceAll('\\', '/');
  const node = (subcommand: string) => `node ${/\s/.test(cli) ? `"${cli}"` : cli} ${subcommand}`;
  const deny = SECRET_DENY_PATTERNS.map((pattern) => `Read(${pattern})`);
  const mcp = arm === 'tokio'
    ? { mcpServers: { tokio: { command: 'node', args: [cli, 'mcp', '--root', workspace.replaceAll('\\', '/')] } } }
    : { mcpServers: {} };
  const settings = arm === 'tokio'
    ? {
      permissions: { deny },
      hooks: {
        PreToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell|SendMessage', hooks: [{ type: 'command', command: node('hook') }] }],
        PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: node('output-hook') }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: node('prompt-hook') }] }]
      }
    }
    // Without Tokio: no hooks at all, including any the repository's own settings register.
    : { permissions: { deny }, disableAllHooks: true };
  const mcpPath = join(configDirectory, `${arm}-mcp.json`);
  const settingsPath = join(configDirectory, `${arm}-settings.json`);
  await writeFile(mcpPath, JSON.stringify(mcp), 'utf8');
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8');
  return [
    '--strict-mcp-config', '--mcp-config', mcpPath,
    '--settings', settingsPath,
    '--permission-mode', 'acceptEdits',
    ...(arm === 'tokio' ? ['--allowedTools', 'mcp__tokio'] : [])
  ];
}

export function formatBenchSummary(summary: BenchSummary): string {
  const line = (label: string, arm: ArmSummary) => {
    const verified = arm.verifyPassed + arm.verifyFailed === 0
      ? 'n/a'
      : `${arm.verifyPassed}/${arm.verifyPassed + arm.verifyFailed}`;
    return `${label}: runs=${arm.runs} errors=${arm.errors} turns=${arm.turns} ` +
      `duration=${(arm.durationMs / 1000).toFixed(1)}s verified=${verified} ` +
      `promptTokens≈${arm.promptTokens} billableTokens=${arm.billableTokens} costUsd=${arm.costUsd.toFixed(4)}`;
  };
  const ratio = summary.billableRatio === null ? 'n/a' : summary.billableRatio.toFixed(3);
  return [line('raw  ', summary.raw), line('tokio', summary.tokio), `billable ratio (tokio/raw): ${ratio}`].join('\n');
}

/** Runs one arm of one task. Tasks with a verify command get their own workspace, removed afterwards. */
async function runArm(
  options: BenchOptions,
  task: BenchTask,
  arm: BenchArm,
  root: string,
  timeoutMs: number
): Promise<BenchRun> {
  const live = options.mode === 'live';
  // Each verified run starts from the same committed state, so one run's edits cannot reach the next run
  // or the user's working tree. Live runs always get a workspace, since the agent edits files in both arms.
  const setup = { shared: options.shared, copyFiles: options.copyFiles };
  const workspace = task.commit
    ? await createWorkspace(root, { ref: `${task.commit}^`, testsFrom: task.commit, tests: task.tests, ...setup })
    : task.verify === undefined && !live
      ? null
      : options.workspaceSource === 'working-tree' ? await createCopyWorkspace(root, setup) : await createWorkspace(root, setup);
  const configDirectory = live ? await mkdtemp(join(tmpdir(), 'tokio-bench-config-')) : null;
  try {
    const cwd = workspace?.path;
    if (live && cwd) {
      await copyMapFiles(root, cwd);
    }
    const prompt = arm === 'raw' || live ? task.task : await options.buildTokioPrompt(task.task, cwd ?? root);
    const extraArgs = live && cwd && configDirectory
      ? await liveArmArgs(arm, options.cliPath ?? join(__dirname, 'cli.js'), cwd, configDirectory)
      : [];
    const run = await runAgent({ command: options.agent.command, args: [...options.agent.args, ...extraArgs] }, prompt, timeoutMs, cwd);
    const usage = parseAgentUsage(run.stdout);
    // A run with no usage report is a configuration or startup failure, not a data point.
    if (usage.inputTokens === null && usage.outputTokens === null && usage.costUsd === null) {
      throw new Error(
        `Agent "${options.agent.command}" returned no usage report (exit ${run.exitCode}). ` +
        run.stderr.trim().slice(0, 300)
      );
    }
    const verified = workspace && task.verify !== undefined
      ? await runVerify(task.verify, workspace.path, timeoutMs)
      : null;
    const tokioCalls = live && arm === 'tokio' && workspace ? await countTokioCalls(workspace.path) : undefined;
    return { taskId: task.id, arm, promptTokens: estimateTokens(prompt), usage, verified, ...(tokioCalls ? { tokioCalls } : {}) };
  } finally {
    await workspace?.dispose();
    if (configDirectory) {
      await rm(configDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Drops worktree records whose folder is gone, such as those left by a bench that was stopped mid-run.
 * Outside a git repository there is nothing to prune.
 */
async function pruneWorktrees(root: string): Promise<void> {
  await execFileAsync('git', ['-C', root, 'worktree', 'prune']).catch(() => undefined);
}

/** Copies the repository's architecture map into a workspace, since a map is often not committed yet. */
async function copyMapFiles(root: string, workspace: string): Promise<void> {
  for (const file of MAP_FILES) {
    if (existsSync(join(root, file)) && !existsSync(join(workspace, file))) {
      await mkdir(dirname(join(workspace, file)), { recursive: true });
      await copyFile(join(root, file), join(workspace, file));
    }
  }
}

/** Tool calls per tool from the workspace's audit log, which only the Tokio arm writes. */
async function countTokioCalls(workspace: string): Promise<Record<string, number> | undefined> {
  const text = await readFile(join(workspace, '.tokio', 'audit.log'), 'utf8').catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }
  const counts: Record<string, number> = {};
  for (const line of text.split('\n')) {
    try {
      const tool = (JSON.parse(line) as { tool?: unknown }).tool;
      if (typeof tool === 'string') {
        counts[tool] = (counts[tool] ?? 0) + 1;
      }
    } catch {
      // Skip partial lines.
    }
  }
  return counts;
}

interface WorkspaceSetup {
  /** Git ref the worktree starts at. Defaults to HEAD. */
  ref?: string;
  /** Commit to check test files out from, on top of ref. */
  testsFrom?: string;
  tests?: readonly string[];
  shared?: readonly string[];
  copyFiles?: readonly string[];
}

/**
 * Links shared folders and copies named files from the repository into a workspace. Each link is added to links
 * as soon as it exists, so a failure partway through still lets the caller remove it before deleting anything.
 */
async function prepareWorkspace(root: string, path: string, setup: WorkspaceSetup, links: string[]): Promise<void> {
  // A junction needs no admin rights on Windows and lets verify commands such as npm test run.
  for (const folder of setup.shared ?? ['node_modules']) {
    const source = join(root, folder);
    const target = join(path, folder);
    if (existsSync(source) && !existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await symlink(source, target, 'junction');
      links.push(target);
    }
  }
  for (const file of setup.copyFiles ?? []) {
    if (!existsSync(join(root, file))) {
      throw new Error(`--copy names ${file}, which does not exist in the repository.`);
    }
    await mkdir(dirname(join(path, file)), { recursive: true });
    await copyFile(join(root, file), join(path, file));
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function indent(text: string, prefix: string): string {
  return text.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function billableOf(run: BenchRun): number {
  return (run.usage.inputTokens ?? 0) + (run.usage.cacheCreationTokens ?? 0) + (run.usage.outputTokens ?? 0);
}

const COPY_EXCLUDES = new Set(['node_modules', 'out', '.git', '.tokio']);

/**
 * Copies the directory, uncommitted changes included, into a temporary folder. Build output, git metadata,
 * the audit log and packaged extensions are skipped. Shares node_modules through a junction, as the worktree does.
 */
export async function createCopyWorkspace(root: string, setup: WorkspaceSetup = {}): Promise<Workspace> {
  const holder = await mkdtemp(join(tmpdir(), 'tokio-bench-'));
  const path = join(holder, 'run');
  try {
    await cp(root, path, {
      recursive: true,
      filter: (source) => !COPY_EXCLUDES.has(basename(source)) && !source.endsWith('.vsix')
    });
  } catch (error) {
    await rm(holder, { recursive: true, force: true });
    throw error;
  }

  const links: string[] = [];
  const dispose = async () => {
    await removeLinksOrStop(links, holder);
    await rm(holder, { recursive: true, force: true });
  };
  try {
    await prepareWorkspace(root, path, setup, links);
  } catch (error) {
    await dispose();
    throw error;
  }
  return track({ path, dispose });
}

/**
 * Creates a detached git worktree at a ref (HEAD by default), optionally with a later commit's test files checked
 * out on top. Shared folders such as node_modules are linked in through junctions.
 */
async function createWorkspace(root: string, setup: WorkspaceSetup = {}): Promise<Workspace> {
  const holder = await mkdtemp(join(tmpdir(), 'tokio-bench-'));
  const path = join(holder, 'run');
  try {
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', path, setup.ref ?? 'HEAD']);
  } catch (error) {
    await rm(holder, { recursive: true, force: true });
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(
      `Tasks with "verify" need a git repository with at least one commit at "${root}". ${detail.slice(0, 300)}`
    );
  }

  // Every junction is recorded the moment it is made, and removed and confirmed gone before the folder is deleted.
  // `git worktree remove --force` follows a junction on Windows and deletes the linked folder's contents, so it is
  // never used: Node's rm, which removes a junction without following it, deletes the folder, then git prunes the
  // worktree record.
  const links: string[] = [];
  const dispose = async () => {
    await removeLinksOrStop(links, holder);
    await rm(holder, { recursive: true, force: true });
    await pruneWorktrees(root);
  };
  try {
    if (setup.testsFrom) {
      const tests = setup.tests ?? (await execFileAsync('git', ['-C', root, 'diff', '--name-only', `${setup.testsFrom}^`, setup.testsFrom]))
        .stdout.split('\n').map((line) => line.trim()).filter((line) => TEST_PATH.test(line));
      if (tests.length === 0) {
        throw new Error(`Commit ${setup.testsFrom} changed no test files; list them in the task's "tests".`);
      }
      await execFileAsync('git', ['-C', path, 'checkout', setup.testsFrom, '--', ...tests]);
    }
    await prepareWorkspace(root, path, setup, links);
  } catch (error) {
    await dispose();
    throw error;
  }

  return track({ path, dispose });
}

/** Workspaces not yet disposed, so an interrupted bench can still clean up safely. */
const activeWorkspaces = new Set<Workspace>();

function track(workspace: Workspace): Workspace {
  const tracked: Workspace = {
    path: workspace.path,
    dispose: async () => {
      activeWorkspaces.delete(tracked);
      await workspace.dispose();
    }
  };
  activeWorkspaces.add(tracked);
  return tracked;
}

/** Disposes every workspace still open, as on Ctrl+C. Each one removes its links before anything is deleted. */
export async function disposeActiveWorkspaces(): Promise<void> {
  for (const workspace of [...activeWorkspaces]) {
    await workspace.dispose().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

/**
 * Removes each junction and confirms it is gone. If one remains, nothing is deleted and the error names the
 * folder to clean up by hand, because deleting it recursively would delete the shared folder's contents.
 */
export async function removeLinksOrStop(links: readonly string[], holder: string): Promise<void> {
  for (const link of links) {
    // Windows junctions use rmdir; POSIX directory symlinks must be unlinked.
    await (process.platform === 'win32' ? rmdir(link) : unlink(link)).catch(() => undefined);
    const remaining = await lstat(link).then(() => true, () => false);
    if (remaining) {
      throw new Error(
        `Tokio left ${holder} in place: it could not remove the link ${link}, and deleting the folder would also ` +
        'delete the linked folder\'s contents. Remove the link with `cmd /c rmdir "<link>"`, then delete the folder.'
      );
    }
  }
}

/** Runs a verify command in the workspace. Resolves true only for exit code 0. */
async function runVerify(command: string, cwd: string, timeoutMs: number): Promise<boolean> {
  return (await runVerifyWithOutput(command, cwd, timeoutMs)).passed;
}

/** Lines that explain a failing verify run: errors first, else the last lines. Redacted and capped. */
const ERROR_LINE = /error|exception|fail|SQLSTATE|fatal|refused|not found/i;
const MAX_EXPLAIN_LINES = 4;

function explainOutput(output: string): string {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = [...new Set(lines.filter((line) => ERROR_LINE.test(line) && !/^at |\.php:\d+$/.test(line)))];
  const chosen = (errors.length > 0 ? errors : lines.slice(-MAX_EXPLAIN_LINES)).slice(0, MAX_EXPLAIN_LINES);
  return redactSecrets(chosen.map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)).join('\n')).text;
}

/** Runs a verify command and keeps its output, so an unexpected result can say why. */
function runVerifyWithOutput(command: string, cwd: string, timeoutMs: number): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer): void => {
      // Keep the start, where setup errors such as a failed database login appear, and stop growing after that.
      if (output.length < 200_000) {
        output += chunk.toString('utf8');
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Verify command timed out after ${timeoutMs} ms: ${command}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run verify command "${command}": ${error.message}`));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ passed: exitCode === 0, output });
    });
  });
}

function summarizeArm(runs: readonly BenchRun[], arm: BenchArm): ArmSummary {
  const summary: ArmSummary = {
    runs: 0,
    errors: 0,
    promptTokens: 0,
    billableTokens: 0,
    costUsd: 0,
    turns: 0,
    durationMs: 0,
    verifyPassed: 0,
    verifyFailed: 0
  };
  for (const run of runs.filter((item) => item.arm === arm)) {
    summary.runs += 1;
    summary.promptTokens += run.promptTokens;
    summary.billableTokens += (run.usage.inputTokens ?? 0)
      + (run.usage.cacheCreationTokens ?? 0)
      + (run.usage.outputTokens ?? 0);
    summary.costUsd += run.usage.costUsd ?? 0;
    summary.turns += run.usage.turns ?? 0;
    summary.durationMs += run.usage.durationMs ?? 0;
    if (run.usage.isError) {
      summary.errors += 1;
    }
    if (run.verified === true) {
      summary.verifyPassed += 1;
    } else if (run.verified === false) {
      summary.verifyFailed += 1;
    }
  }
  return summary;
}

interface AgentRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runAgent(agent: AgentCommand, prompt: string, timeoutMs: number, cwd?: string): Promise<AgentRun> {
  return new Promise((resolve, reject) => {
    // On Windows, npm-installed CLIs are .cmd shims, which spawn only through a shell. The shell
    // gets one quoted command line built from fixed flags, so it never sees task text.
    const child = process.platform === 'win32'
      ? spawn([agent.command, ...agent.args].map(quoteArg).join(' '), { shell: true, stdio: ['pipe', 'pipe', 'pipe'], cwd })
      : spawn(agent.command, [...agent.args], { stdio: ['pipe', 'pipe', 'pipe'], cwd });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Agent "${agent.command}" timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start agent "${agent.command}": ${error.message}`));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
    child.stdin.end(prompt);
  });
}

function quoteArg(value: string): string {
  return /\s/.test(value) && !value.startsWith('"') ? `"${value}"` : value;
}

function emptyUsage(isError: boolean): AgentUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    turns: null,
    durationMs: null,
    isError
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

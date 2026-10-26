import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, rmdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { estimateTokens } from '../core/tokens';

const execFileAsync = promisify(execFile);

export interface BenchTask {
  id: string;
  task: string;
  /** Shell command run in the run's workspace after the agent exits. Exit code 0 means the task passed. */
  verify?: string;
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
  runs: BenchRun[];
  summary: BenchSummary;
}

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
}

export interface Workspace {
  path: string;
  dispose: () => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `task-${index + 1}`;
    return typeof item.verify === 'string'
      ? { id, task: item.task, verify: item.verify }
      : { id, task: item.task };
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

  for (const task of options.tasks) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const arm of ['raw', 'tokio'] as const) {
        runs.push(await runArm(options, task, arm, root, timeoutMs));
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    agent: options.agent.command,
    runs,
    summary: summarizeRuns(runs)
  };
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
  // Each verified run starts from the same committed state, so one run's edits cannot reach the next run
  // or the user's working tree.
  const workspace = task.verify === undefined
    ? null
    : options.workspaceSource === 'working-tree' ? await createCopyWorkspace(root) : await createWorkspace(root);
  try {
    const cwd = workspace?.path;
    const prompt = arm === 'raw' ? task.task : await options.buildTokioPrompt(task.task, cwd ?? root);
    const run = await runAgent(options.agent, prompt, timeoutMs, cwd);
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
    return { taskId: task.id, arm, promptTokens: estimateTokens(prompt), usage, verified };
  } finally {
    await workspace?.dispose();
  }
}

const COPY_EXCLUDES = new Set(['node_modules', 'out', '.git', '.tokio']);

/**
 * Copies the directory, uncommitted changes included, into a temporary folder. Build output, git metadata,
 * the audit log and packaged extensions are skipped. Shares node_modules through a junction, as the worktree does.
 */
export async function createCopyWorkspace(root: string): Promise<Workspace> {
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

  const sharedModules = join(root, 'node_modules');
  const linkedModules = existsSync(sharedModules) ? join(path, 'node_modules') : null;
  if (linkedModules) {
    await symlink(sharedModules, linkedModules, 'junction');
  }

  return {
    path,
    dispose: async () => {
      if (linkedModules) {
        await rmdir(linkedModules).catch(() => undefined);
      }
      await rm(holder, { recursive: true, force: true });
    }
  };
}

/** Creates a detached git worktree at HEAD. Shares the repository's node_modules through a junction when present. */
async function createWorkspace(root: string): Promise<Workspace> {
  const holder = await mkdtemp(join(tmpdir(), 'tokio-bench-'));
  const path = join(holder, 'run');
  try {
    await execFileAsync('git', ['-C', root, 'worktree', 'add', '--detach', path, 'HEAD']);
  } catch (error) {
    await rm(holder, { recursive: true, force: true });
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(
      `Tasks with "verify" need a git repository with at least one commit at "${root}". ${detail.slice(0, 300)}`
    );
  }

  // A junction needs no admin rights on Windows and lets verify commands such as npm test run.
  const sharedModules = join(root, 'node_modules');
  const linkedModules = existsSync(sharedModules) ? join(path, 'node_modules') : null;
  if (linkedModules) {
    await symlink(sharedModules, linkedModules, 'junction');
  }

  return {
    path,
    dispose: async () => {
      // Remove the junction before git touches the worktree, so cleanup never reaches the shared dependencies.
      if (linkedModules) {
        await rmdir(linkedModules).catch(() => undefined);
      }
      await execFileAsync('git', ['-C', root, 'worktree', 'remove', '--force', path]).catch(() => undefined);
      await rm(holder, { recursive: true, force: true });
    }
  };
}

/** Runs a verify command in the workspace. Resolves true only for exit code 0. */
function runVerify(command: string, cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd, stdio: 'ignore' });
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
      resolve(exitCode === 0);
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

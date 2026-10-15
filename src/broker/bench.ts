import { spawn } from 'node:child_process';
import { refinePrompt } from '../core/refine';
import { estimateTokens } from '../core/tokens';

export interface BenchTask {
  id: string;
  task: string;
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
}

export interface ArmSummary {
  runs: number;
  errors: number;
  promptTokens: number;
  /** Input, cache-creation, and output tokens. Cache reads are excluded because they are billed at a lower rate. */
  billableTokens: number;
  costUsd: number;
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
  /** Builds the prompt for the Tokio arm. The raw arm always sends the task text unchanged. */
  buildTokioPrompt: (task: string) => Promise<string>;
  repeats?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Parses a tasks file: a JSON array of `{ "task": string, "id"?: string }`. */
export function parseBenchTasks(json: string): BenchTask[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error('Tasks file must contain a JSON array.');
  }

  return parsed.map((item: unknown, index) => {
    if (!isRecord(item) || typeof item.task !== 'string' || item.task.trim().length === 0) {
      throw new Error(`Task ${index + 1} must be an object with a non-empty "task" string.`);
    }
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : `task-${index + 1}`;
    return { id, task: item.task };
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
  const runs: BenchRun[] = [];

  for (const task of options.tasks) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const tokioPrompt = await options.buildTokioPrompt(task.task);
      const arms: [BenchArm, string][] = [['raw', task.task], ['tokio', tokioPrompt]];

      for (const [arm, prompt] of arms) {
        const run = await runAgent(options.agent, prompt, timeoutMs);
        const usage = parseAgentUsage(run.stdout);
        // A run with no usage report is a configuration or startup failure, not a data point.
        if (usage.inputTokens === null && usage.outputTokens === null && usage.costUsd === null) {
          throw new Error(
            `Agent "${options.agent.command}" returned no usage report (exit ${run.exitCode}). ` +
            run.stderr.trim().slice(0, 300)
          );
        }
        runs.push({ taskId: task.id, arm, promptTokens: estimateTokens(prompt), usage });
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
  const line = (label: string, arm: ArmSummary) => (
    `${label}: runs=${arm.runs} errors=${arm.errors} promptTokens≈${arm.promptTokens} ` +
    `billableTokens=${arm.billableTokens} costUsd=${arm.costUsd.toFixed(4)}`
  );
  const ratio = summary.billableRatio === null ? 'n/a' : summary.billableRatio.toFixed(3);
  return [line('raw  ', summary.raw), line('tokio', summary.tokio), `billable ratio (tokio/raw): ${ratio}`].join('\n');
}

function summarizeArm(runs: readonly BenchRun[], arm: BenchArm): ArmSummary {
  const summary: ArmSummary = { runs: 0, errors: 0, promptTokens: 0, billableTokens: 0, costUsd: 0 };
  for (const run of runs.filter((item) => item.arm === arm)) {
    summary.runs += 1;
    summary.promptTokens += run.promptTokens;
    summary.billableTokens += (run.usage.inputTokens ?? 0)
      + (run.usage.cacheCreationTokens ?? 0)
      + (run.usage.outputTokens ?? 0);
    summary.costUsd += run.usage.costUsd ?? 0;
    if (run.usage.isError) {
      summary.errors += 1;
    }
  }
  return summary;
}

interface AgentRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runAgent(agent: AgentCommand, prompt: string, timeoutMs: number): Promise<AgentRun> {
  return new Promise((resolve, reject) => {
    // On Windows, npm-installed CLIs are .cmd shims, which spawn only through a shell. The shell
    // gets one quoted command line built from fixed flags, so it never sees task text.
    const child = process.platform === 'win32'
      ? spawn([agent.command, ...agent.args].map(quoteArg).join(' '), { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(agent.command, [...agent.args], { stdio: ['pipe', 'pipe', 'pipe'] });

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

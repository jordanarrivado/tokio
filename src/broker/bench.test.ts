import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  formatBenchSummary,
  parseAgentUsage,
  parseBenchTasks,
  runBench,
  summarizeRuns
} from './bench';

// Stands in for `claude -p --output-format json`: reads the prompt from stdin and
// reports its size as input_tokens, so the test can confirm the prompt arrived intact.
const FAKE_AGENT = `
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const tokens = Math.ceil(input.length / 4);
  console.log(JSON.stringify({
    type: 'result',
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: tokens, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }
  }));
});
`;

test('parses tasks and assigns stable ids when none are given', () => {
  const tasks = parseBenchTasks(JSON.stringify([{ task: 'fix login' }, { id: 'auth', task: 'add audit log' }]));
  assert.deepEqual(tasks, [
    { id: 'task-1', task: 'fix login' },
    { id: 'auth', task: 'add audit log' }
  ]);
});

test('rejects tasks files that are not an array of non-empty tasks', () => {
  assert.throws(() => parseBenchTasks('{}'), /must contain a JSON array/);
  assert.throws(() => parseBenchTasks('[{"task": "   "}]'), /non-empty "task"/);
});

test('reads usage from a single result object', () => {
  const usage = parseAgentUsage(JSON.stringify({
    type: 'result',
    is_error: false,
    total_cost_usd: 0.02,
    num_turns: 4,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 }
  }));
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
  assert.equal(usage.cacheReadTokens, 7);
  assert.equal(usage.cacheCreationTokens, 2);
  assert.equal(usage.costUsd, 0.02);
  assert.equal(usage.turns, 4);
  assert.equal(usage.isError, false);
});

test('reads the final result from a message array and flags invalid output', () => {
  const usage = parseAgentUsage(JSON.stringify([
    { type: 'system' },
    { type: 'result', is_error: true, usage: { input_tokens: 1 } }
  ]));
  assert.equal(usage.inputTokens, 1);
  assert.equal(usage.isError, true);

  const invalid = parseAgentUsage('not json');
  assert.equal(invalid.isError, true);
  assert.equal(invalid.inputTokens, null);
});

test('summarizes billable tokens without cache reads and computes the ratio', () => {
  const run = (arm: 'raw' | 'tokio', input: number) => ({
    taskId: 't',
    arm,
    promptTokens: input,
    usage: {
      inputTokens: input,
      outputTokens: 10,
      cacheReadTokens: 1000,
      cacheCreationTokens: 0,
      costUsd: 0.01,
      turns: 1,
      durationMs: 1,
      isError: false
    }
  });
  const summary = summarizeRuns([run('raw', 90), run('tokio', 40)]);
  assert.equal(summary.raw.billableTokens, 100);
  assert.equal(summary.tokio.billableTokens, 50);
  assert.equal(summary.billableRatio, 0.5);
  assert.match(formatBenchSummary(summary), /billable ratio \(tokio\/raw\): 0\.500/);
});

test('fails the run when the agent is missing instead of recording empty results', async () => {
  await assert.rejects(
    runBench({
      tasks: [{ id: 'x', task: 'fix login' }],
      agent: { command: 'tokio-test-missing-agent-cli', args: ['-p'] },
      buildTokioPrompt: async (task) => task
    }),
    /Agent "tokio-test-missing-agent-cli"/
  );
});

test('runs both arms through the agent with the prompt sent on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokio-bench-'));
  const scriptPath = join(directory, 'fake-agent.js');
  await writeFile(scriptPath, FAKE_AGENT, 'utf8');

  const rawTask = 'fix the login redirect loop in the auth middleware';
  const report = await runBench({
    tasks: [{ id: 'login', task: rawTask }],
    agent: { command: process.execPath, args: [scriptPath] },
    buildTokioPrompt: async (task) => `REFINED SCOPE\n\nTask:\n${task}\n\nValidate with npm test.`
  });

  assert.equal(report.runs.length, 2);
  const raw = report.runs.find((run) => run.arm === 'raw');
  const tokio = report.runs.find((run) => run.arm === 'tokio');
  assert.ok(raw && tokio);
  // The agent's reported input size matches the prompt that was sent, proving stdin delivery.
  assert.equal(raw.usage.inputTokens, raw.promptTokens);
  assert.equal(tokio.usage.inputTokens, tokio.promptTokens);
  assert.ok(tokio.promptTokens > raw.promptTokens);
  assert.equal(report.summary.raw.errors, 0);
  assert.equal(report.summary.tokio.errors, 0);
});

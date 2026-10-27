import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import {
  formatBenchSummary,
  parseAgentUsage,
  createCopyWorkspace,
  parseBenchTasks,
  runBench,
  summarizeRuns
} from './bench';

const execFileAsync = promisify(execFile);

test('working-tree workspace copies uncommitted files and skips build output and git metadata', async () => {
  const source = await mkdtemp(join(tmpdir(), 'tokio-copy-src-'));
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(source, 'out'), { recursive: true });
  await mkdir(join(source, '.git'), { recursive: true });
  await writeFile(join(source, 'src', 'app.ts'), 'export const uncommitted = 1;\n', 'utf8');
  await writeFile(join(source, 'out', 'built.js'), '// build output\n', 'utf8');
  await writeFile(join(source, '.git', 'HEAD'), 'ref\n', 'utf8');
  await writeFile(join(source, 'tokio-0.6.0.vsix'), 'package\n', 'utf8');

  const workspace = await createCopyWorkspace(source);
  try {
    assert.equal(existsSync(join(workspace.path, 'src', 'app.ts')), true);
    assert.equal(existsSync(join(workspace.path, 'out')), false);
    assert.equal(existsSync(join(workspace.path, '.git')), false);
    assert.equal(existsSync(join(workspace.path, 'tokio-0.6.0.vsix')), false);
  } finally {
    await workspace.dispose();
  }

  // Disposing the copy must leave the source directory untouched.
  assert.equal(existsSync(join(source, 'src', 'app.ts')), true);
  assert.equal(existsSync(join(source, 'out', 'built.js')), true);
});

// Every scratch directory is removed once the file's tests finish, so repeated runs leave nothing in %TEMP%.
const scratchDirectories: string[] = [];
after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

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

test('keeps the verify command and rejects an empty one', () => {
  const tasks = parseBenchTasks(JSON.stringify([
    { id: 'a', task: 'fix login', verify: 'npm test' },
    { task: 'add audit log' }
  ]));
  assert.deepEqual(tasks, [
    { id: 'a', task: 'fix login', verify: 'npm test' },
    { id: 'task-2', task: 'add audit log' }
  ]);
  assert.throws(() => parseBenchTasks('[{"task": "x", "verify": "  "}]'), /"verify" must be a non-empty command string/);
  assert.throws(() => parseBenchTasks('[{"task": "x", "verify": 3}]'), /"verify" must be a non-empty command string/);
});

test('summarizes billable tokens without cache reads and computes the ratio', () => {
  const run = (arm: 'raw' | 'tokio', input: number) => ({
    taskId: 't',
    arm,
    promptTokens: input,
    verified: null,
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

test('sums turns, duration, and verify results per arm', () => {
  const run = (arm: 'raw' | 'tokio', turns: number, durationMs: number, verified: boolean | null) => ({
    taskId: 't',
    arm,
    promptTokens: 1,
    verified,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      turns,
      durationMs,
      isError: false
    }
  });
  const summary = summarizeRuns([
    run('raw', 3, 1000, true),
    run('raw', 5, 2000, false),
    run('tokio', 2, 500, true),
    run('tokio', 1, 500, null)
  ]);
  assert.equal(summary.raw.turns, 8);
  assert.equal(summary.raw.durationMs, 3000);
  assert.equal(summary.raw.verifyPassed, 1);
  assert.equal(summary.raw.verifyFailed, 1);
  assert.equal(summary.tokio.verifyPassed, 1);
  assert.equal(summary.tokio.verifyFailed, 0);
  assert.match(formatBenchSummary(summary), /raw  : runs=2 .* turns=8 duration=3\.0s verified=1\/2/);
  assert.match(formatBenchSummary(summary), /tokio: runs=2 .* verified=1\/1/);
});

test('fails the run when the agent is missing instead of recording empty results', async () => {
  await assert.rejects(
    runBench({
      tasks: [{ id: 'x', task: 'fix login' }],
      agent: { command: 'tokio-test-missing-agent-cli', args: ['-p'] },
      buildTokioPrompt: async (task) => task
    }),
    // Direct spawn errors and Windows shell failures use different capitalization.
    /Agent "tokio-test-missing-agent-cli"/i
  );
});

test('runs both arms through the agent with the prompt sent on stdin', async () => {
  const directory = await scratchDirectory('tokio-bench-');
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

// Stands in for an agent that edits the repository: it writes a marker file into its working directory.
const EDITING_AGENT = `
const fs = require('node:fs');
fs.writeFileSync('agent-output.txt', 'done');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({
    type: 'result',
    is_error: false,
    num_turns: 2,
    duration_ms: 7,
    total_cost_usd: 0.002,
    usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  }));
});
`;

async function makeRepo(): Promise<string> {
  const root = await scratchDirectory('tokio-bench-repo-');
  await execFileAsync('git', ['-C', root, 'init', '-q']);
  await writeFile(join(root, 'README.md'), 'fixture\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await execFileAsync('git', [
    '-C', root, '-c', 'user.name=tokio-test', '-c', 'user.email=tokio-test@example.invalid',
    'commit', '-q', '-m', 'init'
  ]);
  return root;
}

async function worktreeCount(root: string): Promise<number> {
  const { stdout } = await execFileAsync('git', ['-C', root, 'worktree', 'list', '--porcelain']);
  return stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

test('verifies each run in an isolated checkout without touching the repository', async () => {
  const directory = await scratchDirectory('tokio-bench-');
  const scriptPath = join(directory, 'editing-agent.js');
  await writeFile(scriptPath, EDITING_AGENT, 'utf8');
  const root = await makeRepo();
  // Dependencies are shared with the isolated checkout, and cleanup must never delete them.
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'keep.txt'), 'shared\n', 'utf8');

  const report = await runBench({
    root,
    tasks: [{
      id: 'marker',
      task: 'write the marker file',
      verify: 'node -e "process.exit(require(\'fs\').existsSync(\'agent-output.txt\') ? 0 : 1)"'
    }],
    agent: { command: process.execPath, args: [scriptPath] },
    buildTokioPrompt: async (task) => `REFINED\n\n${task}`
  });

  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.runs.map((run) => run.verified), [true, true]);
  assert.equal(report.summary.raw.verifyPassed, 1);
  assert.equal(report.summary.tokio.verifyPassed, 1);
  assert.equal(report.summary.raw.turns, 2);
  assert.equal(report.summary.raw.durationMs, 7);
  // The agent's edits stayed in the throwaway checkouts, and the temporary worktrees were removed.
  assert.equal(existsSync(join(root, 'agent-output.txt')), false);
  assert.equal(await worktreeCount(root), 1);
  assert.equal(existsSync(join(root, 'node_modules', 'keep.txt')), true);
});

test('records a failed verify command as a failed run', async () => {
  const directory = await scratchDirectory('tokio-bench-');
  const scriptPath = join(directory, 'editing-agent.js');
  await writeFile(scriptPath, EDITING_AGENT, 'utf8');
  const root = await makeRepo();

  const report = await runBench({
    root,
    tasks: [{ id: 'fails', task: 'anything', verify: 'node -e "process.exit(1)"' }],
    agent: { command: process.execPath, args: [scriptPath] },
    buildTokioPrompt: async (task) => task
  });

  assert.deepEqual(report.runs.map((run) => run.verified), [false, false]);
  assert.equal(report.summary.raw.verifyFailed, 1);
  assert.equal(report.summary.tokio.verifyFailed, 1);
  assert.equal(await worktreeCount(root), 1);
});

test('leaves verify results null for tasks without a verify command', async () => {
  const directory = await scratchDirectory('tokio-bench-');
  const scriptPath = join(directory, 'fake-agent.js');
  await writeFile(scriptPath, FAKE_AGENT, 'utf8');

  const report = await runBench({
    tasks: [{ id: 'plain', task: 'fix login' }],
    agent: { command: process.execPath, args: [scriptPath] },
    buildTokioPrompt: async (task) => task
  });

  assert.deepEqual(report.runs.map((run) => run.verified), [null, null]);
  assert.equal(report.summary.raw.verifyPassed + report.summary.raw.verifyFailed, 0);
});

test('explains that verify needs a git repository with a commit', async () => {
  const directory = await scratchDirectory('tokio-bench-');
  const scriptPath = join(directory, 'fake-agent.js');
  await writeFile(scriptPath, FAKE_AGENT, 'utf8');

  await assert.rejects(
    runBench({
      root: directory,
      tasks: [{ id: 'nogit', task: 'fix login', verify: 'node -e "process.exit(0)"' }],
      agent: { command: process.execPath, args: [scriptPath] },
      buildTokioPrompt: async (task) => task
    }),
    /need a git repository with at least one commit/
  );
});

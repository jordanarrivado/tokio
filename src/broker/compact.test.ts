import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compactCommandOutput, compactText, isNoisyCommand, readSavedOutput, saveOutput } from './compact';
import { Broker } from './tools';

const CLI = join(__dirname, 'cli.js');

function testLog(): string {
  const lines: string[] = ['> tokio@1.0.0 test', '> node --test'];
  for (let index = 0; index < 300; index += 1) {
    lines.push(`ok ${index + 1} - passes case ${index}`);
  }
  lines.splice(150, 0, 'not ok 149 - parses the header', '  AssertionError: expected 2 to equal 3', '    at src/parse.test.ts:42:7');
  lines.push('# tests 301', '# pass 300', '# fail 1');
  return lines.join('\n');
}

test('isNoisyCommand matches test, build, and install commands only', () => {
  for (const command of ['npm test', 'npm.cmd run verify', 'cd api && php artisan test', 'npx tsc -p .', 'cargo test', 'go test ./...', 'pytest -q', 'composer install', 'make']) {
    assert.equal(isNoisyCommand(command), true, command);
  }
  for (const command of ['git status', 'cat README.md', 'ls src', 'node script.js', 'git log --oneline']) {
    assert.equal(isNoisyCommand(command), false, command);
  }
});

test('compactText keeps failures with context, head, and tail, and marks gaps', () => {
  const result = compactText(testLog());
  assert.match(result.text, /not ok 149 - parses the header/);
  assert.match(result.text, /AssertionError: expected 2 to equal 3/);
  assert.match(result.text, /at src\/parse\.test\.ts:42:7/);
  assert.match(result.text, /^> tokio@1\.0\.0 test/);
  assert.match(result.text, /# fail 1$/);
  assert.match(result.text, /… \d+ lines omitted/);
  assert.ok(result.shown < result.total / 4);
});

test('compactText keeps typed errors such as TypeError and RuntimeException', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `step ${index}`);
  lines.splice(50, 0, 'TypeError: Cannot read properties of undefined', 'Illuminate\\Database\\QueryException thrown');
  const result = compactText(lines.join('\n'));
  assert.match(result.text, /TypeError: Cannot read properties of undefined/);
  assert.match(result.text, /QueryException thrown/);
});

test('compactText ignores error words in passing test names so the real failure fits the budget', () => {
  const lines = Array.from({ length: 200 }, (_, index) => `✔ returns an error when input ${index} is expected to fail (1ms)`);
  lines.splice(150, 0, '✖ renders the view (2ms)', '  TypeError: Cannot read properties of undefined');
  const result = compactText(lines.join('\n'));
  assert.match(result.text, /✖ renders the view/);
  assert.match(result.text, /TypeError: Cannot read properties of undefined/);
  assert.ok(result.shown < 40);
});

test('compactText strips ANSI codes, keeps the last progress frame, and collapses repeats', () => {
  const result = compactText('\u001b[31mred\u001b[0m\n10%\r50%\r100%\nsame\nsame\nsame');
  assert.equal(result.text, 'red\n100%\nsame (×3)');
});

test('compactCommandOutput leaves short or non-noisy output alone', () => {
  assert.equal(compactCommandOutput('npm test', 'ok 1\nok 2', ''), undefined);
  assert.equal(compactCommandOutput('cat big.log', testLog(), ''), undefined);
});

test('compactCommandOutput compacts noisy output and redacts secrets', () => {
  const log = `${testLog()}\nAPI_KEY=sk-ant-api03-${'a'.repeat(40)}`;
  const result = compactCommandOutput('npm test', log, '');
  assert.ok(result);
  assert.match(result.stdout, /not ok 149/);
  assert.doesNotMatch(result.stdout, /ok 10 - passes case 9\n/);
  assert.doesNotMatch(result.full, /sk-ant-api03-a{40}/);
  assert.ok(result.baselineTokens > 0);
  assert.ok(result.shown < result.total);
});

test('saved outputs round-trip by id and reject other ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokio-compact-'));
  const id = await saveOutput('full text', directory);
  assert.match(id, /^run-/);
  assert.equal(await readSavedOutput(id, directory), 'full text');
  assert.equal(await readSavedOutput('../secrets', directory), undefined);
  assert.equal(await readSavedOutput('run-zz-00', directory), undefined);
});

test('output-hook replaces noisy Bash output and search_output finds the full text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-output-hook-'));
  const event = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    cwd: root,
    tool_input: { command: 'npm test' },
    tool_response: { stdout: testLog(), stderr: '', interrupted: false, isImage: false }
  });
  const run = spawnSync(process.execPath, [CLI, 'output-hook'], { input: event, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; updatedToolOutput: Record<string, unknown> } };
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  const updated = output.hookSpecificOutput.updatedToolOutput;
  assert.equal(updated.interrupted, false);
  assert.equal(updated.isImage, false);
  assert.match(String(updated.stdout), /not ok 149/);
  const id = /search_output id "(run-[^"]+)"/.exec(String(updated.stdout))?.[1];
  assert.ok(id);

  const found = await new Broker(root).callTool('search_output', { id, query: 'passes case 7' });
  assert.equal(found.isError, undefined);
  assert.match(found.text, /passes case 7/);
});

test('output-hook prints nothing for other commands or unreadable input', () => {
  const quiet = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git log' }, tool_response: { stdout: testLog(), stderr: '' } });
  for (const input of [quiet, 'not json']) {
    const run = spawnSync(process.execPath, [CLI, 'output-hook'], { input, encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  }
});

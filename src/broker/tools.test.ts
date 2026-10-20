import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUDIT_DIRECTORY, AUDIT_FILE } from './audit';
import { Broker } from './tools';

const LOGIN_SOURCE = [
  "import { load } from './store';",
  '',
  'export function login(user: string) {',
  '  return load(user);',
  '}',
  '',
  'export function logout() {',
  '  return null;',
  '}',
  ''
].join('\n');

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-tools-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

test('refine_task redacts secrets before refining and records only their kinds', async () => {
  const broker = new Broker(await createRepo({}));
  const outcome = await broker.callTool('refine_task', {
    task: 'Fix the login bug. Use key sk-abcdefghijklmnopqrstuvwxyz1234 and password: hunter2222'
  });

  assert.equal(outcome.isError, undefined);
  assert.match(outcome.text, /Redacted 2 secret value/);
  assert.match(outcome.text, /\[REDACTED:api-key\]/);
  assert.doesNotMatch(outcome.text, /sk-abcdef|hunter2222/);
  assert.deepEqual(outcome.redactions, ['api-key', 'assignment']);
});

test('repo_map returns ranked signatures and never includes secret file contents', async () => {
  const root = await createRepo({
    'src/auth/login.ts': LOGIN_SOURCE,
    'src/store.ts': 'export class Store {}\n',
    '.env': 'TOKEN=supersecretvalue\n'
  });
  const outcome = await new Broker(root).callTool('repo_map', {
    task: 'fix login redirect',
    targetPath: 'src/auth/login.ts',
    budgetTokens: 800
  });

  assert.match(outcome.text, /src\/auth\/login\.ts\n {2}3: export function login/);
  assert.doesNotMatch(outcome.text, /supersecretvalue/);
  assert.deepEqual(outcome.files?.[0], 'src/auth/login.ts');
});

test('read_symbol returns numbered bodies and reports only changed lines on repeat reads', async () => {
  const root = await createRepo({ 'src/auth/login.ts': LOGIN_SOURCE });
  const broker = new Broker(root);

  const first = await broker.callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3 });
  assert.equal(
    first.text.replace(/\n\[tokio estimate: .*\]$/, ''),
    '3| export function login(user: string) {\n4|   return load(user);\n5| }\n6| '
  );

  const repeat = await broker.callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3 });
  assert.match(repeat.text, /^Unchanged since the last read/);

  await writeFile(join(root, 'src/auth/login.ts'), LOGIN_SOURCE.replace('load(user)', 'load(user.trim())'), 'utf8');
  const changed = await broker.callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3 });
  assert.match(changed.text, /^Changed since the last read/);
  // Diff marker, then a space, then the two-space indent from the source.
  assert.match(changed.text, /^- {3}return load\(user\);$/m);
  assert.match(changed.text, /^\+ {3}return load\(user\.trim\(\)\);$/m);

  const forced = await broker.callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3, full: true });
  assert.match(forced.text, /^4\|   return load\(user\.trim\(\)\);$/m);
});

test('read_symbol blocks secret files and traversal and records the block in the audit log', async () => {
  const root = await createRepo({ 'src/app.ts': 'export const app = 1;\n', '.env': 'SECRET_VALUE=1\n' });
  const broker = new Broker(root);

  const secret = await broker.callTool('read_symbol', { path: '.env' });
  assert.equal(secret.isError, true);
  assert.equal(secret.blocked, true);

  const traversal = await broker.callTool('read_symbol', { path: '../outside.ts' });
  assert.equal(traversal.isError, true);
  assert.match(traversal.text, /outside the repository/);

  const log = await readFile(join(root, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8');
  assert.equal(log.trim().split('\n').length, 2);
  assert.doesNotMatch(log, /SECRET_VALUE/);
});

test('truncated reads store the rest of the range, which search_output can query', async () => {
  const lines: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    lines.push(index === 150 ? 'const NEEDLE_MARKER = 1;' : `const value${index} = ${index};`, '');
  }
  const root = await createRepo({ 'src/big.ts': lines.join('\n') });
  const broker = new Broker(root);

  const read = await broker.callTool('read_symbol', { path: 'src/big.ts', startLine: 1 });
  const id = /stored as output (out-\d+)/.exec(read.text)?.[1];
  assert.ok(id, 'expected a stored output id');
  assert.doesNotMatch(read.text, /NEEDLE_MARKER/);

  const search = await broker.callTool('search_output', { id, query: 'NEEDLE_MARKER' });
  assert.match(search.text, /\[chunk \d+\/\d+\]/);
  assert.match(search.text, /NEEDLE_MARKER/);

  const missing = await broker.callTool('search_output', { id: 'out-999', query: 'x' });
  assert.equal(missing.isError, true);
});

test('invalid arguments return a tool error instead of throwing', async () => {
  const broker = new Broker(await createRepo({}));
  const outcome = await broker.callTool('repo_map', { task: 'x', budgetTokens: 5 });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /budgetTokens must be an integer from 200 to 8000/);

  const unknown = await broker.callTool('delete_everything', {});
  assert.equal(unknown.isError, true);
});

test('a missing required field returns an input error naming the field', async () => {
  const broker = new Broker(await createRepo({}));
  const outcome = await broker.callTool('repo_map', {});
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'Invalid input: task is required.');
});

test('a field of the wrong type returns an input error naming the field, type, and value', async () => {
  const broker = new Broker(await createRepo({ 'src/auth/login.ts': LOGIN_SOURCE }));
  const outcome = await broker.callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 'x' });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'Invalid input: startLine must be an integer (got "x").');
});

test('an out-of-range number or unknown enum value returns an input error naming what is allowed', async () => {
  const broker = new Broker(await createRepo({}));
  const range = await broker.callTool('repo_map', { task: 'x', budgetTokens: 5 });
  assert.equal(range.isError, true);
  assert.equal(range.text, 'Invalid input: budgetTokens must be an integer from 200 to 8000 (got 5).');

  const choice = await broker.callTool('refine_task', { task: 'x', mode: 'loud' });
  assert.equal(choice.isError, true);
  assert.equal(choice.text, 'Invalid input: mode must be one of: minimal, adaptive, strict (got "loud").');
});

test('unknown extra fields are ignored and do not change the result', async () => {
  const root = await createRepo({ 'src/auth/login.ts': LOGIN_SOURCE });
  const plain = await new Broker(root).callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3 });
  const extra = await new Broker(root).callTool('read_symbol', { path: 'src/auth/login.ts', startLine: 3, start_line: 9 });
  assert.equal(extra.isError, undefined);
  assert.equal(extra.text, plain.text);
});

test('an unknown tool name returns an error listing the valid tools', async () => {
  const broker = new Broker(await createRepo({}));
  const outcome = await broker.callTool('delete_everything', {});
  assert.equal(outcome.isError, true);
  assert.equal(
    outcome.text,
    'Unknown tool: delete_everything. Valid tools: refine_task, repo_map, read_symbol, search_output, session_stats, route_task.'
  );
});

test('the tool handler is never invoked on invalid input', async () => {
  const broker = new Broker(await createRepo({}));
  let calls = 0;
  // Replace the private handler on this instance with a spy.
  (broker as unknown as Record<string, unknown>).repoMap = async () => {
    calls += 1;
    return { text: 'spy' };
  };
  await broker.callTool('repo_map', {});
  await broker.callTool('repo_map', { task: 7 });
  await broker.callTool('repo_map', { task: 'x', budgetTokens: 5 });
  assert.equal(calls, 0);

  await broker.callTool('repo_map', { task: 'x' });
  assert.equal(calls, 1);
});

test('a call still running at 10s returns a timeout error', { timeout: 2000 }, async (t) => {
  const broker = new Broker(await createRepo({}));
  (broker as unknown as Record<string, unknown>).repoMap = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = broker.callTool('repo_map', { task: 'x' });
  t.mock.timers.tick(10_000);
  const outcome = await pending;
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'Timed out after 10s. Narrow targetPath or the request.');
});

test('a timed-out call is recorded in the audit log with outcome timeout', { timeout: 2000 }, async (t) => {
  const root = await createRepo({});
  const broker = new Broker(root);
  (broker as unknown as Record<string, unknown>).repoMap = () => new Promise(() => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = broker.callTool('repo_map', { task: 'x' });
  t.mock.timers.tick(10_000);
  await pending;

  const lines = (await readFile(join(root, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8')).trim().split('\n');
  const entry = JSON.parse(lines[lines.length - 1]) as { tool: string; outcome?: string };
  assert.equal(entry.tool, 'repo_map');
  assert.equal(entry.outcome, 'timeout');
});

test('a call that finishes before 10s is unaffected by the timeout', { timeout: 2000 }, async (t) => {
  const broker = new Broker(await createRepo({}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  (broker as unknown as Record<string, unknown>).repoMap = () =>
    new Promise((resolve) => setTimeout(() => resolve({ text: 'map', baselineTokens: 10 }), 9_999));

  const pending = broker.callTool('repo_map', { task: 'x' });
  t.mock.timers.tick(9_999);
  const outcome = await pending;
  assert.equal(outcome.isError, undefined);
  assert.match(outcome.text, /^map\n/);
});

test('cancelled calls are recorded in the audit log with outcome cancelled', { timeout: 2000 }, async () => {
  const root = await createRepo({});
  const broker = new Broker(root);
  (broker as unknown as Record<string, unknown>).repoMap = () => new Promise(() => {});

  const running = new AbortController();
  const pending = broker.callTool('repo_map', { task: 'x' }, running.signal);
  running.abort();
  await pending;

  const queued = new AbortController();
  queued.abort();
  await broker.callTool('route_task', { task: 'x' }, queued.signal);

  const lines = (await readFile(join(root, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8')).trim().split('\n');
  const entries = lines.map((line) => JSON.parse(line) as { tool: string; outcome?: string });
  assert.deepEqual(entries.map((entry) => [entry.tool, entry.outcome]), [
    ['repo_map', 'cancelled'],
    ['route_task', 'cancelled']
  ]);
});

import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUDIT_DIRECTORY, AUDIT_FILE } from './audit';
import { readAuditEntries } from './stats';
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

/** Replaces a private Broker handler on one instance, so a test controls what it returns. */
function stubHandler(broker: Broker, handler: string, fn: (...args: never[]) => unknown): void {
  (broker as unknown as Record<string, unknown>)[handler] = fn;
}

/** A handler that never settles, for the timeout and cancellation paths. */
const HANG = (): Promise<never> => new Promise(() => {});

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

test('session_stats separates this session from the all-time total kept in the audit log', async () => {
  const root = await createRepo({ 'src/auth/login.ts': LOGIN_SOURCE });
  await new Broker(root).callTool('repo_map', { task: 'login' });

  // A new broker starts a new session, but the audit log from the earlier one is still there.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const outcome = await new Broker(root).callTool('session_stats', {});
  assert.match(outcome.text, /this session/);
  assert.match(outcome.text, /calls: 0 /);
  assert.match(outcome.text, /All recorded calls for this project: [1-9]\d*,/);
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
    'Unknown tool: delete_everything. Valid tools: refine_task, repo_map, read_symbol, search_output, session_stats, route_task, find_symbol, list_repositories, ask_repo.'
  );
});

test('the tool handler is never invoked on invalid input', async () => {
  const broker = new Broker(await createRepo({}));
  let calls = 0;
  stubHandler(broker, 'repoMap', async () => {
    calls += 1;
    return { text: 'spy' };
  });
  await broker.callTool('repo_map', {});
  await broker.callTool('repo_map', { task: 7 });
  await broker.callTool('repo_map', { task: 'x', budgetTokens: 5 });
  assert.equal(calls, 0);

  await broker.callTool('repo_map', { task: 'x' });
  assert.equal(calls, 1);
});

test('a call still running at 10s returns a timeout error', { timeout: 2000 }, async (t) => {
  const broker = new Broker(await createRepo({}));
  stubHandler(broker, 'repoMap', HANG);
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
  stubHandler(broker, 'repoMap', HANG);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const pending = broker.callTool('repo_map', { task: 'x' });
  t.mock.timers.tick(10_000);
  await pending;

  const entry = (await readAuditEntries(root)).at(-1);
  assert.equal(entry?.tool, 'repo_map');
  assert.equal(entry?.outcome, 'timeout');
});

test('a call that finishes before 10s is unaffected by the timeout', { timeout: 2000 }, async (t) => {
  const broker = new Broker(await createRepo({}));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubHandler(broker, 'repoMap', () =>
    new Promise((resolve) => setTimeout(() => resolve({ text: 'map', baselineTokens: 10 }), 9_999)));

  const pending = broker.callTool('repo_map', { task: 'x' });
  t.mock.timers.tick(9_999);
  const outcome = await pending;
  assert.equal(outcome.isError, undefined);
  assert.match(outcome.text, /^map\n/);
});

test('cancelled calls are recorded in the audit log with outcome cancelled', { timeout: 2000 }, async () => {
  const root = await createRepo({});
  const broker = new Broker(root);
  stubHandler(broker, 'repoMap', HANG);

  const running = new AbortController();
  const pending = broker.callTool('repo_map', { task: 'x' }, running.signal);
  running.abort();
  await pending;

  const queued = new AbortController();
  queued.abort();
  await broker.callTool('route_task', { task: 'x' }, queued.signal);

  const entries = await readAuditEntries(root);
  assert.deepEqual(entries.map((entry) => [entry.tool, entry.outcome]), [
    ['repo_map', 'cancelled'],
    ['route_task', 'cancelled']
  ]);
});

const BROKER_SOURCE = [
  "import { scan } from './scan';",
  '',
  'export class Broker {',
  '  run() {}',
  '}',
  ''
].join('\n');

test('find_symbol returns ranked path:line hits with signatures: exact, then case-insensitive, then prefix', async () => {
  const broker = new Broker(await createRepo({
    'src/broker/tools.ts': BROKER_SOURCE,
    'src/legacy.ts': 'export function broker() {\n}\n',
    'src/factory.ts': 'export function BrokerFactory() {\n}\n',
    'src/other.ts': 'export function unrelated() {}\n'
  }));
  const outcome = await broker.callTool('find_symbol', { name: 'Broker' });
  assert.equal(outcome.isError, undefined);
  assert.deepEqual(outcome.text.split('\n').slice(0, 3), [
    'src/broker/tools.ts:3  export class Broker',
    'src/legacy.ts:1  export function broker()',
    'src/factory.ts:1  export function BrokerFactory()'
  ]);
  assert.doesNotMatch(outcome.text, /unrelated/);
});

test('find_symbol returns at most limit hits, default 10, then says how many more there are', async () => {
  const source = Array.from({ length: 12 }, (_, index) => `export function handler${index}() {\n}\n`).join('');
  const broker = new Broker(await createRepo({ 'src/handlers.ts': source }));

  const byDefault = (await broker.callTool('find_symbol', { name: 'handler' })).text.split('\n');
  assert.equal(byDefault.filter((line) => line.startsWith('src/handlers.ts:')).length, 10);
  assert.equal(byDefault[10], '2 more; narrow with targetPath');

  const limited = (await broker.callTool('find_symbol', { name: 'handler', limit: 3 })).text.split('\n');
  assert.equal(limited.filter((line) => line.startsWith('src/handlers.ts:')).length, 3);
  assert.equal(limited[3], '9 more; narrow with targetPath');
});

test('find_symbol with no match returns an error with up to 3 close names', async () => {
  const broker = new Broker(await createRepo({
    'src/broker/tools.ts': BROKER_SOURCE,
    'src/names.ts': [
      'export function createBrokerClient() {', '}',
      'export function brokerage() {', '}',
      'export function BrokerError() {', '}',
      'export function unrelated() {', '}',
      ''
    ].join('\n')
  }));

  const typo = await broker.callTool('find_symbol', { name: 'Brokr' });
  assert.equal(typo.isError, true);
  assert.equal(typo.text, 'No symbol "Brokr". Close names: Broker.');

  const nothing = await broker.callTool('find_symbol', { name: 'zzzzzz' });
  assert.equal(nothing.isError, true);
  assert.equal(nothing.text, 'No symbol "zzzzzz".');

  const many = await broker.callTool('find_symbol', { name: 'roker' });
  assert.equal(many.isError, true);
  assert.equal(many.text, 'No symbol "roker". Close names: Broker, brokerage, BrokerError.');
});

test('find_symbol never returns hits from secret paths', async () => {
  const broker = new Broker(await createRepo({
    'src/app.ts': 'export function loadConfig() {\n}\n',
    '.env': 'export function loadConfig() {\n}\n',
    'src/secrets.ts': 'export function loadConfig() {\n}\n'
  }));
  const outcome = await broker.callTool('find_symbol', { name: 'loadConfig' });
  assert.equal(outcome.isError, undefined);
  assert.match(outcome.text, /^src\/app\.ts:1 /);
  assert.doesNotMatch(outcome.text, /\.env|secrets\.ts/);
});

test('find_symbol limits hits to targetPath and blocks a targetPath outside the repository', async () => {
  const broker = new Broker(await createRepo({
    'src/broker/tools.ts': BROKER_SOURCE,
    'lib/broker.ts': 'export class Broker {\n}\n'
  }));

  const scoped = await broker.callTool('find_symbol', { name: 'Broker', targetPath: 'src/broker' });
  assert.equal(scoped.isError, undefined);
  assert.match(scoped.text, /^src\/broker\/tools\.ts:3 /);
  assert.doesNotMatch(scoped.text, /lib\/broker\.ts/);

  const outside = await broker.callTool('find_symbol', { name: 'Broker', targetPath: '../elsewhere' });
  assert.equal(outside.isError, true);
  assert.equal(outside.text, 'Blocked: path is outside the repository.');
});

test('find_symbol obeys input validation, the 10s timeout, and cancellation', { timeout: 2000 }, async (t) => {
  const broker = new Broker(await createRepo({ 'src/broker/tools.ts': BROKER_SOURCE }));
  const invalid = await broker.callTool('find_symbol', { name: 'Broker', limit: 11 });
  assert.equal(invalid.text, 'Invalid input: limit must be an integer from 1 to 10 (got 11).');

  const cancel = new AbortController();
  cancel.abort();
  const cancelled = await broker.callTool('find_symbol', { name: 'Broker' }, cancel.signal);
  assert.equal(cancelled.text, 'Cancelled.');

  stubHandler(broker, 'findSymbol', HANG);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = broker.callTool('find_symbol', { name: 'Broker' });
  t.mock.timers.tick(10_000);
  assert.equal((await pending).text, 'Timed out after 10s. Narrow targetPath or the request.');
});

test('list_repositories without a catalog lists the root as the only repository and carries no estimate', async () => {
  const root = await createRepo({ 'src/app.ts': 'export function app() {}\n' });
  const outcome = await new Broker(root).callTool('list_repositories', {});
  assert.equal(outcome.isError, undefined);
  const lines = outcome.text.split('\n');
  assert.equal(lines[0], 'No tokio.repos.json; the root is the only repository and the write target.');
  assert.match(lines[1], /^tokio-tools-\S+  write  \S+$/);
  assert.equal(lines.length, 2);
  assert.doesNotMatch(outcome.text, /tokio estimate/);
});

test('list_repositories reads tokio.repos.json, marks missing paths, and gives the merge order', async () => {
  const root = await createRepo({
    'tokio.repos.json': JSON.stringify({
      default: 'frontend',
      repos: [
        { name: 'frontend', path: 'frontend', purpose: 'React UI', dependsOn: ['shared', 'backend'] },
        { name: 'backend', path: 'backend', dependsOn: ['shared'] },
        { name: 'shared', path: 'shared' }
      ]
    }),
    'frontend/src/app.ts': 'export function app() {}\n',
    'shared/index.ts': 'export interface User {}\n'
  });
  const outcome = await new Broker(root).callTool('list_repositories', {});
  assert.equal(outcome.isError, undefined);
  const lines = outcome.text.split('\n');
  assert.equal(lines[0], 'Repositories from tokio.repos.json. Write target: frontend; the others are read-only.');
  assert.match(lines[1], /^frontend  write  \S+\/frontend  React UI \(depends on: shared, backend\)$/);
  assert.match(lines[2], /^backend   read   \S+\/backend\s+\(depends on: shared\)  \[missing\]$/);
  assert.match(lines[3], /^shared    read   \S+\/shared$/);
  assert.equal(lines[4], 'Merge order: shared, backend, frontend');
});

test('an invalid catalog is an error for list_repositories and the repository-aware tools, not for refine_task', async () => {
  const root = await createRepo({
    'tokio.repos.json': JSON.stringify({ default: 'web', repos: [{ name: 'app', path: '.' }] }),
    'src/auth/login.ts': LOGIN_SOURCE
  });
  const broker = new Broker(root);
  const outcome = await broker.callTool('list_repositories', {});
  assert.equal(outcome.isError, true);
  assert.equal(outcome.text, 'Invalid tokio.repos.json: "default" must name a repository in "repos" (got "web"; names: app).');

  // Repository-aware tools need the catalog, so they report the same problem. refine_task reads no files.
  for (const [tool, args] of [
    ['repo_map', { task: 'fix login redirect' }],
    ['read_symbol', { path: 'src/auth/login.ts' }],
    ['find_symbol', { name: 'login' }],
    ['route_task', { task: 'fix login redirect' }]
  ] as const) {
    const failed = await broker.callTool(tool, args);
    assert.equal(failed.isError, true, tool);
    assert.equal(failed.text, outcome.text, tool);
  }
  const refined = await broker.callTool('refine_task', { task: 'fix login redirect' });
  assert.equal(refined.isError, undefined);
});

test('list_repositories ignores unknown input fields and obeys cancellation', async () => {
  const broker = new Broker(await createRepo({}));
  const plain = await broker.callTool('list_repositories', {});
  const extra = await broker.callTool('list_repositories', { verbose: true });
  assert.equal(extra.text, plain.text);

  const cancel = new AbortController();
  cancel.abort();
  const cancelled = await broker.callTool('list_repositories', {}, cancel.signal);
  assert.equal(cancelled.text, 'Cancelled.');
});

/** tokio, api, and web as sibling folders; messaging between them starts off. */
async function createAskWorkspace(): Promise<{ root: string; api: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'tokio-ask-'));
  const root = join(parent, 'tokio');
  for (const folder of ['tokio', 'hierpayroll-v3-api', 'hierpayroll-v3-web']) {
    await mkdir(join(parent, folder), { recursive: true });
  }
  await writeFile(join(root, 'tokio.repos.json'), JSON.stringify({
    default: 'tokio',
    repos: [
      { name: 'tokio', path: '.' },
      { name: 'hierpayroll-v3-api', path: '../hierpayroll-v3-api' },
      { name: 'hierpayroll-v3-web', path: '../hierpayroll-v3-web' }
    ]
  }), 'utf8');
  return { root, api: join(parent, 'hierpayroll-v3-api') };
}

/** A stand-in agent that records where it ran and what it was asked. */
function fakeAgent(broker: Broker, stdout: string): { calls: { cwd: string; prompt: string }[] } {
  const record = { calls: [] as { cwd: string; prompt: string }[] };
  broker.runAgent = async (cwd: string, prompt: string) => {
    record.calls.push({ cwd, prompt });
    return { stdout, stderr: '', exitCode: 0 };
  };
  return record;
}

test('ask_repo is refused while messaging with the repository is off, and starts no agent', async () => {
  const { root } = await createAskWorkspace();
  const broker = new Broker(root);
  const agent = fakeAgent(broker, '{}');
  const outcome = await broker.callTool('ask_repo', { repo: 'api', question: 'why is this needed?' });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.text, /Messaging with hierpayroll-v3-api is off/);
  assert.equal(agent.calls.length, 0);
});

test('ask_repo runs the agent in the resolved repository and returns its redacted answer', async () => {
  const { root, api } = await createAskWorkspace();
  const { setConnection } = await import('./messaging');
  await setConnection(root, 'hierpayroll-v3-api', true);
  const broker = new Broker(root);
  const agent = fakeAgent(broker, JSON.stringify({ type: 'result', is_error: false, result: 'It boots the queue. See config/queue.php:12. Key: AKIAABCDEFGHIJKLMNOP' }));
  const outcome = await broker.callTool('ask_repo', { repo: 'API', question: 'why is the queue set up with AKIAABCDEFGHIJKLMNOP?' });

  assert.equal(outcome.isError, false);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0].cwd, api);
  assert.match(agent.calls[0].prompt, /You are the agent for the hierpayroll-v3-api repository\. The agent working in tokio asks/);
  assert.doesNotMatch(agent.calls[0].prompt, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(outcome.text, /^Answer from the hierpayroll-v3-api agent:\n\nIt boots the queue\. See config\/queue\.php:12\./);
  assert.doesNotMatch(outcome.text, /AKIAABCDEFGHIJKLMNOP/);

  const [entry] = (await readAuditEntries(root)).filter((candidate) => candidate.tool === 'ask_repo');
  assert.deepEqual(entry.repos, ['hierpayroll-v3-api']);
  assert.equal(JSON.stringify(entry).includes('queue'), false);
});

test('ask_repo rejects unknown, ambiguous, and own repository names, and reports a failed agent run', async () => {
  const { root } = await createAskWorkspace();
  const { setConnection } = await import('./messaging');
  await setConnection(root, 'hierpayroll-v3-api', true);
  const broker = new Broker(root);
  fakeAgent(broker, JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' }));

  assert.match((await broker.callTool('ask_repo', { repo: 'nope', question: 'q' })).text, /No repository is called "nope"/);
  assert.match((await broker.callTool('ask_repo', { repo: 'hierpayroll', question: 'q' })).text, /matches hierpayroll-v3-api, hierpayroll-v3-web/);
  assert.match((await broker.callTool('ask_repo', { repo: 'tokio', question: 'q' })).text, /is this repository/);
  assert.equal((await broker.callTool('ask_repo', { repo: 'api', question: '' })).isError, true);
  const failed = await broker.callTool('ask_repo', { repo: 'api', question: 'q' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /Credit balance is too low/);
});

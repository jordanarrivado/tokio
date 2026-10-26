import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Broker } from './tools';

const CATALOG = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: 'frontend', dependsOn: ['shared', 'backend'] },
    { name: 'backend', path: 'backend', dependsOn: ['shared'] },
    { name: 'shared', path: 'shared' }
  ]
};

const FILES: Record<string, string> = {
  'frontend/package.json': JSON.stringify({ name: 'web' }),
  'frontend/src/profile.tsx': "import { UserAvatar } from '@org/shared';\n\nexport function ProfilePage() {\n}\n",
  'frontend/src/x.ts': 'export function x() {\n}\n',
  'backend/src/api/upload.ts': 'export function uploadAvatar() {\n}\n',
  'backend/src/x.ts': 'export function x() {\n  return "backend";\n}\n',
  'shared/package.json': JSON.stringify({ name: '@org/shared', main: 'dist/index.js' }),
  'shared/src/index.ts': "export * from './avatar';\n",
  'shared/src/avatar.ts': 'export interface UserAvatar {\n}\n',
  'shared/src/billing.ts': 'export function invoice() {\n}\n',
  'shared/src/util.ts': 'export function noop() {\n}\n'
};

async function createWorkspace(catalog: object = CATALOG, files: Record<string, string> = FILES): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-repos-'));
  for (const [path, content] of Object.entries({ ...files, 'tokio.repos.json': JSON.stringify(catalog) })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

/** The file lines of a map: unindented lines after the header, without the footers. */
function mapFiles(text: string): string[] {
  return text.split('\n').slice(1).filter((line) => !line.startsWith(' ') && !/^\[(?:\d+ tokens|tokio estimate)/.test(line));
}

test('repo_map over several repositories labels every file with its repository and logs repo/path', async () => {
  const broker = new Broker(await createWorkspace());
  const outcome = await broker.callTool('repo_map', { task: 'profile page layout' });
  assert.equal(outcome.isError, undefined);
  const files = mapFiles(outcome.text);
  assert.ok(files.length > 0);
  for (const line of files) {
    assert.match(line, /^\[(?:frontend|backend|shared)\] \S+$/);
  }
  assert.equal(files[0], '[frontend] src/profile.tsx');
  assert.ok(outcome.files?.includes('frontend/src/profile.tsx'));
});

test('repo_map ranks a package file that another repository imports above its unrelated neighbours', async () => {
  const outcome = await new Broker(await createWorkspace()).callTool('repo_map', { task: 'profile page layout' });
  const files = mapFiles(outcome.text);
  const at = (line: string): number => files.indexOf(line);
  assert.ok(at('[shared] src/avatar.ts') >= 0);
  assert.ok(at('[shared] src/avatar.ts') < at('[shared] src/billing.ts'));
  assert.ok(at('[shared] src/avatar.ts') < at('[shared] src/util.ts'));
  // Same score: the default repository comes first, although backend sorts first by name.
  assert.ok(at('[frontend] src/x.ts') < at('[backend] src/x.ts'));
});

test('repo_map with repo covers only that repository, and targetPath is relative to it', async () => {
  const broker = new Broker(await createWorkspace());
  const outcome = await broker.callTool('repo_map', { task: 'layout', repo: 'backend', targetPath: 'src/api/upload.ts' });
  const files = mapFiles(outcome.text);
  assert.deepEqual(files, ['[backend] src/api/upload.ts', '[backend] src/x.ts']);

  const outside = await broker.callTool('repo_map', { task: 'layout', repo: 'backend', targetPath: '../frontend/src/x.ts' });
  assert.equal(outside.text, 'Blocked: path is outside the repository.');
});

test('read_symbol reads from the named repository, the default without one, and keys repeat reads by repository', async () => {
  const broker = new Broker(await createWorkspace());
  const backend = await broker.callTool('read_symbol', { repo: 'backend', path: 'src/x.ts' });
  assert.match(backend.text, /^1\| export function x\(\) \{\n2\|   return "backend";/);
  assert.deepEqual(backend.files, ['backend/src/x.ts']);

  const frontend = await broker.callTool('read_symbol', { path: 'src/x.ts' });
  assert.match(frontend.text, /^1\| export function x\(\) \{\n2\| \}/);
  assert.deepEqual(frontend.files, ['frontend/src/x.ts']);

  const again = await broker.callTool('read_symbol', { repo: 'backend', path: 'src/x.ts' });
  assert.match(again.text, /^Unchanged since the last read of \[backend\] src\/x\.ts:1-\d+ in this session\./);

  const outside = await broker.callTool('read_symbol', { repo: 'backend', path: '../frontend/src/x.ts' });
  assert.equal(outside.isError, true);
  assert.equal(outside.text, 'Blocked: path is outside the repository.');
});

test('find_symbol searches every repository, puts the default first on ties, and scopes targetPath to a repository', async () => {
  const broker = new Broker(await createWorkspace());
  const outcome = await broker.callTool('find_symbol', { name: 'x' });
  assert.deepEqual(outcome.text.split('\n').slice(0, 2), [
    '[frontend] src/x.ts:1  export function x()',
    '[backend] src/x.ts:1  export function x()'
  ]);

  const limited = await broker.callTool('find_symbol', { name: 'x', limit: 1 });
  assert.equal(limited.text.split('\n')[1], '1 more; narrow with repo or targetPath');

  const scoped = await broker.callTool('find_symbol', { name: 'x', targetPath: 'src' });
  assert.equal(scoped.text.split('\n')[0], '[frontend] src/x.ts:1  export function x()');
  assert.doesNotMatch(scoped.text, /\[backend\]/);

  const inBackend = await broker.callTool('find_symbol', { name: 'x', repo: 'backend' });
  assert.equal(inBackend.text.split('\n')[0], '[backend] src/x.ts:1  export function x()');
});

test('route_task names the write target, the read-only repositories with relevant files, and where most of them are', async () => {
  const outcome = await new Broker(await createWorkspace()).callTool('route_task', { task: 'fix the uploadAvatar upload api' });
  assert.equal(outcome.isError, undefined);
  const lines = outcome.text.split('\n');
  assert.equal(lines.at(-2), 'Repositories: write frontend; read backend');
  assert.equal(lines.at(-1), 'Most relevant files are in backend, which is read-only. Ask the user before editing it.');
});

test('an unknown repository is an error for every repository-aware tool', async () => {
  const broker = new Broker(await createWorkspace());
  for (const [tool, args] of [
    ['repo_map', { task: 'layout', repo: 'api' }],
    ['read_symbol', { path: 'src/x.ts', repo: 'api' }],
    ['find_symbol', { name: 'x', repo: 'api' }],
    ['route_task', { task: 'layout', repo: 'api' }]
  ] as const) {
    const outcome = await broker.callTool(tool, args);
    assert.equal(outcome.isError, true, tool);
    assert.equal(outcome.text, 'Unknown repository "api". Repositories: frontend, backend, shared.', tool);
  }
});

test('a missing repository is skipped with a note, and an error when named', async () => {
  const catalog = { ...CATALOG, repos: [...CATALOG.repos, { name: 'docs', path: 'docs' }] };
  const root = await createWorkspace(catalog);
  const broker = new Broker(root);
  const map = await broker.callTool('repo_map', { task: 'profile page layout' });
  assert.equal(map.isError, undefined);
  assert.match(map.text, /skipped missing docs\]/);

  const named = await broker.callTool('read_symbol', { repo: 'docs', path: 'README.md' });
  assert.equal(named.isError, true);
  assert.equal(named.text, `Repository "docs" is missing: ${join(root, 'docs').replaceAll('\\', '/')} is not a directory.`);
});

test('a catalog with one repository keeps the output of every tool unchanged', async () => {
  const files = { 'src/auth/login.ts': 'export function login() {\n}\n', 'src/store.ts': 'export class Store {\n}\n' };
  const plain = await mkdtemp(join(tmpdir(), 'tokio-repos-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(plain, path, '..'), { recursive: true });
    await writeFile(join(plain, path), content, 'utf8');
  }
  const cataloged = await createWorkspace({ default: 'app', repos: [{ name: 'app', path: '.' }] }, files);

  for (const [tool, args] of [
    ['repo_map', { task: 'fix login' }],
    ['read_symbol', { path: 'src/auth/login.ts' }],
    ['find_symbol', { name: 'Store' }]
  ] as const) {
    const before = await new Broker(plain).callTool(tool, args);
    const after = await new Broker(cataloged).callTool(tool, args);
    assert.equal(after.text, before.text, tool);
  }
});

const INDEPENDENT = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: 'frontend' },
    { name: 'backend', path: 'backend' },
    { name: 'shared', path: 'shared' }
  ]
};

function mapRepos(text: string): string[] {
  return [...new Set(mapFiles(text).map((line) => /^\[([^\]]+)\]/.exec(line)?.[1] ?? ''))];
}

test('repo_map without repo covers only a repository the task names, plus the write target', async () => {
  const broker = new Broker(await createWorkspace(INDEPENDENT));
  const outcome = await broker.callTool('repo_map', { task: 'fix the upload endpoint in backend' });
  assert.deepEqual(mapRepos(outcome.text).sort(), ['backend', 'frontend']);
  assert.match(outcome.text, /\[\d+ tokens; repos frontend, backend picked for this task; pass repo: "\*" for all/);
  assert.deepEqual(outcome.repos?.sort(), ['backend', 'frontend']);
});

test('repo_map without a named repository picks the ones with relevant files', async () => {
  const outcome = await new Broker(await createWorkspace(INDEPENDENT)).callTool('repo_map', { task: 'change the billing invoice totals' });
  assert.deepEqual(mapRepos(outcome.text).sort(), ['frontend', 'shared']);
  assert.match(outcome.text, /repos frontend, shared picked for this task/);
});

test('the pick adds the direct dependencies of each matched repository', async () => {
  const catalog = { ...INDEPENDENT, repos: [INDEPENDENT.repos[0], { ...INDEPENDENT.repos[1], dependsOn: ['shared'] }, INDEPENDENT.repos[2]] };
  const outcome = await new Broker(await createWorkspace(catalog)).callTool('repo_map', { task: 'fix the upload endpoint in backend' });
  assert.deepEqual(mapRepos(outcome.text).sort(), ['backend', 'frontend', 'shared']);
  assert.doesNotMatch(outcome.text, /picked for this task/);
});

test('repo "*" and a task that matches nothing keep every repository', async () => {
  const broker = new Broker(await createWorkspace(INDEPENDENT));
  const all = await broker.callTool('repo_map', { task: 'fix the upload endpoint in backend', repo: '*' });
  assert.deepEqual(mapRepos(all.text).sort(), ['backend', 'frontend', 'shared']);
  assert.doesNotMatch(all.text, /picked for this task/);

  const vague = await broker.callTool('repo_map', { task: 'zzzz qqqq' });
  assert.deepEqual(mapRepos(vague.text).sort(), ['backend', 'frontend', 'shared']);

  const found = await broker.callTool('find_symbol', { name: 'x', repo: '*' });
  assert.match(found.text, /^\[frontend\] src\/x\.ts:1 /);
});

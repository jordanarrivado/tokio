import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCatalog, runDoctor } from './doctor';
import { initProject, MULTI_REPO_GUIDANCE } from './init';
import { formatStats, readAuditEntries, summarizeAudit, type StoredAuditEntry } from './stats';
import { Broker } from './tools';

const CATALOG = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: 'frontend' },
    { name: 'backend', path: 'backend' }
  ]
};

async function createWorkspace(files: Record<string, string>, catalog: object | null = CATALOG): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-repo-audit-'));
  const all = catalog === null ? files : { ...files, 'tokio.repos.json': JSON.stringify(catalog) };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

const FILES = {
  'frontend/src/app.ts': 'export function app() {\n}\n',
  'backend/src/api.ts': 'export function api() {\n}\n'
};

function entry(overrides: Partial<StoredAuditEntry>): StoredAuditEntry {
  return { timestamp: '2026-10-26T00:00:00Z', tool: 'repo_map', inputTokens: 1, outputTokens: 1, files: [], redactions: [], blocked: false, ...overrides };
}

test('audit entries name the repositories a call drew on, and files carry their repository', async () => {
  const root = await createWorkspace(FILES);
  const broker = new Broker(root);
  await broker.callTool('repo_map', { task: 'app api' });
  await broker.callTool('read_symbol', { repo: 'backend', path: 'src/api.ts' });
  await broker.callTool('find_symbol', { name: 'app' });

  const entries = await readAuditEntries(root);
  assert.deepEqual(entries.map((logged) => logged.repos), [['frontend', 'backend'], ['backend'], ['frontend']]);
  assert.deepEqual(entries[1].files, ['backend/src/api.ts']);
});

test('with one repository, audit entries carry no repos field', async () => {
  const root = await createWorkspace({ 'src/app.ts': 'export function app() {\n}\n' }, null);
  await new Broker(root).callTool('repo_map', { task: 'app' });
  const [logged] = await readAuditEntries(root);
  assert.equal('repos' in logged, false);
  assert.deepEqual(logged.files, ['src/app.ts']);
});

test('stats add a by-repo section only when entries name more than one repository', () => {
  const two = summarizeAudit([
    entry({ repos: ['frontend', 'backend'] }),
    entry({ repos: ['backend'] }),
    entry({ tool: 'Edit', blocked: true, repos: ['backend'] }),
    entry({})
  ]);
  assert.deepEqual(two.byRepo, { frontend: { calls: 1, blocked: 0 }, backend: { calls: 3, blocked: 1 } });
  const text = formatStats(two, 'this session');
  assert.match(text, /\n {2}by repo:\n {4}backend {8}calls 3 \(blocked 1\)\n {4}frontend {7}calls 1 \(blocked 0\)$/);

  const one = formatStats(summarizeAudit([entry({ repos: ['backend'] })]), 'this session');
  assert.doesNotMatch(one, /by repo/);
});

test('doctor reports an invalid catalog as a failure with the catalog message', async () => {
  const root = await createWorkspace({}, { default: 'web', repos: [{ name: 'app', path: '.' }] });
  assert.deepEqual(await checkCatalog(root, true), [{
    level: 'fail',
    name: 'tokio.repos.json',
    detail: 'Invalid tokio.repos.json: "default" must name a repository in "repos" (got "web"; names: app).'
  }]);
});

test('doctor fails a missing repository path, warns on a non-git one, and passes a git one', async () => {
  const root = await createWorkspace({ 'frontend/.git/HEAD': 'ref: refs/heads/main\n', 'shared/README.md': '' }, {
    default: 'frontend',
    repos: [{ name: 'frontend', path: 'frontend' }, { name: 'backend', path: 'backend' }, { name: 'shared', path: 'shared' }]
  });
  const checks = await checkCatalog(root, true);
  const level = (name: string) => checks.find((check) => check.name === name)?.level;
  assert.equal(level('tokio.repos.json'), 'ok');
  assert.equal(level('repo frontend'), 'ok');
  assert.match(checks.find((check) => check.name === 'repo frontend')?.detail ?? '', /\(write target\)\.$/);
  assert.equal(level('repo backend'), 'fail');
  assert.match(checks.find((check) => check.name === 'repo backend')?.detail ?? '', /backend is not a directory\./);
  assert.equal(level('repo shared'), 'warn');
});

test('doctor warns that write scope is not enforced when several repositories have no tokio hook', async () => {
  const root = await createWorkspace(FILES);
  const unenforced = await checkCatalog(root, false);
  assert.ok(unenforced.some((check) => check.level === 'warn' && /read-only repositories are not enforced/.test(check.detail)));
  assert.ok(!(await checkCatalog(root, true)).some((check) => /not enforced/.test(check.detail)));

  // runDoctor wires the hook check in: this workspace has no .claude/settings.json.
  assert.ok((await runDoctor(root)).some((check) => /not enforced/.test(check.detail)));

  const single = await createWorkspace({}, null);
  assert.deepEqual(await checkCatalog(single, false), [{ level: 'info', name: 'tokio.repos.json', detail: 'none; the root is the only repository.' }]);
});

test('init adds the multi-repository rules to the AGENTS.md block only when the catalog lists several repositories', async () => {
  const multi = await createWorkspace(FILES);
  await initProject({ root: multi, cliPath: join(multi, 'cli.js') });
  const agents = await readFile(join(multi, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes(MULTI_REPO_GUIDANCE));
  assert.match(agents, /same branch name in every repository/);

  const single = await createWorkspace({}, null);
  await initProject({ root: single, cliPath: join(single, 'cli.js') });
  assert.doesNotMatch(await readFile(join(single, 'AGENTS.md'), 'utf8'), /Several repositories/);
});

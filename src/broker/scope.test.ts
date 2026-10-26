import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initProject } from './init';
import { clearScope, evaluateWriteScope, grantScope, readGrants, SCOPE_FILE } from './scope';

const CLI = join(__dirname, 'cli.js');
const NOW = new Date('2026-10-26T12:00:00Z');
const CATALOG = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: 'frontend' },
    { name: 'backend', path: 'backend' }
  ]
};

async function createWorkspace(catalog: object | string = CATALOG): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-scope-'));
  await mkdir(join(root, 'frontend'));
  await mkdir(join(root, 'backend'));
  await writeFile(join(root, 'tokio.repos.json'), typeof catalog === 'string' ? catalog : JSON.stringify(catalog), 'utf8');
  return root;
}

function edit(path: string): Record<string, unknown> {
  return { file_path: path, old_string: 'a', new_string: 'b' };
}

test('edits in a read-only repository are blocked until the user grants it, and again after clear or expiry', async () => {
  const root = await createWorkspace();
  const target = join(root, 'backend', 'src', 'upload.ts');

  const blocked = await evaluateWriteScope('Edit', edit(target), root, NOW);
  assert.equal(blocked?.blocked, true);
  assert.equal(blocked?.reason, 'backend is read-only for this task. Ask the user to run: tokio scope backend');

  await grantScope(root, ['backend'], 4, NOW);
  assert.equal(await evaluateWriteScope('Edit', edit(target), root, NOW), undefined);
  assert.equal(await evaluateWriteScope('Write', { file_path: 'backend/new.ts', content: '' }, root, NOW), undefined);

  const later = new Date(NOW.getTime() + 4 * 3_600_000 + 1);
  assert.equal((await evaluateWriteScope('Edit', edit(target), root, later))?.blocked, true);

  await grantScope(root, ['backend'], 1, NOW);
  await clearScope(root);
  assert.equal((await evaluateWriteScope('Edit', edit(target), root, NOW))?.blocked, true);
});

test('edits in the default repository, outside every repository, and reads anywhere are unchanged', async () => {
  const root = await createWorkspace();
  assert.equal(await evaluateWriteScope('Edit', edit(join(root, 'frontend', 'app.ts')), root, NOW), undefined);
  assert.equal(await evaluateWriteScope('Write', { file_path: join(tmpdir(), 'notes.md') }, root, NOW), undefined);
  assert.equal(await evaluateWriteScope('Read', { file_path: join(root, 'backend', 'x.ts') }, root, NOW), undefined);
  assert.equal(await evaluateWriteScope('Bash', { command: 'npm test' }, root, NOW), undefined);
  assert.equal((await evaluateWriteScope('NotebookEdit', { notebook_path: 'backend/a.ipynb' }, root, NOW))?.blocked, true);
  assert.equal((await evaluateWriteScope('MultiEdit', { file_path: 'backend/a.ts' }, root, NOW))?.blocked, true);
});

test('without a catalog file nothing is read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-scope-'));
  assert.equal(await evaluateWriteScope('Edit', edit(join(root, 'src', 'a.ts')), root, NOW), undefined);
});

test('an invalid catalog blocks edits, because the read-only repositories are unknown', async () => {
  const root = await createWorkspace('{ not json');
  const verdict = await evaluateWriteScope('Edit', edit(join(root, 'frontend', 'a.ts')), root, NOW);
  assert.equal(verdict?.blocked, true);
  assert.match(verdict?.reason ?? '', /^Invalid tokio\.repos\.json: not valid JSON .* Fix it before editing files\.$/);
});

test('the agent cannot grant itself write scope through the scope file or the scope command', async () => {
  const root = await createWorkspace();
  const attempts: [string, Record<string, unknown>][] = [
    ['Write', { file_path: join(root, '.tokio', 'scope.json'), content: '{}' }],
    ['Edit', edit('.tokio/scope.json')],
    ['Bash', { command: 'tokio scope backend' }],
    ['Bash', { command: 'node D:/tokio/out/broker/cli.js scope backend --hours 24' }],
    ['Bash', { command: 'cd x && "node" out/broker/cli.js scope backend' }],
    ['Bash', { command: 'echo {} > .tokio/scope.json' }],
    ['PowerShell', { command: 'Set-Content .tokio\\scope.json "{}"' }]
  ];
  for (const [tool, input] of attempts) {
    const verdict = await evaluateWriteScope(tool, input, root, NOW);
    assert.equal(verdict?.blocked, true, JSON.stringify(input));
    assert.match(verdict?.reason ?? '', /^only the user can change write scope/);
  }
  assert.equal(await evaluateWriteScope('Bash', { command: 'git log --oneline -- scope.ts' }, root, NOW), undefined);
});

test('grantScope rejects unknown names and bad hours, skips the default, and replaces earlier grants', async () => {
  const root = await createWorkspace();
  await assert.rejects(grantScope(root, ['api'], 4, NOW), /^Error: Unknown repository "api"\. Repositories: frontend, backend\.$/);
  await assert.rejects(grantScope(root, ['backend'], 25, NOW), /--hours must be an integer from 1 to 24/);
  await assert.rejects(grantScope(root, ['backend'], 1.5, NOW), /--hours must be an integer from 1 to 24/);

  await grantScope(root, ['backend', 'frontend'], 2, NOW);
  await grantScope(root, ['backend'], 6, NOW);
  assert.deepEqual(await readGrants(root, NOW), [{ repo: 'backend', expiresAt: '2026-10-26T18:00:00.000Z' }]);
  assert.deepEqual(await readGrants(root, new Date('2026-10-26T18:00:00Z')), []);
});

test('a corrupt scope file grants nothing', async () => {
  const root = await createWorkspace();
  await mkdir(join(root, '.tokio'));
  await writeFile(join(root, SCOPE_FILE), '{ "grants": [ { "repo": "backend" } ] }', 'utf8');
  assert.deepEqual(await readGrants(root, NOW), []);
  await writeFile(join(root, SCOPE_FILE), 'nonsense', 'utf8');
  assert.deepEqual(await readGrants(root, NOW), []);
});

test('the hook command blocks a read-only edit with exit 2, and tokio scope grants and clears it', async () => {
  const root = await createWorkspace();
  const hook = (): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [CLI, 'hook'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: edit(join(root, 'backend', 'a.ts')), cwd: root }),
    encoding: 'utf8'
  });
  const scope = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [CLI, 'scope', ...args, '--root', root], { encoding: 'utf8' });

  const denied = hook();
  assert.equal(denied.status, 2);
  assert.equal(denied.stderr, 'Tokio blocked Edit: backend is read-only for this task. Ask the user to run: tokio scope backend\n');

  const granted = scope('backend', '--hours', '2');
  assert.equal(granted.status, 0);
  assert.match(String(granted.stdout), /^Write target: frontend \(default\)\.\nAlso writable: backend until \S+Z\.\n$/);
  assert.equal(hook().status, 0);

  const shown = scope();
  assert.match(String(shown.stdout), /Also writable: backend/);

  const cleared = scope('--clear');
  assert.equal(cleared.stdout, 'Write target: frontend (default).\nNo other repository is writable.\n');
  assert.equal(hook().status, 2);

  const unknown = scope('api');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stderr, 'Unknown repository "api". Repositories: frontend, backend.\n');
});

test('init adds the scope file to .gitignore once, keeping existing lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-scope-'));
  await writeFile(join(root, '.gitignore'), 'node_modules/', 'utf8');
  const cliPath = join(root, 'cli.js');
  const first = await initProject({ root, cliPath });
  assert.equal(first.find((result) => result.path === '.gitignore')?.status, 'updated');
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.tokio/scope.json\n.tokio/layout.json\n');

  const second = await initProject({ root, cliPath });
  assert.equal(second.find((result) => result.path === '.gitignore')?.status, 'unchanged');
});

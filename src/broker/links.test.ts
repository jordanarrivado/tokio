import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { addDependency, addLink, CATALOG_FILE, parseCatalog, removeDependency, removeLink, removeRepo } from './catalog';
import { detectCrossRepoLinks } from './repos';
import { Broker } from './tools';

const ROOT = resolve(tmpdir(), 'tokio-links-work');
const BASE = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: 'frontend' },
    { name: 'backend', path: 'backend' },
    { name: 'shared', path: 'shared' }
  ]
};

function parse(links: unknown): ReturnType<typeof parseCatalog> {
  return parseCatalog(JSON.stringify({ ...BASE, links }), ROOT);
}

async function createWorkspace(files: Record<string, string>, catalog: object = BASE): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-links-'));
  for (const [path, content] of Object.entries({ ...files, [CATALOG_FILE]: JSON.stringify(catalog) })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

test('catalog links parse "repo:path" ends, default the kind, and trim the note', () => {
  const catalog = parse([
    { from: 'frontend:src/api/upload.ts', to: 'backend:./routes\\api.php', kind: 'api', note: '  POST /avatar  ' },
    { from: 'frontend:src/types.ts', to: 'shared:index.ts' }
  ]);
  assert.deepEqual(catalog.links, [
    { from: { repo: 'frontend', path: 'src/api/upload.ts' }, to: { repo: 'backend', path: 'routes/api.php' }, kind: 'api', note: 'POST /avatar' },
    { from: { repo: 'frontend', path: 'src/types.ts' }, to: { repo: 'shared', path: 'index.ts' }, kind: 'other' }
  ]);
  assert.deepEqual(parseCatalog(JSON.stringify(BASE), ROOT).links, []);
});

test('invalid catalog links name the problem', () => {
  const cases: [unknown, string][] = [
    [{}, '"links" must be an array.'],
    [['x'], 'links[0] must be an object with "from" and "to".'],
    [[{ from: 'frontend', to: 'backend:a.php' }], 'links[0].from must be "<repo>:<path>".'],
    [[{ from: 'api:a.ts', to: 'backend:a.php' }], 'links[0].from names unknown repository "api".'],
    [[{ from: 'frontend:../x.ts', to: 'backend:a.php' }], 'links[0].from must name a file inside frontend, relative to its root.'],
    [[{ from: 'frontend:/etc/x', to: 'backend:a.php' }], 'links[0].from must name a file inside frontend, relative to its root.'],
    [[{ from: 'frontend:C:/x.ts', to: 'backend:a.php' }], 'links[0].from must name a file inside frontend, relative to its root.'],
    [[{ from: 'frontend:.env', to: 'backend:a.php' }], 'links[0].from names a secret file.'],
    [[{ from: 'frontend:a.ts', to: 'frontend:b.ts' }], 'links[0] must connect two different repositories.'],
    [[{ from: 'frontend:a.ts', to: 'backend:a.php', kind: 'rpc' }], 'links[0].kind must be one of api, type, event, schema, config, other.'],
    [[{ from: 'frontend:a.ts', to: 'backend:a.php', note: 3 }], 'links[0].note must be a string.'],
    [[{ from: 'frontend:a.ts', to: 'backend:a.php' }, { from: 'backend:a.php', to: 'frontend:a.ts' }], 'links[1] repeats links[0].']
  ];
  for (const [links, message] of cases) {
    assert.throws(() => parse(links), { message: `Invalid tokio.repos.json: ${message}` });
  }
});

test('dependency and link edits keep the file valid, and removing a repository drops its links', async () => {
  const root = await createWorkspace({ 'frontend/a.ts': '', 'backend/a.php': '', 'shared/i.ts': '' });
  await addDependency(root, 'frontend', 'shared');
  await assert.rejects(addDependency(root, 'frontend', 'shared'), { message: 'frontend already depends on shared.' });
  await assert.rejects(addDependency(root, 'shared', 'frontend'), /dependsOn has a cycle: frontend -> shared -> frontend/);
  await addLink(root, { from: 'frontend:a.ts', to: 'backend:a.php', kind: 'api', note: 'POST /x' });
  await assert.rejects(addLink(root, { from: 'backend:a.php', to: 'frontend:a.ts' }), /repeats links\[0\]/);

  let saved = JSON.parse(await readFile(join(root, CATALOG_FILE), 'utf8'));
  assert.deepEqual(saved.repos[0].dependsOn, ['shared']);
  assert.deepEqual(saved.links, [{ from: 'frontend:a.ts', to: 'backend:a.php', kind: 'api', note: 'POST /x' }]);

  // Either direction removes it.
  await removeLink(root, 'backend:a.php', 'frontend:a.ts');
  await assert.rejects(removeLink(root, 'backend:a.php', 'frontend:a.ts'), { message: 'No link between backend:a.php and frontend:a.ts.' });
  await removeDependency(root, 'frontend', 'shared');
  await assert.rejects(removeDependency(root, 'frontend', 'shared'), { message: 'frontend does not depend on shared.' });

  await addLink(root, { from: 'frontend:a.ts', to: 'backend:a.php' });
  await addLink(root, { from: 'frontend:a.ts', to: 'shared:i.ts' });
  await removeRepo(root, 'backend');
  saved = JSON.parse(await readFile(join(root, CATALOG_FILE), 'utf8'));
  assert.deepEqual(saved.links, [{ from: 'frontend:a.ts', to: 'shared:i.ts', kind: 'other' }]);
});

test('a declared link ranks the linked file and brings its repository into an auto-picked map', async () => {
  const catalog = { ...BASE, links: [{ from: 'frontend:src/upload.ts', to: 'backend:routes/api.php', kind: 'api' }] };
  const root = await createWorkspace({
    'frontend/src/upload.ts': 'export function uploadAvatar() {\n}\n',
    'frontend/src/other.ts': 'export function other() {\n}\n',
    'backend/routes/api.php': '<?php\n',
    'backend/src/avatar.ts': 'export function storeAvatar() {\n}\n',
    'backend/src/unrelated.ts': 'export function unrelated() {\n}\n',
    'shared/src/types.ts': 'export interface Unrelated {\n}\n'
  }, catalog);
  const outcome = await new Broker(root).callTool('repo_map', { task: 'fix the upload page' });
  // The link pulls backend in; shared has no match and no link, so it stays out.
  assert.match(outcome.text, /repos frontend, backend picked for this task/);
  assert.doesNotMatch(outcome.text, /\[shared\]/);
});

test('detectCrossRepoLinks lists file pairs found from package imports', async () => {
  const root = await createWorkspace({
    'frontend/src/profile.tsx': "import { UserAvatar } from '@org/shared';\n",
    'shared/package.json': JSON.stringify({ name: '@org/shared' }),
    'shared/src/avatar.ts': 'export interface UserAvatar {\n}\n',
    'backend/src/x.ts': ''
  });
  assert.deepEqual(await detectCrossRepoLinks(root), [
    { from: { repo: 'frontend', path: 'src/profile.tsx' }, to: { repo: 'shared', path: 'src/avatar.ts' } }
  ]);
  const single = await mkdtemp(join(tmpdir(), 'tokio-links-'));
  assert.deepEqual(await detectCrossRepoLinks(single), []);
});

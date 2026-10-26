import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleWebviewRequest } from './messages';
import { createRepoCatalogService, readRepoActivity, type RepoPrompts } from './repos';

const clipboard = { writeText: async (): Promise<void> => {} };

/** A workspace folder `frontend` with sibling folders, as the panel sees it. */
async function createWorkspace(catalog?: object): Promise<{ root: string; parent: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'tokio-ui-repos-'));
  const root = join(parent, 'frontend');
  for (const name of ['frontend', 'backend', 'shared']) {
    await mkdir(join(parent, name));
  }
  if (catalog) {
    await writeFile(join(root, 'tokio.repos.json'), JSON.stringify(catalog), 'utf8');
  }
  return { root, parent };
}

function prompts(root: string, overrides: Partial<RepoPrompts> = {}): RepoPrompts {
  return {
    root: () => root,
    pickFolder: async () => undefined,
    confirm: async () => true,
    ...overrides
  };
}

async function send(service: ReturnType<typeof createRepoCatalogService>, request: Record<string, unknown>) {
  const response = await handleWebviewRequest({ type: 'repos', requestId: 7, ...request }, clipboard, undefined, undefined, service);
  assert.equal(response?.type, 'reposResult');
  return response as Extract<typeof response, { type: 'reposResult' }>;
}

const CATALOG = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: '.', dependsOn: ['backend'] },
    { name: 'backend', path: '../backend', purpose: 'REST API' }
  ]
};

test('list shows the root alone without a catalog, and each repository with its access when there is one', async () => {
  const plain = await createWorkspace();
  const empty = await send(createRepoCatalogService(prompts(plain.root)), { action: 'list' });
  assert.equal(empty.success, true);
  assert.equal(empty.view?.fromFile, false);
  assert.deepEqual(empty.view?.repos.map((repo) => [repo.name, repo.access]), [['frontend', 'write']]);

  const { root } = await createWorkspace(CATALOG);
  const listed = await send(createRepoCatalogService(prompts(root)), { action: 'list' });
  assert.deepEqual(listed.view?.repos.map((repo) => [repo.name, repo.access, repo.missing]), [
    ['frontend', 'write', false],
    ['backend', 'read', false]
  ]);
  assert.deepEqual(listed.view?.mergeOrder, ['backend', 'frontend']);
  assert.equal(listed.view?.repos[1].purpose, 'REST API');
});

test('activity keeps the latest call per repository: working, blocked, recent, or left out when old', async () => {
  const { root } = await createWorkspace(CATALOG);
  const now = new Date('2026-10-26T10:00:00.000Z');
  const at = (secondsAgo: number): string => new Date(now.getTime() - secondsAgo * 1000).toISOString();
  const line = (entry: object): string => JSON.stringify({ inputTokens: 0, outputTokens: 0, redactions: [], blocked: false, ...entry });
  await mkdir(join(root, '.tokio'));
  await writeFile(join(root, '.tokio', 'audit.log'), [
    line({ timestamp: at(600), tool: 'repo_map', files: ['a.ts'], repos: ['backend'] }),
    line({ timestamp: at(60), tool: 'repo_map', files: ['a.ts'], repos: ['backend'] }),
    '{"damaged',
    line({ timestamp: at(5), tool: 'read_symbol', files: ['b.php'], repos: ['backend'] }),
    // No repos field: files came from the default repository.
    line({ timestamp: at(40), tool: 'read_symbol', files: ['src/app.ts'] }),
    // No files and no repos, such as refine_task: no repository to light up.
    line({ timestamp: at(2), tool: 'refine_task', files: [] }),
    line({ timestamp: at(1), tool: 'Edit', files: ['x'], repos: ['unknown'], blocked: true })
  ].join('\n') + '\n', 'utf8');

  const activity = await readRepoActivity(root, now);
  assert.deepEqual(activity.map((entry) => [entry.repo, entry.state, entry.tool, entry.ageMs]).sort(), [
    ['backend', 'working', 'read_symbol', 5000],
    ['frontend', 'recent', 'read_symbol', 40000]
  ]);

  await writeFile(join(root, '.tokio', 'audit.log'), line({ timestamp: at(3), tool: 'Edit', files: ['x'], repos: ['backend'], blocked: true }) + '\n', 'utf8');
  assert.deepEqual((await readRepoActivity(root, now)).map((entry) => entry.state), ['blocked']);
});

test('activity merges the hook log with the audit log, newest call per repository first', async () => {
  const { root } = await createWorkspace(CATALOG);
  const now = new Date('2026-10-26T10:00:00.000Z');
  const at = (secondsAgo: number): string => new Date(now.getTime() - secondsAgo * 1000).toISOString();
  await mkdir(join(root, '.tokio'));
  await writeFile(join(root, '.tokio', 'audit.log'), JSON.stringify({
    timestamp: at(8), tool: 'repo_map', inputTokens: 0, outputTokens: 0, files: ['a.php'], redactions: [], blocked: false, repos: ['backend']
  }) + '\n', 'utf8');
  await writeFile(join(root, '.tokio', 'activity.log'), [
    JSON.stringify({ timestamp: at(3), tool: 'Edit', action: 'editing', repo: 'backend', file: 'Report.php' }),
    JSON.stringify({ timestamp: at(30), tool: 'Read', action: 'reading', repo: 'frontend', file: 'main.ts' }),
    JSON.stringify({ timestamp: at(1), tool: 'Read', action: 'unknown', repo: 'frontend' })
  ].join('\n') + '\n', 'utf8');

  const activity = await readRepoActivity(root, now);
  assert.deepEqual(activity.map((entry) => [entry.repo, entry.state, entry.action, entry.tool, entry.file]).sort(), [
    ['backend', 'working', 'editing', 'Edit', 'Report.php'],
    ['frontend', 'recent', 'reading', 'Read', 'main.ts']
  ]);
});

test('activity is empty without an audit log', async () => {
  const { root } = await createWorkspace(CATALOG);
  assert.deepEqual(await readRepoActivity(root), []);
});

test('grant, revoke, and clear change the write scope that the hook reads', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));

  const granted = await send(service, { action: 'grant', name: 'backend', hours: 2 });
  assert.equal(granted.message, 'backend accepts edits for 2 hours.');
  const backend = granted.view?.repos.find((repo) => repo.name === 'backend');
  assert.equal(backend?.access, 'granted');
  assert.ok(Date.parse(backend?.grantedUntil ?? '') > Date.now());
  assert.match(await readFile(join(root, '.tokio', 'scope.json'), 'utf8'), /"repo": "backend"/);

  const revoked = await send(service, { action: 'revoke', name: 'backend' });
  assert.equal(revoked.view?.repos[1].access, 'read');

  await send(service, { action: 'grant', name: 'backend' });
  const cleared = await send(service, { action: 'clearGrants' });
  assert.equal(cleared.message, 'Only the write target accepts edits.');
  assert.equal(cleared.view?.repos[1].access, 'read');
});

test('setDefault moves the write target in the catalog file and keeps paths as written', async () => {
  const { root } = await createWorkspace(CATALOG);
  const result = await send(createRepoCatalogService(prompts(root)), { action: 'setDefault', name: 'backend' });
  assert.equal(result.message, 'backend is now the write target.');
  assert.deepEqual(result.view?.repos.map((repo) => repo.access), ['read', 'write']);
  const saved = JSON.parse(await readFile(join(root, 'tokio.repos.json'), 'utf8'));
  assert.equal(saved.default, 'backend');
  assert.equal(saved.repos[1].path, '../backend');
});

test('add stores a picked sibling folder relative to the root, creating the catalog when needed', async () => {
  const { root, parent } = await createWorkspace();
  const service = createRepoCatalogService(prompts(root, { pickFolder: async () => join(parent, 'shared') }));
  const added = await send(service, { action: 'add' });
  assert.equal(added.message, 'Added shared.');
  const saved = JSON.parse(await readFile(join(root, 'tokio.repos.json'), 'utf8'));
  assert.deepEqual(saved, { default: 'frontend', repos: [{ name: 'frontend', path: '.' }, { name: 'shared', path: '../shared' }] });

  // The same folder name again gets a distinct repository name; the overlapping path is then refused.
  const again = await send(service, { action: 'add' });
  assert.equal(again.success, false);
  assert.match(again.message, /^Invalid tokio\.repos\.json: repositories shared and shared-2 overlap/);
  assert.equal(again.view?.repos.length, 2);

  const cancelled = await send(createRepoCatalogService(prompts(root)), { action: 'add' });
  assert.deepEqual([cancelled.success, cancelled.message], [false, 'No folder chosen.']);
});

test('remove asks first, drops dependsOn references, and refuses the write target', async () => {
  const { root } = await createWorkspace(CATALOG);
  const kept = await send(createRepoCatalogService(prompts(root, { confirm: async () => false })), { action: 'remove', name: 'backend' });
  assert.deepEqual([kept.success, kept.message], [false, 'Kept the repository.']);

  const service = createRepoCatalogService(prompts(root));
  const target = await send(service, { action: 'remove', name: 'frontend' });
  assert.equal(target.success, false);
  assert.equal(target.message, 'frontend is the write target. Make another repository the write target first.');

  const removed = await send(service, { action: 'remove', name: 'backend' });
  assert.equal(removed.message, 'Removed backend from the catalog.');
  const saved = JSON.parse(await readFile(join(root, 'tokio.repos.json'), 'utf8'));
  assert.deepEqual(saved.repos, [{ name: 'frontend', path: '.', dependsOn: [] }]);
});

test('an invalid catalog is reported and never overwritten', async () => {
  const { root } = await createWorkspace();
  await writeFile(join(root, 'tokio.repos.json'), '{ broken', 'utf8');
  const service = createRepoCatalogService(prompts(root));
  const listed = await send(service, { action: 'list' });
  assert.equal(listed.success, false);
  assert.match(listed.message, /^Invalid tokio\.repos\.json: not valid JSON/);
  assert.equal(listed.view, undefined);

  await send(service, { action: 'setDefault', name: 'backend' });
  assert.equal(await readFile(join(root, 'tokio.repos.json'), 'utf8'), '{ broken');
});

test('malformed repository requests are ignored, and a missing service is reported', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));
  for (const request of [
    { action: 'delete' },
    { action: 'grant' },
    { action: 'grant', name: 'backend', hours: 0 },
    { action: 'grant', name: 'backend', hours: 2.5 },
    { action: 'remove', name: 'x'.repeat(65) }
  ]) {
    assert.equal(await handleWebviewRequest({ type: 'repos', requestId: 1, ...request }, clipboard, undefined, undefined, service), undefined);
  }
  const unavailable = await handleWebviewRequest({ type: 'repos', requestId: 1, action: 'list' }, clipboard);
  assert.deepEqual(unavailable, { type: 'reposResult', requestId: 1, success: false, message: 'Repository settings are unavailable.' });
});

test('the root guard runs before every action', async () => {
  const service = createRepoCatalogService({
    root: () => {
      throw new Error('Trust this workspace before changing repository settings.');
    },
    pickFolder: async () => undefined,
    confirm: async () => true
  });
  const result = await send(service, { action: 'grant', name: 'backend' });
  assert.deepEqual([result.success, result.message], [false, 'Trust this workspace before changing repository settings.']);
});

test('graph returns declared links, detected pairs, and the saved layout', async () => {
  const { root, parent } = await createWorkspace({ ...CATALOG, links: [{ from: 'frontend:src/api.ts', to: 'backend:routes/api.php', kind: 'api' }] });
  await mkdir(join(parent, 'frontend', 'src'), { recursive: true });
  await writeFile(join(parent, 'frontend', 'src', 'profile.ts'), "import { User } from '@org/api';\n", 'utf8');
  await writeFile(join(parent, 'backend', 'package.json'), JSON.stringify({ name: '@org/api' }), 'utf8');
  await writeFile(join(parent, 'backend', 'user.ts'), 'export interface User {\n}\n', 'utf8');
  const service = createRepoCatalogService(prompts(root));

  await send(service, { action: 'saveLayout', positions: { frontend: { x: 10.4, y: -5 }, backend: { x: 99999, y: 20 }, ghost: { x: 1, y: 1 } } });
  const result = await send(service, { action: 'graph' });
  assert.equal(result.success, true);
  assert.deepEqual(result.graph?.links, [{ from: 'frontend:src/api.ts', to: 'backend:routes/api.php', kind: 'api' }]);
  assert.deepEqual(result.graph?.detected, [{ from: 'frontend:src/profile.ts', to: 'backend:user.ts' }]);
  // Rounded, kept on the board, and limited to catalog repositories.
  assert.deepEqual(result.graph?.layout, { frontend: { x: 10, y: 0 }, backend: { x: 20000, y: 20 } });
  assert.match(await readFile(join(root, '.tokio', 'layout.json'), 'utf8'), /"version": 1/);
});

test('dependency and link actions edit the catalog through the panel protocol', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));
  const removed = await send(service, { action: 'removeDependency', from: 'frontend', to: 'backend' });
  assert.equal(removed.message, 'frontend no longer depends on backend.');
  const cycle = await send(service, { action: 'addDependency', from: 'backend', to: 'frontend' });
  assert.equal(cycle.success, true);
  const loop = await send(service, { action: 'addDependency', from: 'frontend', to: 'backend' });
  assert.equal(loop.success, false);
  assert.match(loop.message, /cycle/);

  const linked = await send(service, { action: 'addLink', from: 'frontend:src/a.ts', to: 'backend:b.php', kind: 'event', note: 'avatar.saved' });
  assert.equal(linked.message, 'Linked frontend:src/a.ts to backend:b.php.');
  assert.deepEqual(linked.view?.links, [{ from: 'frontend:src/a.ts', to: 'backend:b.php', kind: 'event', note: 'avatar.saved' }]);
  const unlinked = await send(service, { action: 'removeLink', from: 'backend:b.php', to: 'frontend:src/a.ts' });
  assert.deepEqual(unlinked.view?.links, []);
});

test('pickFile returns a path relative to the repository and refuses one outside it', async () => {
  const { root, parent } = await createWorkspace(CATALOG);
  const inside = createRepoCatalogService(prompts(root, { pickFile: async (directory) => join(directory, 'routes', 'api.php') }));
  const picked = await send(inside, { action: 'pickFile', name: 'backend' });
  assert.deepEqual([picked.success, picked.value], [true, 'routes/api.php']);

  const outside = createRepoCatalogService(prompts(root, { pickFile: async () => join(parent, 'shared', 'x.ts') }));
  const refused = await send(outside, { action: 'pickFile', name: 'backend' });
  assert.deepEqual([refused.success, refused.message], [false, 'Pick a file inside backend.']);

  const cancelled = await send(createRepoCatalogService(prompts(root)), { action: 'pickFile', name: 'backend' });
  assert.deepEqual([cancelled.success, cancelled.message], [false, 'No file chosen.']);
});

test('map requests with bad pairs, kinds, notes, or layouts are ignored', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));
  for (const request of [
    { action: 'addDependency', from: 'frontend' },
    { action: 'addLink', from: 'frontend:a.ts', to: 'x'.repeat(601) },
    { action: 'addLink', from: 'frontend:a.ts', to: 'backend:b.php', kind: 'rpc' },
    { action: 'addLink', from: 'frontend:a.ts', to: 'backend:b.php', note: 'n'.repeat(201) },
    { action: 'saveLayout', positions: { frontend: { x: 'left', y: 0 } } },
    { action: 'saveLayout' },
    { action: 'pickFile' }
  ]) {
    assert.equal(await handleWebviewRequest({ type: 'repos', requestId: 1, ...request }, clipboard, undefined, undefined, service), undefined, JSON.stringify(request));
  }
});

test('openMap asks the host to open the repository map', async () => {
  const { root } = await createWorkspace(CATALOG);
  let opened = 0;
  const result = await send(createRepoCatalogService(prompts(root, { openMap: () => { opened += 1; } })), { action: 'openMap' });
  assert.equal(result.success, true);
  assert.equal(opened, 1);
});

test('connector settings save with the layout, keep through position-only saves, and fall back to defaults', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));
  const initial = await send(service, { action: 'graph' });
  assert.deepEqual(initial.graph?.settings, { shape: 'curved', styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' }, snap: false });

  const chosen = { shape: 'step', styles: { dependency: 'longdash', link: 'solid', detected: 'dashed' }, snap: true };
  await send(service, { action: 'saveLayout', positions: { frontend: { x: 1, y: 2 } }, settings: chosen });
  // A save that only moves nodes keeps the chosen settings.
  await send(service, { action: 'saveLayout', positions: { frontend: { x: 5, y: 6 } } });
  const reloaded = await send(service, { action: 'graph' });
  assert.deepEqual(reloaded.graph?.settings, chosen);
  assert.deepEqual(reloaded.graph?.layout, { frontend: { x: 5, y: 6 } });

  await writeFile(join(root, '.tokio', 'layout.json'), JSON.stringify({ positions: {}, settings: { shape: 'zigzag', styles: { link: 'wavy' } } }), 'utf8');
  const repaired = await send(service, { action: 'graph' });
  assert.deepEqual(repaired.graph?.settings, { shape: 'curved', styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' }, snap: false });
});

test('saveLayout with malformed connector settings is ignored', async () => {
  const { root } = await createWorkspace(CATALOG);
  const service = createRepoCatalogService(prompts(root));
  for (const settings of [
    { shape: 'zigzag', styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' }, snap: false },
    { shape: 'curved', styles: { dependency: 'wavy', link: 'dashed', detected: 'dotted' }, snap: false },
    { shape: 'curved', styles: { dependency: 'solid', link: 'dashed' }, snap: false },
    { shape: 'curved', styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' }, snap: 'yes' }
  ]) {
    const response = await handleWebviewRequest({ type: 'repos', requestId: 1, action: 'saveLayout', positions: {}, settings }, clipboard, undefined, undefined, service);
    assert.equal(response, undefined, JSON.stringify(settings));
  }
});

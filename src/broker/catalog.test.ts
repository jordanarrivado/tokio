import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CATALOG_FILE, CatalogError, dependencyOrder, formatCatalog, loadCatalog, parseCatalog } from './catalog';

const ROOT = resolve(tmpdir(), 'tokio-catalog-work', 'frontend');

const EXAMPLE = {
  default: 'frontend',
  repos: [
    { name: 'frontend', path: '.', purpose: 'React UI', dependsOn: ['shared', 'backend'] },
    { name: 'backend', path: '../backend', purpose: 'REST API', dependsOn: ['shared'] },
    { name: 'shared', path: '../shared', purpose: 'Shared types' }
  ]
};

function parse(value: unknown): ReturnType<typeof parseCatalog> {
  return parseCatalog(typeof value === 'string' ? value : JSON.stringify(value), ROOT);
}

function repos(...entries: object[]): { default: string; repos: object[] } {
  return { default: 'a', repos: entries };
}

test('parseCatalog resolves paths against the root, trims purpose, and counts a repeated dependency once', () => {
  const catalog = parse({
    default: 'frontend',
    repos: [
      { name: 'frontend', path: '.', purpose: '  React UI  ', dependsOn: ['shared', 'shared'], extra: true },
      { name: 'shared', path: '../shared' }
    ]
  });
  assert.equal(catalog.fromFile, true);
  assert.equal(catalog.defaultRepo, 'frontend');
  assert.deepEqual(catalog.repos, [
    { name: 'frontend', path: ROOT, purpose: 'React UI', dependsOn: ['shared'] },
    { name: 'shared', path: resolve(ROOT, '../shared'), dependsOn: [] }
  ]);
});

test('parseCatalog accepts an absolute drive path, which is not a URL', () => {
  const catalog = parse(repos({ name: 'a', path: 'C:/work/app' }));
  assert.equal(catalog.repos[0].path, resolve(ROOT, 'C:/work/app'));
});

test('dependencyOrder puts dependencies first and keeps catalog order on ties', () => {
  assert.deepEqual(dependencyOrder(parse(EXAMPLE).repos), ['shared', 'backend', 'frontend']);
  const independent = parse(repos({ name: 'a', path: 'a' }, { name: 'b', path: 'b' }, { name: 'c', path: 'c', dependsOn: ['b', 'a'] }));
  assert.deepEqual(dependencyOrder(independent.repos), ['a', 'b', 'c']);
});

test('parseCatalog names the first problem in an invalid catalog', () => {
  const cases: [unknown, string][] = [
    ['[]', 'expected an object with "default" and "repos".'],
    [{ default: 'a' }, '"repos" must be a non-empty array.'],
    [repos(), '"repos" must be a non-empty array.'],
    [{ default: 'a', repos: ['a'] }, 'repos[0] must be an object with "name" and "path".'],
    [repos({ name: 'bad name', path: '.' }), 'repos[0].name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.'],
    [repos({ name: '-a', path: '.' }), 'repos[0].name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.'],
    [repos({ name: 'a', path: 'a' }, { name: 'A', path: 'b' }), 'repository name "A" is used twice.'],
    [repos({ name: 'a' }), 'repos[0].path must be a non-empty string.'],
    [repos({ name: 'a', path: '  ' }), 'repos[0].path must be a non-empty string.'],
    [repos({ name: 'a', path: 'https://github.com/org/a' }), 'repos[0].path must be a local directory, not a URL.'],
    [repos({ name: 'a', path: '.', purpose: 3 }), 'repos[0].purpose must be a string.'],
    [repos({ name: 'a', path: '.', dependsOn: 'b' }), 'repos[0].dependsOn must be an array of repository names.'],
    [{ repos: [{ name: 'a', path: 'a' }, { name: 'b', path: 'b' }] }, '"default" must name a repository in "repos" (names: a, b).'],
    [{ default: 'c', repos: [{ name: 'a', path: 'a' }] }, '"default" must name a repository in "repos" (got "c"; names: a).'],
    [repos({ name: 'a', path: '.', dependsOn: ['a'] }), 'repos[0].dependsOn cannot name the repository itself.'],
    [repos({ name: 'a', path: '.', dependsOn: ['api'] }), 'repos[0].dependsOn names unknown repository "api".'],
    [repos({ name: 'a', path: 'a', dependsOn: ['b'] }, { name: 'b', path: 'b', dependsOn: ['a'] }), 'dependsOn has a cycle: a -> b -> a.'],
    [repos({ name: 'a', path: '.' }, { name: 'b', path: './packages/b' }), 'repositories a and b overlap (one path is inside the other).'],
    [repos({ name: 'a', path: 'x' }, { name: 'b', path: './x/' }), 'repositories a and b overlap (one path is inside the other).']
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parse(value), (error: unknown) => {
      assert.ok(error instanceof CatalogError);
      assert.equal(error.message, `Invalid ${CATALOG_FILE}: ${message}`);
      return true;
    });
  }
  assert.throws(() => parse('{ not json'), /^Error: Invalid tokio\.repos\.json: not valid JSON \(/);
});

test('parseCatalog allows sibling paths that only share a name prefix', () => {
  const catalog = parse(repos({ name: 'a', path: '../app' }, { name: 'b', path: '../app-admin' }));
  assert.equal(catalog.repos.length, 2);
});

test('formatCatalog aligns columns, marks missing paths, and ends with the merge order', () => {
  const catalog = parse(EXAMPLE);
  const posix = (path: string) => resolve(ROOT, path).replaceAll('\\', '/');
  const width = posix('.').length;
  assert.equal(formatCatalog(catalog, new Set(['backend'])), [
    'Repositories from tokio.repos.json. Write target: frontend; the others are read-only.',
    `frontend  write  ${posix('.').padEnd(width)}  React UI (depends on: shared, backend)`,
    `backend   read   ${posix('../backend').padEnd(width)}  REST API (depends on: shared)  [missing]`,
    `shared    read   ${posix('../shared').padEnd(width)}  Shared types`,
    'Merge order: shared, backend, frontend'
  ].join('\n'));
});

test('loadCatalog without a catalog file uses the root alone, named after its folder', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'tokio-catalog-')), 'My Repo');
  await mkdir(root);
  const catalog = await loadCatalog(root);
  assert.deepEqual(catalog, { defaultRepo: 'My-Repo', repos: [{ name: 'My-Repo', path: root, dependsOn: [] }], links: [], fromFile: false });
  assert.equal(formatCatalog(catalog, new Set()), [
    'No tokio.repos.json; the root is the only repository and the write target.',
    `My-Repo  write  ${root.replaceAll('\\', '/')}`
  ].join('\n'));
});

test('loadCatalog reads the catalog file from the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-catalog-'));
  await writeFile(join(root, CATALOG_FILE), JSON.stringify(repos({ name: 'a', path: '.' })), 'utf8');
  const catalog = await loadCatalog(root);
  assert.equal(catalog.fromFile, true);
  assert.deepEqual(catalog.repos, [{ name: 'a', path: root, dependsOn: [] }]);
});

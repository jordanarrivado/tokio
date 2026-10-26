import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTIVITY_FILE, detectActivity, recordToolActivity } from './activity';
import { AUDIT_DIRECTORY } from './audit';
import { loadCatalog } from './catalog';

/** A workspace `app` with a sibling `api`, both in the catalog. */
async function createWorkspace(): Promise<{ root: string; api: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'tokio-activity-'));
  const root = join(parent, 'app');
  const api = join(parent, 'api');
  await mkdir(root);
  await mkdir(api);
  await writeFile(join(root, 'tokio.repos.json'), JSON.stringify({
    default: 'app',
    repos: [{ name: 'app', path: '.', dependsOn: ['api'] }, { name: 'api', path: '../api' }]
  }), 'utf8');
  return { root, api };
}

test('file tools touch the repository holding their path, as reading or editing, with the file name only', async () => {
  const { root, api } = await createWorkspace();
  const catalog = await loadCatalog(root);
  assert.deepEqual(detectActivity(catalog, 'Edit', { file_path: join(api, 'app', 'Report.php') }, root), [
    { repo: 'api', action: 'editing', file: 'Report.php' }
  ]);
  assert.deepEqual(detectActivity(catalog, 'Read', { file_path: 'src/main.ts' }, root), [
    { repo: 'app', action: 'reading', file: 'main.ts' }
  ]);
  // A search folder names a repository but no file; no path means the cwd.
  assert.deepEqual(detectActivity(catalog, 'Grep', { pattern: 'x', path: api }, root), [{ repo: 'api', action: 'reading' }]);
  assert.deepEqual(detectActivity(catalog, 'Glob', { pattern: '**/*.ts' }, root), [{ repo: 'app', action: 'reading' }]);
  // Outside every repository: nothing to show.
  assert.deepEqual(detectActivity(catalog, 'Read', { file_path: join(tmpdir(), 'elsewhere.txt') }, root), []);
});

test('commands touch each repository whose folder they name, in either slash style and any case, or else the cwd', async () => {
  const { root, api } = await createWorkspace();
  const catalog = await loadCatalog(root);
  const windowsStyle = api.replaceAll('/', '\\').toUpperCase();
  assert.deepEqual(detectActivity(catalog, 'PowerShell', { command: `cd ${windowsStyle}; php -l app/X.php` }, root), [
    { repo: 'api', action: 'running' }
  ]);
  assert.deepEqual(detectActivity(catalog, 'Bash', { command: 'npm test' }, root), [{ repo: 'app', action: 'running' }]);
});

test('recording appends one line per repository and never throws', async () => {
  const { root, api } = await createWorkspace();
  const now = new Date('2026-10-26T10:00:00.000Z');
  await recordToolActivity(root, 'Edit', { file_path: join(api, 'X.php'), old_string: 'secret text', new_string: 'b' }, now);
  const text = await readFile(join(root, AUDIT_DIRECTORY, ACTIVITY_FILE), 'utf8');
  assert.deepEqual(text.trim().split('\n').map((line) => JSON.parse(line)), [
    { timestamp: now.toISOString(), tool: 'Edit', repo: 'api', action: 'editing', file: 'X.php' }
  ]);
  // Never the edit text.
  assert.equal(text.includes('secret text'), false);

  // No catalog to read: nothing recorded, no error.
  const bare = await mkdtemp(join(tmpdir(), 'tokio-activity-bare-'));
  await writeFile(join(bare, 'tokio.repos.json'), '{ not json', 'utf8');
  await recordToolActivity(bare, 'Read', { file_path: 'a.ts' });
});

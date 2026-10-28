import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAP_SESSION_FILE, loadArchitectureMap, readSessionAreas, recordSessionAreas } from './mapfile';

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tokio-mapfile-'));
}

test('loads .tokio/map.md, returns undefined without one, and rejects an explicit non-Markdown or secret path', async () => {
  const root = await scratch();
  assert.equal(await loadArchitectureMap(root), undefined);
  await mkdir(join(root, '.tokio'), { recursive: true });
  await writeFile(join(root, '.tokio', 'map.md'), '## Auth\n- login -> src/a.ts#login\n', 'utf8');
  await writeFile(join(root, 'notes.ts'), 'x', 'utf8');
  const map = await loadArchitectureMap(root);
  assert.equal(map?.path, '.tokio/map.md');
  assert.deepEqual(map?.areas.map((area) => area.name), ['Auth']);
  await assert.rejects(loadArchitectureMap(root, 'notes.ts'), /must be a Markdown file/);
  await assert.rejects(loadArchitectureMap(root, '.env'), /secret/);
});

test('records areas per session, keeps the newest five sessions, and survives a corrupt file', async () => {
  const root = await scratch();
  assert.deepEqual([...await readSessionAreas(root, 'a')], []);
  await recordSessionAreas(root, 'a', ['Auth']);
  await recordSessionAreas(root, 'a', ['Billing', 'Auth']);
  assert.deepEqual([...await readSessionAreas(root, 'a')], ['Auth', 'Billing']);
  assert.deepEqual([...await readSessionAreas(root, 'b')], []);

  for (const id of ['b', 'c', 'd', 'e', 'f']) {
    await recordSessionAreas(root, id, ['X']);
  }
  const saved = JSON.parse(await readFile(join(root, MAP_SESSION_FILE), 'utf8')) as { sessions: { id: string }[] };
  assert.deepEqual(saved.sessions.map((session) => session.id), ['f', 'e', 'd', 'c', 'b']);

  await writeFile(join(root, MAP_SESSION_FILE), 'not json', 'utf8');
  assert.deepEqual([...await readSessionAreas(root, 'f')], []);
});

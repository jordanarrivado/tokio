import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_FILE_BYTES, scanRepository } from './scan';

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-scan-'));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
  return root;
}

test('returns safe source files and skips secrets, dependencies, and oversized files', async () => {
  const root = await createRepo({
    'src/app.ts': 'export const app = 1;\n',
    '.env': 'API_KEY=abc\n',
    'config/credentials.json': '{}',
    'private/server.key': 'key',
    'node_modules/lib/index.ts': 'export const lib = 1;\n',
    'dist/app.js': 'x',
    'assets/logo.png': 'binary',
    'src/huge.ts': 'a'.repeat(MAX_FILE_BYTES + 1)
  });

  const result = await scanRepository(root);
  assert.deepEqual(result.files.map((file) => file.path), ['src/app.ts']);
  assert.equal(result.truncated, false);
});

test('stops with an AbortError once its signal is aborted', async () => {
  const root = await createRepo({ 'src/app.ts': 'export const app = 1;\n' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanRepository(root, controller.signal), { name: 'AbortError' });
});

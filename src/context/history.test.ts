import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { buildCoChangeLinks, parseCommitFiles, readCoChangeLinks } from './history';

const execFileAsync = promisify(execFile);

const scratchDirectories: string[] = [];
after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

test('parses commit records and their file lists', () => {
  const output = '\x1eaaa111\n\nsrc/a.ts\nsrc/b.ts\n\n\x1ebbb222\n\nsrc/c.ts\n';
  assert.deepEqual(parseCommitFiles(output), [['src/a.ts', 'src/b.ts'], ['src/c.ts']]);
  assert.deepEqual(parseCommitFiles(''), []);
});

test('links files that changed together at least twice, ignoring unknown files and bulk commits', () => {
  const bulk = Array.from({ length: 30 }, (_, index) => `generated/${index}.ts`);
  const known = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts', ...bulk]);
  const links = buildCoChangeLinks([
    ['src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/a.ts', 'deleted/old.ts'],
    ['src/a.ts', 'src/c.ts'],
    // Thirty-two known files in one commit is a bulk change, so it must not count as coupling.
    ['src/a.ts', 'src/c.ts', ...bulk]
  ], known);

  assert.deepEqual(links.get('src/a.ts'), ['src/b.ts']);
  assert.deepEqual(links.get('src/b.ts'), ['src/a.ts']);
  // a and c changed together once in a normal commit. The bulk commit must not add a second.
  assert.equal(links.get('src/c.ts'), undefined);
  assert.equal(links.get('generated/0.ts'), undefined);
});

test('reads co-change links from a real repository and skips the pair that never changed together', async () => {
  const root = await scratchDirectory('tokio-history-');
  await execFileAsync('git', ['-C', root, 'init', '-q']);
  const commit = async (message: string) => {
    await execFileAsync('git', [
      '-C', root, '-c', 'user.name=tokio-test', '-c', 'user.email=tokio-test@example.invalid',
      'commit', '-q', '-m', message
    ]);
  };

  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    await writeFile(join(root, name), `export const ${name.replace('.ts', '')} = 1;\n`, 'utf8');
  }
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await commit('initial');

  for (const round of [2, 3]) {
    await writeFile(join(root, 'a.ts'), `export const a = ${round};\n`, 'utf8');
    await writeFile(join(root, 'b.ts'), `export const b = ${round};\n`, 'utf8');
    await execFileAsync('git', ['-C', root, 'add', '.']);
    await commit(`change a and b ${round}`);
  }
  await writeFile(join(root, 'c.ts'), 'export const c = 9;\n', 'utf8');
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await commit('change c alone');

  const links = await readCoChangeLinks(root, new Set(['a.ts', 'b.ts', 'c.ts']));
  assert.deepEqual(links.get('a.ts'), ['b.ts']);
  assert.deepEqual(links.get('b.ts'), ['a.ts']);
  assert.equal(links.has('c.ts'), false);
});

test('returns no links outside a git repository instead of failing', async () => {
  const directory = await scratchDirectory('tokio-history-plain-');
  const links = await readCoChangeLinks(directory, new Set(['a.ts']));
  assert.equal(links.size, 0);
});

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { isSecretPath, SECRET_DENY_PATTERNS } from '../context/discovery';
import { AGENTS_BEGIN, AGENTS_END, initProject, toPosixPath, type InitResult } from './init';

const CLI = join(__dirname, 'cli.js');

const scratchDirectories: string[] = [];
after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tokio-init-'));
  scratchDirectories.push(directory);
  return directory;
}

/** A CLI path that exists only in the fixture, so the tests never depend on where the repo is checked out. */
function fakeCli(root: string): string {
  return join(root, 'tokio', 'out', 'broker', 'cli.js');
}

function statusOf(results: InitResult[], path: string): string {
  return results.find((result) => result.path === path)?.status ?? 'missing';
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
}

test('creates the Claude Code and Codex configs and the guidance block in an empty project', async () => {
  const root = await scratchDirectory();
  const cli = toPosixPath(resolve(fakeCli(root)));
  const results = await initProject({ root, cliPath: fakeCli(root) });

  assert.equal(statusOf(results, '.mcp.json'), 'created');
  assert.equal(statusOf(results, '.claude/settings.json'), 'created');
  assert.equal(statusOf(results, '.codex/config.toml'), 'created');
  assert.equal(statusOf(results, 'AGENTS.md'), 'created');

  const mcp = await readJson(join(root, '.mcp.json'));
  assert.deepEqual(mcp.mcpServers.tokio, { command: 'node', args: [cli, 'mcp', '--root', toPosixPath(resolve(root))] });

  const settings = await readJson(join(root, '.claude', 'settings.json'));
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Read|Edit|Write|MultiEdit|Grep|Glob|Bash');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `node ${cli} hook`);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `node ${cli} prompt-hook`);
  assert.ok(settings.permissions.deny.includes('Read(.env)'));
  assert.ok(settings.permissions.deny.includes('Read(secrets/**)'));

  const codex = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(codex, /\[mcp_servers\.tokio\]\ncommand = "node"\nargs = \["[^"]+", "mcp", "--root", "[^"]+"\]\ncwd = "[^"]+"/);
  assert.ok(codex.includes(`"${cli}"`));

  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(AGENTS_BEGIN));
  assert.ok(agents.includes(AGENTS_END));
  assert.ok(agents.includes('`refine_task`'));
});

test('keeps the user\'s own deny rules and adds only the missing secret rules', async () => {
  const root = await scratchDirectory();
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Read(./.env)', 'Bash(rm -rf *)'] }
  }), 'utf8');

  await initProject({ root, cliPath: fakeCli(root) });
  const deny: string[] = (await readJson(join(root, '.claude', 'settings.json'))).permissions.deny;
  assert.equal(deny[0], 'Read(./.env)');
  assert.equal(deny[1], 'Bash(rm -rf *)');
  // The user's rule for .env is different text from the generated one, so the generated rule is added too.
  assert.ok(deny.includes('Read(.env)'));
  assert.equal(deny.filter((rule) => rule === 'Read(.env)').length, 1);
});

test('secret deny patterns cover what the hook treats as secret, without blocking look-alike names', () => {
  for (const path of ['.env', 'config/.env.production', '.npmrc', 'app/credentials.json', 'secrets/prod.yaml', 'keys/server.pem', 'config/secret.yaml']) {
    assert.equal(isSecretPath(path), true, path);
  }
  for (const path of ['src/secretary.ts', 'src/envelope.ts', 'src/credits.ts']) {
    assert.equal(isSecretPath(path), false, path);
  }
  // A bare prefix wildcard such as `secret*` would also block look-alike names, so none may appear.
  assert.equal(SECRET_DENY_PATTERNS.some((pattern) => /^(secret|credential|\.env)\*/.test(pattern)), false);
});

test('a second run changes nothing', async () => {
  const root = await scratchDirectory();
  await initProject({ root, cliPath: fakeCli(root) });
  const before = await Promise.all(['.mcp.json', '.claude/settings.json', '.codex/config.toml', 'AGENTS.md']
    .map((path) => readFile(join(root, path), 'utf8')));

  const results = await initProject({ root, cliPath: fakeCli(root) });
  assert.ok(results.every((result) => result.status === 'unchanged'), JSON.stringify(results));

  const after = await Promise.all(['.mcp.json', '.claude/settings.json', '.codex/config.toml', 'AGENTS.md']
    .map((path) => readFile(join(root, path), 'utf8')));
  assert.deepEqual(after, before);
});

test('keeps existing servers, hooks, settings, tables, and guidance it does not own', async () => {
  const root = await scratchDirectory();
  await mkdir(join(root, '.claude'), { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }), 'utf8');
  await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-tool.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node notify.js' }] }]
    }
  }), 'utf8');
  await writeFile(join(root, '.codex', 'config.toml'), 'model = "gpt-5"\n\n[profile.fast]\nmodel = "small"\n', 'utf8');
  await writeFile(join(root, 'AGENTS.md'), '# Team notes\n\nUse pnpm.\n', 'utf8');

  const results = await initProject({ root, cliPath: fakeCli(root) });
  assert.equal(statusOf(results, '.mcp.json'), 'updated');
  assert.equal(statusOf(results, '.claude/settings.json'), 'updated');
  assert.equal(statusOf(results, '.codex/config.toml'), 'updated');
  assert.equal(statusOf(results, 'AGENTS.md'), 'updated');

  const mcp = await readJson(join(root, '.mcp.json'));
  assert.deepEqual(mcp.mcpServers.docs, { command: 'docs-server' });
  assert.ok(mcp.mcpServers.tokio);

  const settings = await readJson(join(root, '.claude', 'settings.json'));
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
  assert.ok(settings.permissions.deny.includes('Read(.env)'));
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node other-tool.js');
  assert.ok(settings.hooks.Stop);
  assert.ok(settings.hooks.UserPromptSubmit);

  const codex = await readFile(join(root, '.codex', 'config.toml'), 'utf8');
  assert.ok(codex.includes('[profile.fast]\nmodel = "small"'));
  assert.ok(codex.startsWith('model = "gpt-5"'));

  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Team notes\n\nUse pnpm.'));
  assert.ok(agents.includes(AGENTS_BEGIN));
});

test('reports differing tokio entries as conflicts and replaces them only with force', async () => {
  const root = await scratchDirectory();
  const cli = toPosixPath(resolve(fakeCli(root)));
  await mkdir(join(root, '.claude'), { recursive: true });
  await mkdir(join(root, '.codex'), { recursive: true });
  const staleCli = 'D:/old-checkout/out/broker/cli.js';
  await writeFile(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: { tokio: { command: 'node', args: [staleCli, 'mcp', '--root', 'D:/old-checkout'] } }
  }), 'utf8');
  await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${staleCli} hook` }] }] }
  }), 'utf8');
  await writeFile(join(root, '.codex', 'config.toml'), `[mcp_servers.tokio]\ncommand = "node"\nargs = ["${staleCli}", "mcp"]\n`, 'utf8');

  const kept = await initProject({ root, cliPath: fakeCli(root) });
  assert.equal(statusOf(kept, '.mcp.json'), 'conflict');
  assert.equal(statusOf(kept, '.claude/settings.json'), 'conflict');
  assert.equal(statusOf(kept, '.codex/config.toml'), 'conflict');
  assert.equal((await readJson(join(root, '.mcp.json'))).mcpServers.tokio.args[0], staleCli);
  // The new UserPromptSubmit hook is still added even though the PreToolUse hook conflicts.
  assert.ok((await readJson(join(root, '.claude', 'settings.json'))).hooks.UserPromptSubmit);

  const forced = await initProject({ root, cliPath: fakeCli(root), force: true });
  assert.equal(statusOf(forced, '.mcp.json'), 'updated');
  assert.equal((await readJson(join(root, '.mcp.json'))).mcpServers.tokio.args[0], cli);
  assert.equal((await readJson(join(root, '.claude', 'settings.json'))).hooks.PreToolUse[0].hooks[0].command, `node ${cli} hook`);
  assert.ok((await readFile(join(root, '.codex', 'config.toml'), 'utf8')).includes(`"${cli}"`));
});

test('leaves invalid JSON untouched and still configures the other files', async () => {
  const root = await scratchDirectory();
  await writeFile(join(root, '.mcp.json'), '{ this is not json', 'utf8');
  const results = await initProject({ root, cliPath: fakeCli(root) });

  assert.equal(statusOf(results, '.mcp.json'), 'error');
  assert.equal(await readFile(join(root, '.mcp.json'), 'utf8'), '{ this is not json');
  assert.equal(statusOf(results, '.codex/config.toml'), 'created');
});

test('does not duplicate hand-written Tokio guidance that has no markers', async () => {
  const root = await scratchDirectory();
  const handWritten = '# Tokio tools\n\n1. Call `refine_task` first.\n2. Then call `repo_map`.\n';
  await writeFile(join(root, 'AGENTS.md'), handWritten, 'utf8');

  const results = await initProject({ root, cliPath: fakeCli(root) });
  assert.equal(statusOf(results, 'AGENTS.md'), 'unchanged');
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), handWritten);
});

test('dry run reports what would change and writes nothing', async () => {
  const root = await scratchDirectory();
  const results = await initProject({ root, cliPath: fakeCli(root), dryRun: true });

  assert.equal(statusOf(results, '.mcp.json'), 'created');
  assert.equal(existsSync(join(root, '.mcp.json')), false);
  assert.equal(existsSync(join(root, '.claude')), false);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);
});

test('CLI init prints one line per file and exits 0 when nothing conflicts', async () => {
  const root = await scratchDirectory();
  const result = spawnSync(process.execPath, [CLI, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /created\s+\.mcp\.json/);
  assert.match(result.stdout, /created\s+AGENTS\.md/);

  const rerun = spawnSync(process.execPath, [CLI, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(rerun.status, 0);
  assert.match(rerun.stdout, /unchanged\s+\.mcp\.json/);
});

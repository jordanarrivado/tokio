import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadCatalog } from './catalog';
import {
  evaluateMessaging,
  ownRepo,
  parseRepoAddress,
  readConnections,
  repoForSession,
  resolveRepoName,
  routeAddressedPrompt,
  setConnection
} from './messaging';

const CLI = join(__dirname, 'cli.js');

/** tokio is the root; api is a sibling folder with its own catalog that names tokio back. */
async function createWorkspace(): Promise<{ root: string; api: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'tokio-messaging-'));
  const root = join(parent, 'tokio');
  const api = join(parent, 'hierpayroll-v3-api');
  await mkdir(root, { recursive: true });
  await mkdir(api, { recursive: true });
  await writeFile(join(root, 'tokio.repos.json'), JSON.stringify({
    default: 'tokio',
    repos: [{ name: 'tokio', path: '.' }, { name: 'hierpayroll-v3-api', path: '../hierpayroll-v3-api' }]
  }), 'utf8');
  await writeFile(join(api, 'tokio.repos.json'), JSON.stringify({
    default: 'hierpayroll-v3-api',
    repos: [{ name: 'hierpayroll-v3-api', path: '.' }, { name: 'tokio', path: '../tokio' }]
  }), 'utf8');
  return { root, api };
}

const send = (to: string): Record<string, unknown> => ({ to, message: 'hi' });

test('a switch is off until the user turns it on, and is written to both repositories', async () => {
  const { root, api } = await createWorkspace();
  assert.deepEqual(await readConnections(root), []);
  await setConnection(root, 'hierpayroll-v3-api', true);
  assert.deepEqual(await readConnections(root), ['hierpayroll-v3-api']);
  assert.deepEqual(await readConnections(api), ['tokio']);
  assert.equal(await readFile(join(api, '.tokio', '.gitignore'), 'utf8'), 'messaging.json\n');
  await setConnection(root, 'hierpayroll-v3-api', false);
  assert.deepEqual(await readConnections(root), []);
  assert.deepEqual(await readConnections(api), []);
  await setConnection(root, 'hierpayroll-v3-api', true);
  assert.equal(await readFile(join(api, '.tokio', '.gitignore'), 'utf8'), 'messaging.json\n');
});

test('ownRepo is the repository at the root, even when the catalog default is another one', async () => {
  const { api } = await createWorkspace();
  const catalog = await loadCatalog(api);
  assert.equal(ownRepo({ ...catalog, defaultRepo: 'tokio' }, api).name, 'hierpayroll-v3-api');
  assert.equal(ownRepo(catalog, join(api, '..')).name, 'hierpayroll-v3-api');
});

test('setConnection rejects this repository and unknown names', async () => {
  const { root } = await createWorkspace();
  await assert.rejects(setConnection(root, 'tokio', true), /is this repository/);
  await assert.rejects(setConnection(root, 'nope', true), /Unknown repository "nope"/);
});

test('repoForSession maps session names with a suffix or ref, and leaves addresses and teammates alone', async () => {
  const { root } = await createWorkspace();
  const catalog = await loadCatalog(root);
  assert.equal(repoForSession(catalog, 'hierpayroll-v3-api-b7')?.name, 'hierpayroll-v3-api');
  assert.equal(repoForSession(catalog, 'hierpayroll-v3-api-c6 [d4fd22]')?.name, 'hierpayroll-v3-api');
  assert.equal(repoForSession(catalog, 'tokio-6c')?.name, 'tokio');
  assert.equal(repoForSession(catalog, 'uds:\\\\.\\pipe\\LOCAL\\cc-msg-05828a23'), undefined);
  assert.equal(repoForSession(catalog, 'researcher'), undefined);
  assert.equal(repoForSession(catalog, 'main'), undefined);
});

test('SendMessage to a session whose repository is switched off is blocked on both sides', async () => {
  const { root, api } = await createWorkspace();
  const out = await evaluateMessaging('SendMessage', send('hierpayroll-v3-api-b7'), root);
  assert.equal(out?.blocked, true);
  assert.match(out?.reason ?? '', /messaging with hierpayroll-v3-api is off/);
  assert.equal((await evaluateMessaging('SendMessage', send('tokio-6c'), api))?.blocked, true);

  await setConnection(root, 'hierpayroll-v3-api', true);
  assert.equal(await evaluateMessaging('SendMessage', send('hierpayroll-v3-api-b7'), root), undefined);
  assert.equal(await evaluateMessaging('SendMessage', send('tokio-6c'), api), undefined);
});

test('SendMessage to teammates and reply addresses is not switched', async () => {
  const { root } = await createWorkspace();
  assert.equal(await evaluateMessaging('SendMessage', send('researcher'), root), undefined);
  assert.equal(await evaluateMessaging('SendMessage', send('uds:\\\\.\\pipe\\LOCAL\\cc-msg-1'), root), undefined);
});

test('agents cannot flip the switch by editing the file or naming it in a command', async () => {
  const { root } = await createWorkspace();
  const edit = await evaluateMessaging('Write', { file_path: join(root, '.tokio', 'messaging.json'), content: '{}' }, root);
  assert.equal(edit?.blocked, true);
  assert.match(edit?.reason ?? '', /only the user can switch messaging/);
  const bash = await evaluateMessaging('Bash', { command: 'echo {} > .tokio/messaging.json' }, root);
  assert.equal(bash?.blocked, true);
  assert.equal(await evaluateMessaging('Bash', { command: 'git status' }, root), undefined);
});

test('the hook CLI exits 2 for a switched-off SendMessage and 0 once it is on', async () => {
  const { root } = await createWorkspace();
  const run = () => spawnSync(process.execPath, [CLI, 'hook'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: send('hierpayroll-v3-api-b7'), cwd: root }),
    encoding: 'utf8'
  });
  const blocked = run();
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Tokio blocked SendMessage: messaging with hierpayroll-v3-api is off/);
  await setConnection(root, 'hierpayroll-v3-api', true);
  assert.equal(run().status, 0);
});

test('parseRepoAddress reads ~name: and leaves other prompts alone', () => {
  assert.deepEqual(parseRepoAddress('~API:  why in API repo needed to setup this'), { name: 'API', question: 'why in API repo needed to setup this' });
  assert.deepEqual(parseRepoAddress('  ~ web : two\nlines '), { name: 'web', question: 'two\nlines' });
  assert.deepEqual(parseRepoAddress('~api:'), { name: 'api', question: '' });
  assert.equal(parseRepoAddress('~/.bashrc: fix the path'), undefined);
  assert.equal(parseRepoAddress('ask ~api: later in the prompt'), undefined);
  assert.equal(parseRepoAddress('fix the api'), undefined);
});

test('resolveRepoName matches a whole name, a folder name, or one name part, ignoring case', () => {
  const repo = (name: string, path = '/w/' + name): { name: string; path: string; dependsOn: string[] } => ({ name, path, dependsOn: [] });
  const catalog = {
    defaultRepo: 'tokio',
    repos: [repo('tokio'), repo('hierpayroll-v3-api'), repo('hierpayroll-v3-web'), repo('Hier-Run', '/w/runner')],
    links: []
  } as unknown as Parameters<typeof resolveRepoName>[0];
  const names = (name: string): string[] => resolveRepoName(catalog, name).map((found) => found.name);
  assert.deepEqual(names('API'), ['hierpayroll-v3-api']);
  assert.deepEqual(names('hierpayroll-v3-web'), ['hierpayroll-v3-web']);
  assert.deepEqual(names('runner'), ['Hier-Run']);
  assert.deepEqual(names('run'), ['Hier-Run']);
  assert.deepEqual(names('hierpayroll'), ['hierpayroll-v3-api', 'hierpayroll-v3-web']);
  assert.deepEqual(names('ap'), []);
});

test('routeAddressedPrompt relays only to a resolved repository that messaging is on for', async () => {
  const { root } = await createWorkspace();
  const catalog = await loadCatalog(root);
  const route = (prompt: string, connections: string[] = ['hierpayroll-v3-api']) =>
    routeAddressedPrompt(catalog, root, parseRepoAddress(prompt)!, connections);

  const relayed = route('~API: why is this needed?');
  assert.equal(relayed.repo, 'hierpayroll-v3-api');
  assert.match(relayed.text, /ListAgents/);
  assert.match(relayed.text, /SendMessage/);
  assert.match(relayed.text, /<question>\nwhy is this needed\?\n<\/question>/);

  for (const [prompt, connections, pattern] of [
    ['~api: why?', [], /messaging with hierpayroll-v3-api is off/],
    ['~nope: why?', undefined, /no repository in tokio\.repos\.json is called that/],
    ['~tokio: why?', undefined, /names this repository/],
    ['~api:', undefined, /has no question/]
  ] as const) {
    const refused = route(prompt, connections as string[] | undefined);
    assert.equal(refused.repo, undefined, prompt);
    assert.match(refused.text, pattern, prompt);
  }
});

test('the prompt hook gives an addressed prompt relay instructions instead of a repository map', async () => {
  const { root } = await createWorkspace();
  await setConnection(root, 'hierpayroll-v3-api', true);
  const run = (prompt: string) => spawnSync(process.execPath, [CLI, 'prompt-hook'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: root }),
    encoding: 'utf8'
  });
  const relayed = run('~api: why is this setup needed?');
  assert.equal(relayed.status, 0);
  assert.match(relayed.stdout, /addressed this question to the agent session of hierpayroll-v3-api/);
  const audit = await readFile(join(root, '.tokio', 'audit.log'), 'utf8');
  assert.match(audit, /"tool":"prompt-route"/);
  assert.doesNotMatch(audit, /setup needed/);
});

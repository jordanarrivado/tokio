import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateToolUse } from './hook';
import { AUDIT_DIRECTORY, AUDIT_FILE } from './audit';

const CLI = join(__dirname, 'cli.js');

function event(toolName: string, toolInput: Record<string, unknown>, cwd?: string): string {
  return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, cwd });
}

test('blocks secret file fields and Bash commands, allows normal files', () => {
  assert.equal(evaluateToolUse(event('Read', { file_path: '.env' })).blocked, true);
  assert.equal(evaluateToolUse(event('Edit', { file_path: 'config/credentials.json' })).blocked, true);
  assert.equal(evaluateToolUse(event('Grep', { path: 'secrets/prod.yaml' })).blocked, true);
  assert.equal(evaluateToolUse(event('Bash', { command: 'cat .env' })).blocked, true);

  const allowed = evaluateToolUse(event('Read', { file_path: 'src/app.ts' }));
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.tool, 'Read');
});

test('allows bare search words in Bash but still blocks secret files named in a command', () => {
  assert.equal(evaluateToolUse(event('Bash', { command: 'grep -rn "secret" src' })).blocked, false);
  assert.equal(evaluateToolUse(event('Bash', { command: 'echo credentials are managed elsewhere' })).blocked, false);

  assert.equal(evaluateToolUse(event('Bash', { command: 'cat config/secrets.yaml' })).blocked, true);
  assert.equal(evaluateToolUse(event('Bash', { command: 'cat .env | head' })).blocked, true);
  assert.equal(evaluateToolUse(event('Bash', { command: 'type credentials.json' })).blocked, true);
});

test('accepts event JSON prefixed with a byte-order mark', () => {
  const verdict = evaluateToolUse(`﻿${event('Read', { file_path: '.env' })}`);
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason ?? '', /secret file/);
});

test('blocks unparseable input rather than failing open', () => {
  const verdict = evaluateToolUse('not json');
  assert.equal(verdict.blocked, true);
  assert.match(verdict.reason ?? '', /could not read the hook input/);
});

test('CLI exits 2 with a reason for blocked events and writes an audit entry without contents', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tokio-hook-'));
  const blocked = spawnSync(process.execPath, [CLI, 'hook'], {
    input: event('Read', { file_path: '.env' }, cwd),
    encoding: 'utf8'
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Tokio blocked Read: file_path names a secret file/);

  const allowed = spawnSync(process.execPath, [CLI, 'hook'], {
    input: event('Read', { file_path: 'src/app.ts' }, cwd),
    encoding: 'utf8'
  });
  assert.equal(allowed.status, 0);

  const log = await readFile(join(cwd, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8');
  const entries = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].blocked, true);
  assert.deepEqual(entries[0].files, ['.env']);
});

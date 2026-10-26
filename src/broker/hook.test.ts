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

test('blocks broad reads through Bash that could reach secret files without naming them', () => {
  const blockedCommands = [
    'grep -rn "password" src',
    'grep -R token .',
    'grep --recursive key .',
    'grep -d recurse token src',
    'find . -name "*.env" -exec cat {} \\;',
    'find . -name "*.yaml" | xargs cat',
    'git status && grep -ri secret .'
  ];
  for (const command of blockedCommands) {
    const verdict = evaluateToolUse(event('Bash', { command }));
    assert.equal(verdict.blocked, true, command);
    assert.match(verdict.reason ?? '', /Name the files explicitly/, command);
  }

  const allowedCommands = [
    'grep -n token src/app.ts',
    'grep recurse src/app.ts',
    'find . -name "*.ts" -print',
    'ls -la src',
    'npm test'
  ];
  for (const command of allowedCommands) {
    assert.equal(evaluateToolUse(event('Bash', { command })).blocked, false, command);
  }
});

test('broad-read check sees through newlines, &, subshells, wrappers, bash -c, rg, and git grep', () => {
  const blockedCommands = [
    'cd src\ngrep -r token .',
    'git status & grep -r x .',
    'time grep -r foo .',
    'sudo grep -r foo .',
    'env LANG=C grep -r foo .',
    '(grep -r foo .)',
    'bash -c "grep -r x ."',
    "sh -c 'cd src && grep -rn x .'",
    'rg password',
    'rg -n token src',
    'git grep token',
    'git grep -n token -- src',
    'git -C src grep token',
    'git --no-pager -c color.ui=never grep token',
    'echo \\"; grep -r x .',
    "echo \"a \\\" b\"; grep -r x .",
    '$(grep -r x .)'
  ];
  for (const command of blockedCommands) {
    assert.equal(evaluateToolUse(event('Bash', { command })).blocked, true, command);
  }
});

test('broad-read check respects quoting, pattern arguments, and heredoc bodies', () => {
  const allowedCommands = [
    'git commit -m "docs; grep -r is blocked"',
    'grep -n -e -Error src/x.ts',
    'grep -eRecursive src/x.ts',
    'grep -n -- -r src/x.ts',
    "cat > notes.md <<'EOF'\nUse names; grep -r is blocked.\nEOF",
    'rg -n token src/app.ts',
    'git grep -n token -- src/app.ts README.md'
  ];
  for (const command of allowedCommands) {
    assert.equal(evaluateToolUse(event('Bash', { command })).blocked, false, command);
  }
});

test('PowerShell: blocks recursive or wildcard reads that can reach secret files', () => {
  const blockedCommands = [
    'Get-ChildItem -Recurse | Select-String token',
    'gci -r -File | Get-Content',
    'Get-ChildItem -Rec -Filter *.yaml | ForEach-Object { Get-Content $_ }',
    'Get-Content (Get-ChildItem -Recurse -File)',
    'Select-String -Path * -Pattern token',
    'sls token *.json',
    'Get-Content -Path:.env',
    'pwsh -Command "Get-ChildItem -Recurse | Select-String x"',
    'powershell -EncodedCommand ZwBjAGkAIAAtAHIAIAB8ACAAZwBjAA==',
    'echo `"; Get-ChildItem -Recurse | Get-Content'
  ];
  for (const command of blockedCommands) {
    assert.equal(evaluateToolUse(event('PowerShell', { command })).blocked, true, command);
  }
});

test('PowerShell: allows named files, safe wildcards, listings, and quoted text', () => {
  const allowedCommands = [
    'Get-Content src\\app.ts',
    'Select-String -Path src\\*.ts -Pattern token',
    'Select-String -Pattern "a.*b" -Path src\\x.ts',
    'Get-ChildItem -Recurse src',
    'Get-ChildItem -Recurse -Filter *.ts | ForEach-Object { Get-Content $_ }',
    'git status; npm test',
    "Write-Output 'Get-ChildItem -Recurse | Get-Content'"
  ];
  for (const command of allowedCommands) {
    assert.equal(evaluateToolUse(event('PowerShell', { command })).blocked, false, command);
  }
});

test('does not treat regex alternation or bare words as secret paths', () => {
  const command = 'grep -n "function secretDenyRules\\|export const SECRET" src/broker/init.ts';
  assert.equal(evaluateToolUse(event('Bash', { command })).blocked, false);
});

test('blocks a secret directory written with a trailing backslash, but not regex alternation', () => {
  for (const command of ['copy secrets\\ C:\\tmp\\out', 'Get-ChildItem secrets\\ | Get-Content', 'type secrets\\']) {
    assert.equal(evaluateToolUse(event('Bash', { command })).blocked, true, command);
  }
  for (const command of ['grep -n "secret\\|token" src/app.ts', 'grep -n "a\\(secrets\\)" src/app.ts']) {
    assert.equal(evaluateToolUse(event('Bash', { command })).blocked, false, command);
  }
});

test('allows bare search words in Bash but still blocks secret files named in a command', () => {
  assert.equal(evaluateToolUse(event('Bash', { command: 'grep -n "secret" src/app.ts' })).blocked, false);
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

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RepoFile } from '../context/repomap';
import { estimateTokens } from '../core/tokens';
import { AUDIT_DIRECTORY, AUDIT_FILE } from './audit';
import {
  decidePromptContext,
  parsePromptHookEvent,
  PROMPT_HOOK_BUDGET_TOKENS
} from './prompt-hook';

const CLI = join(__dirname, 'cli.js');

const scratchDirectories: string[] = [];
after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  scratchDirectories.push(directory);
  return directory;
}

const FILES: RepoFile[] = [
  {
    path: 'src/billing/invoice.ts',
    content: "import { round } from '../util';\n\nexport function createInvoice(customer: string) {\n  return { customer };\n}\n"
  },
  { path: 'src/util.ts', content: 'export function round(value: number) {\n  return Math.round(value);\n}\n' },
  {
    // Plain constants are left out of the map, so the credential sits in a function signature instead.
    path: 'src/billing/config.ts',
    content: "export function loadBillingConfig(options = { apiKey: 'pk_live_1234567890abcdef' }) {\n  return options;\n}\n"
  }
];

test('skips prompts too short to describe a task, and slash commands', () => {
  const short = decidePromptContext('fix invoice', FILES);
  assert.equal(short.inject, false);
  assert.match(short.reason ?? '', /too short/);

  const command = decidePromptContext('/review the billing module before release', FILES);
  assert.equal(command.inject, false);
  assert.match(command.reason ?? '', /slash command/);
});

test('skips prompts that match no repository files', () => {
  const decision = decidePromptContext('Write a poem about the ocean and autumn leaves', FILES);
  assert.equal(decision.inject, false);
  assert.match(decision.reason ?? '', /no repository files match/);
});

test('injects a repository map for a prompt that matches repository files', () => {
  const decision = decidePromptContext('Fix the invoice total rounding in the billing module', FILES);
  assert.equal(decision.inject, true);
  if (!decision.inject) {
    return;
  }
  assert.match(decision.text, /^Repository map:/);
  assert.match(decision.text, /createInvoice/);
  assert.ok(decision.files.includes('src/billing/invoice.ts'));
  assert.equal(decision.tokens, estimateTokens(decision.text));
});

test('redacts credential-shaped values from signatures before injecting them', () => {
  const decision = decidePromptContext('Update the billing config loader for the new key', FILES);
  assert.equal(decision.inject, true);
  if (!decision.inject) {
    return;
  }
  assert.equal(decision.text.includes('pk_live_1234567890abcdef'), false);
  assert.match(decision.text, /REDACTED:assignment/);
  assert.deepEqual(decision.redactions, ['assignment']);
});

test('keeps the injected map within the token budget on a large repository', () => {
  const files: RepoFile[] = [
    { path: 'src/registry.ts', content: 'export function loadRegistry() {}\n' },
    ...Array.from({ length: 200 }, (_, index) => ({
      path: `src/module${index}.ts`,
      content: Array.from({ length: 30 }, (__, line) => `export function fn${index}_${line}() {}`).join('\n')
    }))
  ];
  const decision = decidePromptContext('Update the registry loader to handle retries', files);
  assert.equal(decision.inject, true);
  if (!decision.inject) {
    return;
  }
  assert.ok(estimateTokens(decision.text) <= PROMPT_HOOK_BUDGET_TOKENS + 50);
  assert.ok(decision.text.length < 9000);
});

test('reads the prompt and cwd from the event, tolerating a byte-order mark', () => {
  assert.deepEqual(
    parsePromptHookEvent(`﻿${JSON.stringify({ prompt: 'fix login', cwd: 'D:/app' })}`),
    { prompt: 'fix login', cwd: 'D:/app' }
  );
  assert.deepEqual(parsePromptHookEvent(JSON.stringify({ prompt: 'fix login' })), { prompt: 'fix login', cwd: undefined });
  assert.equal(parsePromptHookEvent(JSON.stringify({ cwd: 'D:/app' })), undefined);
  assert.equal(parsePromptHookEvent('not json'), undefined);
  assert.equal(parsePromptHookEvent('[]'), undefined);
});

test('CLI adds the map to stdout, audits it without the prompt text, and exits 0', async () => {
  const cwd = await scratchDirectory('tokio-prompt-hook-');
  await mkdir(join(cwd, 'src', 'billing'), { recursive: true });
  await writeFile(join(cwd, 'src', 'billing', 'invoice.ts'), FILES[0].content, 'utf8');

  const prompt = 'Fix the invoice total rounding in the billing module';
  const result = spawnSync(process.execPath, [CLI, 'prompt-hook'], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd }),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Repository map:/);
  assert.match(result.stdout, /createInvoice/);

  const log = await readFile(join(cwd, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8');
  const entries = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'prompt-hook');
  assert.equal(entries[0].blocked, false);
  assert.deepEqual(entries[0].files, ['src/billing/invoice.ts']);
  assert.equal(log.includes(prompt), false);
});

test('CLI fails open with no output for skipped, malformed, and missing-repository events', () => {
  const cases: string[] = [
    JSON.stringify({ prompt: 'fix invoice', cwd: process.cwd() }),
    'not json',
    JSON.stringify({ cwd: process.cwd() }),
    JSON.stringify({ prompt: 'Fix the invoice total rounding in the billing module', cwd: join(tmpdir(), 'tokio-missing-repo-does-not-exist') })
  ];
  for (const input of cases) {
    const result = spawnSync(process.execPath, [CLI, 'prompt-hook'], { input, encoding: 'utf8' });
    assert.equal(result.status, 0, `exit status for ${input}`);
    assert.equal(result.stdout, '', `stdout for ${input}`);
  }
});

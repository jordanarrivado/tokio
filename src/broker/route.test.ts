import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Broker } from './tools';

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-route-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

test('route_task recommends a single model with no planning for a small task', async () => {
  const root = await createRepo({ 'src/app.ts': 'export const app = 1;\n' });
  const outcome = await new Broker(root).callTool('route_task', { task: 'Rename the app constant' });

  assert.equal(outcome.isError, undefined);
  assert.match(outcome.text, /Tier: small/);
  assert.match(outcome.text, /1\. plan: no model change\. Skip planning\./);
  assert.match(outcome.text, /2\. execute: sonnet \(mid\)\./);
  assert.doesNotMatch(outcome.text, /\[tokio estimate/);
});

test('route_task recommends planning on the large model for a risky multi-module task, and audits the tier', async () => {
  const root = await createRepo({
    'services/payroll/run.ts': 'export function runPayroll() { return authorize(); }\n',
    'modules/auth/guard.ts': 'export function authorize() { return payroll; }\n',
    'app/Reports/export.ts': 'export const payrollReport = 1; // auth\n'
  });
  const outcome = await new Broker(root).callTool('route_task', {
    task: 'Migrate payroll and auth schema across services'
  });

  assert.match(outcome.text, /Tier: large/);
  assert.match(outcome.text, /1\. plan: opus \(large\)\./);
  const audit = await readFile(join(root, '.tokio', 'audit.log'), 'utf8');
  assert.match(audit, /"tool":"route_task".*"route":\{"tier":"large"/);
});

test('route_task reports the detected Laravel validation command', async () => {
  const root = await createRepo({
    'artisan': '#!/usr/bin/env php\n',
    'composer.json': '{}\n',
    'app/Http/Controllers/Example.php': '<?php\n'
  });
  const outcome = await new Broker(root).callTool('route_task', { task: 'Add a field to the example controller' });

  assert.match(outcome.text, /Validation: php artisan test/);
});

test('route_task redacts secrets and never echoes the task text', async () => {
  const root = await createRepo({ 'src/auth.ts': 'export const auth = 1;\n' });
  const outcome = await new Broker(root).callTool('route_task', {
    task: 'Fix auth using key sk-abcdefghijklmnopqrstuvwxyz1234'
  });

  assert.doesNotMatch(outcome.text, /sk-abcdef/);
});

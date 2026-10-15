import { strict as assert } from 'node:assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendAuditEntry, AUDIT_DIRECTORY, AUDIT_FILE } from './audit';

test('appends one JSON line per call with metadata and no content fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-audit-'));
  const now = new Date('2026-10-15T00:00:00.000Z');

  await appendAuditEntry(root, {
    tool: 'read_symbol',
    inputTokens: 12,
    outputTokens: 340,
    files: ['src/auth/login.ts'],
    redactions: [],
    blocked: false
  }, now);
  await appendAuditEntry(root, {
    tool: 'read_symbol',
    inputTokens: 9,
    outputTokens: 0,
    files: ['.env'],
    redactions: [],
    blocked: true
  }, now);

  const lines = (await readFile(join(root, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(first.timestamp, '2026-10-15T00:00:00.000Z');
  assert.equal(first.tool, 'read_symbol');
  assert.equal(first.outputTokens, 340);
  assert.deepEqual(first.files, ['src/auth/login.ts']);
  assert.equal(JSON.parse(lines[1]).blocked, true);
  assert.deepEqual(Object.keys(first).sort(), [
    'blocked', 'files', 'inputTokens', 'outputTokens', 'redactions', 'timestamp', 'tool'
  ]);
});

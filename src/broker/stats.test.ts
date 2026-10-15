import { strict as assert } from 'node:assert';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendAuditEntry } from './audit';
import { formatFooter, formatStats, readAuditEntries, summarizeAudit, type StoredAuditEntry } from './stats';
import { Broker } from './tools';
import { estimateTokens } from '../core/tokens';

const FOOTER = /\n\[tokio estimate: ([\d,]+) tokens returned, baseline ([\d,]+), (saved|added) ~([\d,]+)\]$/;

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-stats-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

function entry(overrides: Partial<StoredAuditEntry>): StoredAuditEntry {
  return {
    timestamp: '2026-10-15T00:00:00.000Z',
    tool: 'read_symbol',
    inputTokens: 1,
    outputTokens: 100,
    files: [],
    redactions: [],
    blocked: false,
    ...overrides
  };
}

test('formats the footer with a saving or an added-token figure', () => {
  assert.equal(formatFooter(100, 400), '[tokio estimate: 100 tokens returned, baseline 400, saved ~300]');
  assert.equal(formatFooter(150, 100), '[tokio estimate: 150 tokens returned, baseline 100, added ~50]');
});

test('summarizes net savings, so refinement that adds tokens reduces the total', () => {
  const stats = summarizeAudit([
    entry({ tool: 'read_symbol', outputTokens: 100, baselineTokens: 1000, savedTokens: 900 }),
    entry({ tool: 'refine_task', outputTokens: 300, baselineTokens: 200, savedTokens: -100, redactions: ['api-key'] }),
    entry({ tool: 'Read', outputTokens: 0, blocked: true })
  ]);

  assert.equal(stats.calls, 3);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.returnedTokens, 400);
  assert.equal(stats.baselineTokens, 1200);
  assert.equal(stats.savedTokens, 800);
  assert.equal(stats.redactions, 1);
  assert.equal(stats.byTool.refine_task.savedTokens, -100);
  assert.match(formatStats(stats, 'test'), /estimated net saved: ~800/);
});

test('reads the audit log and skips malformed lines, and a missing log is empty', async () => {
  const root = await createRepo({});
  assert.deepEqual(await readAuditEntries(root), []);

  await appendAuditEntry(root, {
    tool: 'repo_map', inputTokens: 1, outputTokens: 5, files: [], redactions: [], blocked: false
  }, new Date('2026-10-15T00:00:00.000Z'));
  await appendFile(join(root, '.tokio', 'audit.log'), '{partial json\n', 'utf8');

  const entries = await readAuditEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'repo_map');
});

test('read_symbol footer compares the returned range with a full-file read', async () => {
  const source = Array.from({ length: 60 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const root = await createRepo({ 'src/values.ts': source });
  const outcome = await new Broker(root).callTool('read_symbol', { path: 'src/values.ts', startLine: 1, endLine: 2 });

  const match = FOOTER.exec(outcome.text);
  assert.ok(match, 'expected an estimate footer');
  assert.equal(match[2], String(estimateTokens(source)));
  assert.equal(match[3], 'saved');
  assert.ok(Number(match[4].replace(/,/g, '')) > 0);
});

test('refine_task footer reports the added tokens honestly', async () => {
  const task = 'Fix login.';
  const outcome = await new Broker(await createRepo({})).callTool('refine_task', { task });

  const match = FOOTER.exec(outcome.text);
  assert.ok(match, 'expected an estimate footer');
  assert.equal(match[3], 'added');
});

test('blocked and failed calls carry no savings estimate', async () => {
  const root = await createRepo({ '.env': 'TOKEN=1\n' });
  const broker = new Broker(root);

  const blocked = await broker.callTool('read_symbol', { path: '.env' });
  const failed = await broker.callTool('search_output', { id: 'out-404', query: 'x' });
  assert.equal(FOOTER.test(blocked.text), false);
  assert.equal(FOOTER.test(failed.text), false);
});

test('session_stats counts only calls made since the server started', async () => {
  const root = await createRepo({ 'src/app.ts': 'export const app = 1;\n' });
  await appendAuditEntry(root, {
    tool: 'read_symbol', inputTokens: 1, outputTokens: 1, files: [], redactions: [], blocked: false,
    baselineTokens: 50, savedTokens: 49
  }, new Date('2020-01-01T00:00:00.000Z'));

  const broker = new Broker(root);
  await broker.callTool('read_symbol', { path: 'src/app.ts' });
  await broker.callTool('read_symbol', { path: 'src/app.ts' });
  const stats = await broker.callTool('session_stats', {});

  assert.match(stats.text, /calls: 2 \(blocked 0\)/);
  assert.equal(FOOTER.test(stats.text), false);
});

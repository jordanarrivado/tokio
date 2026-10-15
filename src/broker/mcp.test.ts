import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMcpServer } from './mcp';
import { Broker } from './tools';

const CLI = join(__dirname, 'cli.js');

async function setup(): Promise<{ root: string; sent: Record<string, unknown>[]; handle: (line: string) => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-mcp-'));
  await writeFile(join(root, 'app.ts'), 'export function run() {}\n', 'utf8');
  const sent: Record<string, unknown>[] = [];
  const server = createMcpServer(new Broker(root), (message) => {
    sent.push(message as Record<string, unknown>);
  });
  return { root, sent, handle: (line) => server.handleLine(line) };
}

test('initialize advertises the tools capability and usage instructions', async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }));

  const result = sent[0].result as { serverInfo: { name: string }; capabilities: object; instructions: string };
  assert.equal(sent[0].id, 1);
  assert.equal(result.serverInfo.name, 'tokio');
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.match(result.instructions, /refine_task/);
});

test('lists tools and reports tool failures as results, not protocol errors', async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const tools = (sent[0].result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
  assert.deepEqual(tools, ['refine_task', 'repo_map', 'read_symbol', 'search_output', 'session_stats', 'route_task']);

  await handle(JSON.stringify({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_symbol', arguments: { path: '.env' } }
  }));
  assert.equal(sent[1].error, undefined);
  assert.equal((sent[1].result as { isError: boolean }).isError, true);
});

test('returns protocol errors for unknown methods, bad requests, and invalid JSON', async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'resources/list' }));
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} }));
  await handle('{not json');

  assert.equal((sent[0].error as { code: number }).code, -32601);
  assert.equal((sent[1].error as { code: number }).code, -32602);
  assert.equal((sent[2].error as { code: number }).code, -32600);
  assert.equal(sent[2].id, null);
});

test('accepts requests prefixed with a UTF-8 byte-order mark', async () => {
  const { sent, handle } = await setup();
  await handle(`﻿${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'ping' })}`);
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 6, result: {} });
});

test('notifications never receive a response', async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(sent.length, 0);
});

test('stdio server keeps stdout to protocol messages only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-mcp-stdio-'));
  const child = spawn(process.execPath, [CLI, 'mcp', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(exitCode, 0);

  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal((JSON.parse(lines[1]) as { id: number }).id, 2);
});

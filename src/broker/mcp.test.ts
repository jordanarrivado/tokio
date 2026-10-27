import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMcpServer } from './mcp';
import { Broker } from './tools';

const CLI = join(__dirname, 'cli.js');

/** Builds a server on a temp repo. stub can replace Broker handlers before the server starts. */
async function setup(stub?: (broker: Broker) => void): Promise<{
  root: string;
  sent: Record<string, unknown>[];
  handle: (line: string) => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-mcp-'));
  await writeFile(join(root, 'app.ts'), 'export function run() {}\n', 'utf8');
  const broker = new Broker(root);
  stub?.(broker);
  const sent: Record<string, unknown>[] = [];
  const server = createMcpServer(broker, (message) => {
    sent.push(message as Record<string, unknown>);
  });
  return { root, sent, handle: (line) => server.handleLine(line) };
}

/** Replaces a private Broker handler on one instance, so a test controls what it returns. */
function stubHandler(broker: Broker, handler: string, fn: (...args: never[]) => unknown): void {
  (broker as unknown as Record<string, unknown>)[handler] = fn;
}

/** A handler that never settles, for the timeout and cancellation paths. */
const HANG = (): Promise<never> => new Promise(() => {});

/** A handler that stays pending until the test calls release. */
function deferredHandler(): { handler: () => Promise<unknown>; release: () => void } {
  let settle: () => void = () => {};
  return {
    handler: () => new Promise((resolve) => {
      settle = () => resolve({ text: 'map' });
    }),
    release: () => settle()
  };
}

/** Waits one event-loop turn, so queued requests reach their handlers. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function callLine(id: number, name = 'repo_map'): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { task: 'x' } } });
}

function cancelLine(requestId: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
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
  assert.deepEqual(tools, [
    'refine_task', 'repo_map', 'read_symbol', 'search_output', 'session_stats', 'route_task', 'find_symbol', 'list_repositories', 'ask_repo'
  ]);

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

test('a timed-out call does not hold the queue: the next request runs right after', { timeout: 2000 }, async (t) => {
  const { sent, handle } = await setup((broker) => stubHandler(broker, 'repoMap', HANG));
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Queue the two requests in order, as serveStdio does.
  const queue = handle(callLine(1)).then(() => handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })));
  // Let the queued call start, so its 10s timer exists before the clock moves.
  await nextTurn();
  t.mock.timers.tick(10_000);
  await queue;

  // No mocked time passed after the timeout, so the ping ran well within 100 ms of it.
  assert.equal((sent[0].result as { isError: boolean }).isError, true);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, result: {} });
});

test('cancelling an in-flight call aborts its signal and sends no response for it', { timeout: 2000 }, async () => {
  let received: AbortSignal | undefined;
  const { sent, handle } = await setup((broker) => stubHandler(broker, 'repoMap', (_args: unknown, signal: AbortSignal) => {
    received = signal;
    return HANG();
  }));

  const call = handle(callLine(1));
  await nextTurn();
  await handle(cancelLine(1));
  await call;

  assert.equal(received?.aborted, true);
  assert.equal(sent.length, 0);
});

test('a cancelled queued call never runs and gets no response', { timeout: 2000 }, async () => {
  const blocker = deferredHandler();
  const runs: string[] = [];
  const { sent, handle } = await setup((broker) => {
    stubHandler(broker, 'repoMap', () => {
      runs.push('repo_map');
      return blocker.handler();
    });
    stubHandler(broker, 'routeTask', async () => {
      runs.push('route_task');
      return { text: 'route', estimate: false };
    });
  });

  void handle(callLine(1));
  const queued = handle(callLine(2, 'route_task'));
  void handle(cancelLine(2));
  await nextTurn();
  blocker.release();
  await queued;

  assert.deepEqual(runs, ['repo_map']);
  assert.deepEqual(sent.map((message) => message.id), [1]);
});

test('cancelling an unknown or finished request is ignored without a response or error', { timeout: 2000 }, async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  await handle(cancelLine(1));
  await handle(cancelLine(99));
  await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }));
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }));

  assert.deepEqual(sent, [
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 2, result: {} }
  ]);
});

test('cancelling one request leaves the others answered and in order', { timeout: 2000 }, async () => {
  const blocker = deferredHandler();
  const { sent, handle } = await setup((broker) => stubHandler(broker, 'repoMap', blocker.handler));

  void handle(callLine(1));
  void handle(callLine(2));
  void handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }));
  const last = handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
  void handle(cancelLine(2));
  await nextTurn();
  blocker.release();
  await last;

  assert.deepEqual(sent.map((message) => message.id), [1, 3, 4]);
  assert.equal((sent[0].result as { isError?: boolean }).isError, undefined);
});

test('initialize instructions mention find_symbol and list_repositories', async () => {
  const { sent, handle } = await setup();
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  const { instructions } = sent[0].result as { instructions: string };
  assert.match(instructions, /find_symbol/);
  assert.match(instructions, /list_repositories/);
});

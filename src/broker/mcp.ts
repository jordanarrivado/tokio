import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Broker, ToolOutcome } from './tools';

/**
 * Minimal MCP server over newline-delimited JSON-RPC on stdio. It uses no SDK, so the
 * extension keeps zero runtime dependencies. stdout carries protocol messages only.
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_VERSION: string = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
const INSTRUCTIONS = [
  'Tokio reduces context. For a coding task: call refine_task once with the task text,',
  'then repo_map to find relevant files and line numbers, then read_symbol only for the bodies you need.',
  'read_symbol returns only changed lines on repeat reads. search_output queries truncated results.',
  'Secret files are blocked.'
].join(' ');

const JSON_RPC_VERSION = '2.0';
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export interface McpServer {
  handleLine(line: string): Promise<void>;
}

export function createMcpServer(broker: Broker, send: (message: object) => void): McpServer {
  // Requests run one at a time in arrival order. Cancellations skip the queue, so they can reach a running call.
  let queue: Promise<void> = Promise.resolve();
  const pending = new Map<string, AbortController>();

  async function handleMessage(message: unknown, signal: AbortSignal): Promise<void> {
    if (!isRecord(message) || typeof message.method !== 'string') {
      if (isRecord(message) && 'id' in message) {
        send(errorResponse(message.id, INVALID_REQUEST, 'Invalid request.'));
      }
      return;
    }

    const isNotification = !('id' in message);
    try {
      const result = await dispatch(message.method, message.params, broker, signal);
      // A cancelled request gets no response, as MCP requires.
      if (!isNotification && !signal.aborted) {
        send({ jsonrpc: JSON_RPC_VERSION, id: message.id, result });
      }
    } catch (error) {
      if (!isNotification && !signal.aborted) {
        const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
        const text = error instanceof Error ? error.message : String(error);
        send(errorResponse(message.id, code, text));
      }
    }
  }

  return {
    handleLine(line: string): Promise<void> {
      // Some Windows writers prepend a UTF-8 byte-order mark, which JSON.parse rejects.
      const text = line.replace(/^﻿/, '');
      if (text.trim().length === 0) {
        return queue;
      }
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        queue = queue.then(() => send(errorResponse(null, INVALID_REQUEST, 'Could not parse JSON.')));
        return queue;
      }

      if (isRecord(message) && message.method === 'notifications/cancelled') {
        const params = isRecord(message.params) ? message.params : {};
        pending.get(JSON.stringify(params.requestId))?.abort();
        return queue;
      }

      const controller = new AbortController();
      const key = isRecord(message) && 'id' in message ? JSON.stringify(message.id) : undefined;
      if (key !== undefined) {
        pending.set(key, controller);
      }
      queue = queue.then(async () => {
        await handleMessage(message, controller.signal);
        if (key !== undefined && pending.get(key) === controller) {
          pending.delete(key);
        }
      });
      return queue;
    }
  };
}

async function dispatch(method: string, params: unknown, broker: Broker, signal: AbortSignal): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tokio', version: SERVER_VERSION },
        instructions: INSTRUCTIONS
      };
    case 'notifications/initialized':
      return undefined;
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: broker.listTools() };
    case 'tools/call': {
      const request = isRecord(params) ? params : {};
      if (typeof request.name !== 'string') {
        throw new RpcError(INVALID_PARAMS, 'tools/call requires a tool name.');
      }
      const outcome: ToolOutcome = await broker.callTool(
        request.name,
        isRecord(request.arguments) ? request.arguments : {},
        signal
      );
      return {
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {})
      };
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function errorResponse(id: unknown, code: number, message: string): object {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runs the server on the process's stdin and stdout until stdin closes. */
export function serveStdio(broker: Broker): void {
  const server = createMcpServer(broker, (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const lines = createInterface({ input: process.stdin });
  let last: Promise<void> = Promise.resolve();
  lines.on('line', (line) => {
    // The server queues requests in arrival order itself; handing it each line at once lets cancellations through.
    last = server.handleLine(line);
  });
  lines.on('close', () => {
    void last.then(() => process.exit(0));
  });
}

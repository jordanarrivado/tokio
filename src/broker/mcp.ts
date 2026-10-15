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
  async function handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.method !== 'string') {
      if (isRecord(message) && 'id' in message) {
        send(errorResponse(message.id, INVALID_REQUEST, 'Invalid request.'));
      }
      return;
    }

    const isNotification = !('id' in message);
    try {
      const result = await dispatch(message.method, message.params, broker);
      if (!isNotification) {
        send({ jsonrpc: JSON_RPC_VERSION, id: message.id, result });
      }
    } catch (error) {
      if (!isNotification) {
        const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
        const text = error instanceof Error ? error.message : String(error);
        send(errorResponse(message.id, code, text));
      }
    }
  }

  return {
    async handleLine(line: string): Promise<void> {
      // Some Windows writers prepend a UTF-8 byte-order mark, which JSON.parse rejects.
      const text = line.replace(/^﻿/, '');
      if (text.trim().length === 0) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        send(errorResponse(null, INVALID_REQUEST, 'Could not parse JSON.'));
        return;
      }
      await handleMessage(message);
    }
  };
}

async function dispatch(method: string, params: unknown, broker: Broker): Promise<unknown> {
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
      const outcome: ToolOutcome = await broker.callTool(request.name, isRecord(request.arguments) ? request.arguments : {});
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
  let chain: Promise<void> = Promise.resolve();
  lines.on('line', (line) => {
    // Handle requests in arrival order so responses never interleave with later state changes.
    chain = chain.then(() => server.handleLine(line));
  });
  lines.on('close', () => {
    void chain.then(() => process.exit(0));
  });
}

import { isSecretPath } from '../context/discovery';
import { findBroadReadCommand, findSecretReference } from './policy';

/** Tool-input fields that name a file or search location. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'glob'] as const;

export interface HookVerdict {
  blocked: boolean;
  tool: string;
  reason?: string;
  path?: string;
  cwd?: string;
  /** The catalog repository an edit was blocked in, for the audit log. */
  repo?: string;
}

/**
 * Decides whether a Claude Code PreToolUse event may run. Blocks secret paths in file fields and
 * in Bash commands. Unparseable input is blocked, because failing open would bypass the rule.
 */
export function evaluateToolUse(raw: string): HookVerdict {
  const event = parseToolUse(raw);
  if (!event) {
    return { blocked: true, tool: 'unknown', reason: 'Tokio could not read the hook input, so the call was blocked.' };
  }
  const { tool, cwd, toolInput } = event;

  for (const field of PATH_FIELDS) {
    const value = toolInput[field];
    if (typeof value === 'string' && isSecretPath(value)) {
      return { blocked: true, tool, path: value, reason: `${field} names a secret file.`, cwd };
    }
  }

  if (typeof toolInput.command === 'string') {
    const reference = findSecretReference(toolInput.command);
    if (reference) {
      return { blocked: true, tool, path: reference, reason: 'the command references a secret file.', cwd };
    }
    const broad = findBroadReadCommand(toolInput.command, 0, tool === 'PowerShell' ? 'powershell' : 'bash');
    if (broad) {
      return { blocked: true, tool, reason: `${broad} Name the files explicitly instead.`, cwd };
    }
  }

  return { blocked: false, tool, cwd };
}

/** The tool name, cwd, and tool input of a PreToolUse event, or undefined when it cannot be read. */
export function parseToolUse(raw: string): { tool: string; cwd?: string; toolInput: Record<string, unknown> } | undefined {
  const input = parseRecord(raw);
  if (!input) {
    return undefined;
  }
  return {
    tool: typeof input.tool_name === 'string' ? input.tool_name : 'unknown',
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    toolInput: isRecord(input.tool_input) ? input.tool_input : {}
  };
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    // Tolerate a UTF-8 byte-order mark, as the MCP server does.
    const parsed: unknown = JSON.parse(raw.replace(/^﻿/, ''));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

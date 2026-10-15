import { isSecretPath } from '../context/discovery';
import { findSecretReference } from './policy';

/** Tool-input fields that name a file or search location. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path', 'glob'] as const;

export interface HookVerdict {
  blocked: boolean;
  tool: string;
  reason?: string;
  path?: string;
  cwd?: string;
}

/**
 * Decides whether a Claude Code PreToolUse event may run. Blocks secret paths in file fields and
 * in Bash commands. Unparseable input is blocked, because failing open would bypass the rule.
 */
export function evaluateToolUse(raw: string): HookVerdict {
  const input = parseRecord(raw);
  if (!input) {
    return { blocked: true, tool: 'unknown', reason: 'Tokio could not read the hook input, so the call was blocked.' };
  }

  const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};

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
  }

  return { blocked: false, tool, cwd };
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

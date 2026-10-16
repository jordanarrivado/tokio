import type { RepoFile } from '../context/repomap';
import { buildRepoMap } from '../context/repomap';
import { findRelevantFiles } from '../context/routing';
import { estimateTokens } from '../core/tokens';
import { redactSecrets } from './policy';

/**
 * UserPromptSubmit hook logic. Adds a bounded repository map to a prompt when the prompt matches
 * files in the repository. Everything here is pure; the CLI handles stdin, stdout, and the audit log.
 */

export const PROMPT_HOOK_BUDGET_TOKENS = 1500;
/** Prompts shorter than this are unlikely to name a task, so no context is added. */
export const MIN_PROMPT_CHARS = 20;
/** Claude Code caps hook context at 10,000 characters per field. Stay well under it. */
const MAX_CONTEXT_CHARS = 9000;

export interface PromptHookEvent {
  prompt: string;
  cwd?: string;
}

export type PromptHookDecision =
  | { inject: false; reason: string }
  | { inject: true; text: string; files: string[]; tokens: number; redactions: string[] };

/** Reads the UserPromptSubmit event. Returns undefined for anything without a usable prompt. */
export function parsePromptHookEvent(raw: string): PromptHookEvent | undefined {
  let parsed: unknown;
  try {
    // Tolerate a UTF-8 byte-order mark, as the other hook does.
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.prompt !== 'string') {
    return undefined;
  }
  return {
    prompt: record.prompt,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined
  };
}

/** Decides whether a prompt gets repository context, and builds that context when it does. */
export function decidePromptContext(
  prompt: string,
  files: readonly RepoFile[],
  coChange?: ReadonlyMap<string, readonly string[]>
): PromptHookDecision {
  const task = prompt.trim();
  if (task.length < MIN_PROMPT_CHARS) {
    return { inject: false, reason: 'prompt is too short to describe a coding task' };
  }
  // Slash commands are handled by Claude Code itself and are not coding requests.
  if (task.startsWith('/')) {
    return { inject: false, reason: 'prompt is a slash command' };
  }
  // The map always ranks files, so only inject when the prompt actually matches repository files.
  if (findRelevantFiles(files, task).length === 0) {
    return { inject: false, reason: 'no repository files match the prompt' };
  }

  const map = buildRepoMap(files, { task, budgetTokens: PROMPT_HOOK_BUDGET_TOKENS, coChange });
  if (map.files.length === 0) {
    return { inject: false, reason: 'no symbols fit the context budget' };
  }

  // Signatures can contain literal credentials, so the same redaction used for refined prompts applies here.
  const redacted = redactSecrets(map.text);
  if (redacted.text.length > MAX_CONTEXT_CHARS) {
    return { inject: false, reason: 'context exceeds the hook size limit' };
  }
  return {
    inject: true,
    text: redacted.text,
    files: map.files,
    tokens: estimateTokens(redacted.text),
    redactions: redacted.redactions
  };
}

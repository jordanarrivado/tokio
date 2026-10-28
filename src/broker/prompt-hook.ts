import type { RepoFile } from '../context/repomap';
import { buildRepoMap } from '../context/repomap';
import { findRelevantFiles } from '../context/routing';
import { estimateTokens } from '../core/tokens';
import { formatMapRouting, rankMapAreas, type MapArea, type MapRouting, type RankedArea } from '../context/archmap';
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
/** `~name` at the start of a word, as in "~api: why is this needed" or "ask ~tokio to fix it". */
const ADDRESSES_REPO = /(?:^|\s)~[\w-]+/;
/** A message from another agent session. It quotes domain words without asking for code work here. */
const PEER_MESSAGE = /<cross-session-message\b/;

/** Prompts that are for or from another agent, which never need this repository's context. */
function isAgentRelay(task: string): boolean {
  return ADDRESSES_REPO.test(task) || PEER_MESSAGE.test(task);
}

export interface PromptHookEvent {
  prompt: string;
  cwd?: string;
  /** Claude Code's session id, used to send each architecture map area once per session. */
  sessionId?: string;
}

/** Map areas matching a prompt, split into those not yet sent in this session and those already sent. */
export type MapDecision =
  | { use: false }
  | { use: true; fresh: RankedArea[]; repeated: string[] };

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
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    ...(typeof record.session_id === 'string' && record.session_id.length > 0 ? { sessionId: record.session_id } : {})
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
  if (isAgentRelay(task)) {
    return { inject: false, reason: 'prompt is for or from another agent session' };
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

/**
 * Matches a prompt against the architecture map. A match replaces the repository map, since the map names exact
 * files and lines. Areas already sent in this session are only named again, because the agent still has them.
 */
export function decideMapContext(prompt: string, areas: readonly MapArea[], sent: ReadonlySet<string>): MapDecision {
  const task = prompt.trim();
  // A prompt that addresses another repository (~api) is for that repository's agent, not this map.
  if (task.length < MIN_PROMPT_CHARS || task.startsWith('/') || areas.length === 0 || isAgentRelay(task)) {
    return { use: false };
  }
  const ranked = rankMapAreas(areas, task);
  if (ranked.length === 0) {
    return { use: false };
  }
  return {
    use: true,
    fresh: ranked.filter((entry) => !sent.has(entry.area.name)),
    repeated: ranked.filter((entry) => sent.has(entry.area.name)).map((entry) => entry.area.name)
  };
}

/** The hook's text for a map match: new areas with their lines, then a one-line pointer to areas already sent. */
export function formatMapContext(routing: MapRouting | undefined, repeated: readonly string[]): { text: string; redactions: string[] } {
  const parts: string[] = [];
  if (routing && routing.areas.length > 0) {
    parts.push(formatMapRouting(routing));
  }
  if (repeated.length > 0) {
    parts.push(`Architecture map areas already sent in this session: ${repeated.join(', ')}. Reuse those lines.`);
  }
  return redactSecrets(parts.join('\n'));
}

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * One line per broker call. Entries record sizes, paths, and redaction kinds only;
 * they never contain file contents or prompt text.
 */
export interface AuditEntry {
  tool: string;
  /** Estimated tokens of the arguments the agent sent. */
  inputTokens: number;
  /** Estimated tokens of the text returned to the agent. */
  outputTokens: number;
  files: string[];
  redactions: string[];
  blocked: boolean;
  /** Estimated tokens a full-file or full-text alternative would have returned. Absent when not measured. */
  baselineTokens?: number;
  /** baselineTokens minus outputTokens. Negative when the call added tokens. */
  savedTokens?: number;
  /** Routing decision from route_task. Tier and confidence only; no task text. */
  route?: { tier: string; confidence: string };
}

export const AUDIT_DIRECTORY = '.tokio';
export const AUDIT_FILE = 'audit.log';

export async function appendAuditEntry(root: string, entry: AuditEntry, now = new Date()): Promise<void> {
  const directory = join(root, AUDIT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const record = { timestamp: now.toISOString(), ...entry };
  await appendFile(join(directory, AUDIT_FILE), `${JSON.stringify(record)}\n`, 'utf8');
}

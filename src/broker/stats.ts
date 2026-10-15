import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIT_DIRECTORY, AUDIT_FILE, type AuditEntry } from './audit';

/**
 * Every figure here is an estimate from characters ÷ 4. "Baseline" is a counterfactual: what a
 * full-file or full-text read would have returned. Real billing comes from the model's usage data.
 */

export interface StoredAuditEntry extends AuditEntry {
  timestamp: string;
}

export interface ToolStats {
  calls: number;
  savedTokens: number;
}

export interface SessionStats {
  calls: number;
  blocked: number;
  returnedTokens: number;
  baselineTokens: number;
  /** Net of tools that added tokens (refine_task), so it can be negative. */
  savedTokens: number;
  redactions: number;
  byTool: Record<string, ToolStats>;
}

export async function readAuditEntries(root: string): Promise<StoredAuditEntry[]> {
  let text: string;
  try {
    text = await readFile(join(root, AUDIT_DIRECTORY, AUDIT_FILE), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const entries: StoredAuditEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isStoredEntry(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // A partial or damaged line must not hide the rest of the log.
    }
  }
  return entries;
}

export function summarizeAudit(entries: readonly StoredAuditEntry[]): SessionStats {
  const stats: SessionStats = {
    calls: 0,
    blocked: 0,
    returnedTokens: 0,
    baselineTokens: 0,
    savedTokens: 0,
    redactions: 0,
    byTool: {}
  };

  for (const entry of entries) {
    stats.calls += 1;
    stats.returnedTokens += entry.outputTokens;
    stats.redactions += (entry.redactions ?? []).length;
    if (entry.blocked) {
      stats.blocked += 1;
    }

    const tool = stats.byTool[entry.tool] ?? { calls: 0, savedTokens: 0 };
    tool.calls += 1;
    if (entry.savedTokens !== undefined) {
      stats.baselineTokens += entry.baselineTokens ?? 0;
      stats.savedTokens += entry.savedTokens;
      tool.savedTokens += entry.savedTokens;
    }
    stats.byTool[entry.tool] = tool;
  }
  return stats;
}

export function formatStats(stats: SessionStats, scope: string): string {
  const toolRows = Object.entries(stats.byTool)
    .sort(([, left], [, right]) => right.calls - left.calls)
    .map(([tool, value]) => `    ${tool.padEnd(14)} calls ${value.calls}, net ${formatSigned(value.savedTokens)}`);

  return [
    `Tokio usage, ${scope} (estimates: characters ÷ 4)`,
    `  calls: ${stats.calls} (blocked ${stats.blocked})`,
    `  tokens returned: ~${formatTokens(stats.returnedTokens)}`,
    `  baseline (full-file or full-text alternative): ~${formatTokens(stats.baselineTokens)}`,
    `  estimated net saved: ${formatSigned(stats.savedTokens)}`,
    `  redacted values: ${stats.redactions}`,
    ...(toolRows.length > 0 ? ['  by tool:', ...toolRows] : [])
  ].join('\n');
}

/** One-line footer appended to a broker result, so the agent and user see the estimate. */
export function formatFooter(returned: number, baseline: number): string {
  const delta = baseline - returned;
  const change = delta >= 0 ? `saved ~${formatTokens(delta)}` : `added ~${formatTokens(-delta)}`;
  return `[tokio estimate: ${formatTokens(returned)} tokens returned, baseline ${formatTokens(baseline)}, ${change}]`;
}

export function formatTokens(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatSigned(value: number): string {
  return `${value < 0 ? '-' : ''}~${formatTokens(Math.abs(value))}`;
}

function isStoredEntry(value: unknown): value is StoredAuditEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.timestamp === 'string'
    && typeof record.tool === 'string'
    && typeof record.outputTokens === 'number';
}

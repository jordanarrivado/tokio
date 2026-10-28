import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens } from '../core/tokens';
import { redactSecrets } from './policy';

/**
 * PostToolUse output compaction. Test, build, lint, and install commands print long logs where only the
 * failures and the summary matter. Tokio keeps those lines, saves the full output, and gives the agent an id
 * it can pass to search_output for the rest.
 */

/** Commands whose output is mostly progress and passing lines. Matched anywhere in the command. */
const NOISY_COMMANDS: readonly RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+)?(?:test|build|check|lint|verify|compile|install|ci|i|add)\b/,
  /\b(?:tsc|jest|vitest|mocha|eslint|webpack)\b/,
  /\b(?:vite|next)\s+build\b/,
  /\bnode\s+--test\b/,
  /\b(?:pytest|tox|mypy|ruff|flake8)\b/,
  /\bpython\d?(?:\.exe)?\s+-m\s+(?:pytest|unittest|pip\s+install)\b/,
  /\bpip\d?\s+install\b/,
  /\bcargo\s+(?:test|build|check|clippy)\b/,
  /\bgo\s+(?:test|build|vet)\b/,
  /\b(?:phpunit|pest)\b/,
  /\bartisan\s+test\b/,
  /\bcomposer\s+(?:install|update|require)\b/,
  /\b(?:gradlew?|mvn)\b/,
  /\bdotnet\s+(?:build|test)\b/,
  /(?:^|[\s;&|])make(?:\s|$)/
];

/** Failures and thrown errors. These get the line budget first. */
const STRONG_SIGNAL =
  /[✖✗×❌]|^\s*(?:not ok|FAIL(?:ED)?)\b|\b[A-Za-z]*(?:Error|Exception)\b(?::|\s+\[|\s+thrown)|\bTraceback\b|\bpanicked\b|ERR!|\berror(?:\[E\d+\]|\s+TS\d+)?:/;
/** Other lines worth keeping: warnings, assertions, and file:line locations. */
const WEAK_SIGNAL =
  /\b(?:errors?|fail(?:ed|ure|ures|ing)?|exception|assert(?:ion)?|expected|received|warn(?:ing)?|denied|cannot|unable)\b|:\d+:\d+|\(\d+,\d+\)/i;
/** Passing-test lines, which often name errors in the test title. Never signals. */
const PASSING = /^\s*(?:[✔✓√]|ok \d|PASS\b)/;

/** Below this size the output is returned unchanged. */
const MIN_COMPACT_CHARS = 4000;
const HEAD_LINES = 5;
const TAIL_LINES = 20;
/** Lines kept after each signal line, for stack frames and expected/actual pairs. */
const AFTER_SIGNAL = 2;
const MAX_SIGNAL_LINES = 80;
const MAX_LINE_CHARS = 400;
/** Compaction must remove at least this share of the lines, or the original is kept. */
const MIN_SAVING = 0.3;

export const OUTPUT_DIRECTORY = join(tmpdir(), 'tokio-outputs');
const OUTPUT_ID = /^run-[a-z0-9]+-[0-9a-f]+$/;
const MAX_SAVED_OUTPUTS = 50;

export function isNoisyCommand(command: string): boolean {
  return NOISY_COMMANDS.some((pattern) => pattern.test(command));
}

export interface CompactedText {
  text: string;
  /** Lines in the output after cleaning, before selection. */
  total: number;
  /** Lines kept, not counting omission markers. */
  shown: number;
}

/**
 * Keeps the head, the tail, and each signal line with a little context, in order, with a marker for each gap.
 * ANSI codes and carriage-return progress are removed and repeated lines collapse into one.
 */
export function compactText(text: string): CompactedText {
  const lines = collapseRepeats(cleanLines(text));
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(HEAD_LINES, lines.length); index += 1) {
    keep.add(index);
  }
  for (let index = Math.max(0, lines.length - TAIL_LINES); index < lines.length; index += 1) {
    keep.add(index);
  }
  // Strong signals first, so a run of warnings cannot use up the budget before the failure.
  let signalLines = 0;
  for (const signal of [STRONG_SIGNAL, WEAK_SIGNAL]) {
    for (let index = 0; index < lines.length && signalLines < MAX_SIGNAL_LINES; index += 1) {
      if (PASSING.test(lines[index]) || !signal.test(lines[index])) {
        continue;
      }
      for (let offset = 0; offset <= AFTER_SIGNAL && index + offset < lines.length; offset += 1) {
        if (!keep.has(index + offset)) {
          keep.add(index + offset);
          signalLines += 1;
        }
      }
    }
  }

  const out: string[] = [];
  let gap = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep.has(index)) {
      gap += 1;
      continue;
    }
    if (gap > 0) {
      out.push(`… ${gap} line${gap === 1 ? '' : 's'} omitted`);
      gap = 0;
    }
    const line = lines[index];
    out.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
  }
  if (gap > 0) {
    out.push(`… ${gap} line${gap === 1 ? '' : 's'} omitted`);
  }
  return { text: out.join('\n'), total: lines.length, shown: keep.size };
}

export interface CompactedOutput {
  stdout: string;
  stderr: string;
  /** Redacted stdout and stderr together, for saving. */
  full: string;
  total: number;
  shown: number;
  baselineTokens: number;
  redactions: string[];
}

/** Compacts a noisy command's output. Undefined when the command is not noisy or compaction saves too little. */
export function compactCommandOutput(command: string, stdout: string, stderr: string): CompactedOutput | undefined {
  if (!isNoisyCommand(command) || stdout.length + stderr.length < MIN_COMPACT_CHARS) {
    return undefined;
  }
  const out = compactText(stdout);
  const err = compactText(stderr);
  const total = out.total + err.total;
  if (total === 0 || (out.shown + err.shown) / total > 1 - MIN_SAVING) {
    return undefined;
  }

  const shownOut = redactSecrets(out.text);
  const shownErr = redactSecrets(err.text);
  const full = redactSecrets(`$ ${command}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  return {
    stdout: shownOut.text,
    stderr: shownErr.text,
    full: full.text,
    total,
    shown: out.shown + err.shown,
    baselineTokens: estimateTokens(stdout) + estimateTokens(stderr),
    redactions: [...new Set([...shownOut.redactions, ...shownErr.redactions, ...full.redactions])]
  };
}

export function formatCompactFooter(compacted: CompactedOutput, id: string): string {
  return `[tokio: kept ${compacted.shown} of ${compacted.total} lines (errors, failures, head, tail). Full output: search_output id "${id}".]`;
}

/** Saves a full output and returns its id. Keeps the newest MAX_SAVED_OUTPUTS files. */
export async function saveOutput(text: string, directory = OUTPUT_DIRECTORY, now = new Date()): Promise<string> {
  await mkdir(directory, { recursive: true });
  const id = `run-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
  await writeFile(join(directory, `${id}.log`), text, 'utf8');
  const saved = (await readdir(directory)).filter((name) => OUTPUT_ID.test(name.replace(/\.log$/, ''))).sort();
  for (const name of saved.slice(0, Math.max(0, saved.length - MAX_SAVED_OUTPUTS))) {
    await rm(join(directory, name), { force: true });
  }
  return id;
}

/** A saved output by id, or undefined when the id is not a saved-output id or the file is gone. */
export async function readSavedOutput(id: string, directory = OUTPUT_DIRECTORY): Promise<string | undefined> {
  if (!OUTPUT_ID.test(id)) {
    return undefined;
  }
  try {
    return await readFile(join(directory, `${id}.log`), 'utf8');
  } catch {
    return undefined;
  }
}

function cleanLines(text: string): string[] {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    // A carriage return without a newline redraws the line; only the last frame was visible.
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
    .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''));
}

function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) {
      end += 1;
    }
    out.push(end - index > 1 ? `${lines[index]} (×${end - index})` : lines[index]);
    index = end;
  }
  return out;
}

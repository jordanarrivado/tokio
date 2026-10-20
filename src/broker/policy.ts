import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isSafeTextPath, isSecretPath } from '../context/discovery';

/** Raised when a request would cross a policy boundary. The message is safe to show the agent. */
export class PolicyError extends Error {}

export interface RedactionResult {
  text: string;
  /** One entry per redacted value, naming its kind. Values themselves are never returned. */
  redactions: string[];
}

interface RedactionRule {
  kind: string;
  pattern: RegExp;
  replace: (match: string, ...groups: string[]) => string;
}

const REDACTION_RULES: readonly RedactionRule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED:private-key]'
  },
  {
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED:aws-access-key]'
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replace: () => '[REDACTED:github-token]'
  },
  {
    kind: 'api-key',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
    replace: () => '[REDACTED:api-key]'
  },
  {
    kind: 'bearer-token',
    pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (_match, prefix) => `${prefix}[REDACTED:bearer-token]`
  },
  {
    kind: 'connection-password',
    pattern: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    replace: (_match, head, _password, tail) => `${head}[REDACTED:connection-password]${tail}`
  },
  {
    kind: 'assignment',
    pattern: /(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["'`]?)([^\s"'`,;]{6,})/gi,
    replace: (_match, head) => `${head}[REDACTED:assignment]`
  }
];

const COMMAND_TOKEN_SEPARATORS = /[\s'"`;|&<>()=,]+/;

/** Replaces credential-shaped values in free text before it reaches an agent. */
export function redactSecrets(text: string): RedactionResult {
  const redactions: string[] = [];
  let output = text;
  for (const rule of REDACTION_RULES) {
    output = output.replace(rule.pattern, (match: string, ...groups: string[]) => {
      redactions.push(rule.kind);
      return rule.replace(match, ...groups);
    });
  }
  return { text: output, redactions };
}

/**
 * Returns the first shell token that names a secret file, such as `cat .env` or `cat config/secrets.yaml`.
 * A bare word such as `secret` or `credentials` is a search term far more often than a path, so it needs
 * a dot or a slash to count. File fields in tool input are still checked for every path.
 */
export function findSecretReference(command: string): string | undefined {
  return command
    .split(COMMAND_TOKEN_SEPARATORS)
    .find((token) => token.length > 0 && /[./\\]/.test(token) && isSecretPath(token));
}

/**
 * Resolves a requested path inside the repository and returns its real location.
 * Rejects secret paths, paths outside the root (including through symlinks), and non-text files.
 */
export async function resolveRepoPath(root: string, requested: string): Promise<{ absolute: string; relative: string }> {
  const normalized = requested.replaceAll('\\', '/');
  if (isSecretPath(normalized)) {
    throw new PolicyError(`Blocked: ${normalized} is a secret path.`);
  }

  const relativePath = toRepoRelative(root, normalized);
  if (isOutside(relativePath)) {
    throw new PolicyError(OUTSIDE_REPOSITORY);
  }
  if (isSecretPath(relativePath)) {
    throw new PolicyError(`Blocked: ${relativePath} is a secret path.`);
  }
  if (!isSafeTextPath(relativePath)) {
    throw new PolicyError(`Blocked: ${relativePath} is not a supported text file.`);
  }

  const realRoot = await realpath(root);
  const realFile = await realpath(resolve(root, relativePath)).catch(() => {
    throw new PolicyError(`File not found: ${relativePath}`);
  });
  const realRelative = relative(realRoot, realFile).replaceAll('\\', '/');
  if (isOutside(realRelative)) {
    throw new PolicyError('Blocked: path resolves outside the repository.');
  }
  if (isSecretPath(realRelative)) {
    throw new PolicyError(`Blocked: ${relativePath} resolves to a secret path.`);
  }

  return { absolute: realFile, relative: relativePath };
}

/**
 * Repo-relative prefix that a search is limited to: a directory or a file. Returns '' for the root.
 * Blocks paths outside the repository, like resolveRepoPath, but does not require the path to exist.
 */
export function resolveRepoScope(root: string, requested: string): string {
  const relativePath = toRepoRelative(root, requested);
  // isOutside counts the root itself as outside, which is right for a file but not for a scope.
  if (relativePath !== '' && isOutside(relativePath)) {
    throw new PolicyError(OUTSIDE_REPOSITORY);
  }
  return relativePath;
}

const OUTSIDE_REPOSITORY = 'Blocked: path is outside the repository.';

/** Lexical repo-relative path with forward slashes. Does not touch the file system. */
function toRepoRelative(root: string, requested: string): string {
  return relative(root, resolve(root, requested.replaceAll('\\', '/'))).replaceAll('\\', '/');
}

function isOutside(relativePath: string): boolean {
  return relativePath === '' || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath);
}

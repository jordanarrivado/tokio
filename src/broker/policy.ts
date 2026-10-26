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

// ':' splits PowerShell's `-Path:.env` form; a drive letter such as `C:\x\.env` still leaves `\x\.env`.
const COMMAND_TOKEN_SEPARATORS = /[\s'"`;|&<>()=,:]+/;

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
 * a dot, a slash, or a backslash to count. Backslashes that escape a regex operator, as in grep's
 * `secret\|token`, are dropped first, so alternation is not read as a Windows path. File fields in tool
 * input are still checked for every path.
 * Heredoc bodies are scripts or data, where a bare `event.key` is code, not a file, so only their quoted
 * strings are checked, as in `open('.env')`. Command lines, including the one that opens a heredoc, are
 * checked in full.
 */
export function findSecretReference(command: string): string | undefined {
  const pendingHeredocs: string[] = [];
  for (const line of command.split('\n')) {
    if (pendingHeredocs.length > 0) {
      if (line.trim() === pendingHeredocs[0]) {
        pendingHeredocs.shift();
        continue;
      }
      const strings = Array.from(line.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g), (match) => match[1] ?? match[2] ?? match[3]);
      const found = strings.map(findSecretToken).find((token) => token !== undefined);
      if (found) {
        return found;
      }
      continue;
    }
    const found = findSecretToken(line);
    if (found) {
      return found;
    }
    // A `<<` inside quotes, as in `echo "<<EOF"`, does not open a heredoc.
    const quoted = Array.from(line.matchAll(/'[^']*'|"(?:\\.|[^"\\])*"/g), (match) => [match.index, match.index + match[0].length]);
    for (const match of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      if (!quoted.some(([start, end]) => match.index > start && match.index < end)) {
        pendingHeredocs.push(match[2]);
      }
    }
  }
  return undefined;
}

function findSecretToken(text: string): string | undefined {
  return text
    .replace(/\\(?=[|(){}+?])/g, '')
    .split(COMMAND_TOKEN_SEPARATORS)
    .find((token) => token.length > 0 && /[./\\]/.test(token) && isSecretPath(token));
}

const READER_COMMANDS = new Set(['cat', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'strings']);

/**
 * Returns a description of a command that reads whole trees, which can reach secret files without naming them:
 * recursive grep, `rg` or `git grep` over a directory, `find -exec`, and `xargs` feeding a reader. The command
 * is split into stages with quoting respected (see splitShellStages), wrappers such as `time`, `sudo` and `env`
 * are skipped, and `bash -c` / `sh -c` scripts are checked too. Returns undefined for everything else,
 * including plain grep on named files.
 * With shell 'powershell', backticks are escapes and PowerShell's own tree reads are checked instead
 * (see findPowerShellBroadRead).
 * Limits: Bash backtick command substitution is not inspected.
 */
export function findBroadReadCommand(command: string, depth = 0, shell: Shell = 'bash'): string | undefined {
  if (shell === 'powershell') {
    return findPowerShellBroadRead(command, depth);
  }
  for (const stage of splitShellStages(command, shell)) {
    const tokens = stripWrappers(stage);
    const name = tokens.length > 0 ? basename(tokens[0]) : undefined;
    const args = tokens.slice(1);
    if (!name) {
      continue;
    }
    if (SHELLS.has(name) && depth < 3) {
      const script = args[args.indexOf('-c') + 1];
      const nested = args.includes('-c') && script !== undefined ? findBroadReadCommand(script, depth + 1) : undefined;
      if (nested) {
        return nested;
      }
    }
    if ((name === 'grep' || name === 'egrep' || name === 'fgrep') && isRecursiveGrep(args)) {
      return 'recursive grep reads every file under its path, including secret files.';
    }
    if (name === 'rg' && searchesDirectory(args, RG_VALUE_FLAGS)) {
      return 'rg searches every file under a directory, including secret files.';
    }
    const gitArgs = name === 'git' ? skipGitGlobalOptions(args) : [];
    if (gitArgs[0] === 'grep' && searchesDirectory(gitArgs.slice(1), GIT_GREP_VALUE_FLAGS)) {
      return 'git grep searches every tracked file under a directory, including secret files.';
    }
    if (name === 'find' && args.some((token) => token === '-exec' || token === '-execdir' || token === '-ok' || token === '-okdir')) {
      return 'find -exec can run a reader on secret files.';
    }
    if (name === 'xargs' && args.some((token) => READER_COMMANDS.has(basename(token)))) {
      return 'xargs feeding a reader can read secret files.';
    }
  }
  return undefined;
}

export type Shell = 'bash' | 'powershell';

const POWERSHELLS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);
const PS_LISTERS = new Set(['get-childitem', 'gci', 'dir', 'ls']);
const PS_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'select-string', 'sls']);
/** Names isSecretPath blocks, used to ask whether a wildcard could match a secret file. */
const SECRET_NAME_SAMPLES = ['.env', '.env.local', '.npmrc', 'secret', 'secrets', 'secrets.yaml',
  'credentials', 'credentials.json', 'server.key', 'cert.pem', 'store.p12', 'store.pfx'];

/**
 * PowerShell reads that can reach secret files without naming them: a recursive Get-ChildItem anywhere in a
 * command that also runs a reader (Get-Content, Select-String and their aliases), unless its -Filter/-Include
 * cannot match a secret name; and a reader given a wildcard path that could match one, such as `*` or `*.json`.
 * Nested `pwsh -Command` and `-EncodedCommand` scripts are checked too.
 */
function findPowerShellBroadRead(command: string, depth: number): string | undefined {
  let recursiveListing = false;
  let reader = false;
  for (const stage of splitShellStages(command, 'powershell')) {
    const name = stage.length > 0 ? basename(stage[0]).toLowerCase() : undefined;
    const args = stage.slice(1);
    if (!name) {
      continue;
    }
    if (POWERSHELLS.has(name) && depth < 3) {
      const nested = nestedPowerShellScript(args);
      const found = nested === undefined ? undefined : findPowerShellBroadRead(nested, depth + 1);
      if (found) {
        return found;
      }
    }
    if (PS_LISTERS.has(name) && args.some(isRecurseParameter)) {
      const filter = parameterValue(args, ['-filter', '-include']);
      recursiveListing ||= filter === undefined || globCouldMatchSecret(filter);
    }
    if (PS_READERS.has(name)) {
      reader = true;
      if (readerWildcards(name, args).some(globCouldMatchSecret)) {
        return 'a wildcard path can match secret files.';
      }
    }
  }
  return recursiveListing && reader
    ? 'a recursive Get-ChildItem feeding a reader can read secret files.'
    : undefined;
}

/** -Recurse and its abbreviations (-r, -rec, ...), and -Depth, which implies recursion. */
function isRecurseParameter(token: string): boolean {
  const lower = token.toLowerCase();
  return (lower.length >= 2 && '-recurse'.startsWith(lower)) || lower === '-depth';
}

/** Value of the first matching parameter, in `-Name value` or `-Name:value` form. Names are lowercase. */
function parameterValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].toLowerCase().split(/:(.*)/s);
    if (names.includes(flag)) {
      return inline !== undefined && inline.length > 0 ? args[index].slice(flag.length + 1) : args[index + 1];
    }
  }
  return undefined;
}

/**
 * Path arguments of a reader that contain wildcards. For Select-String, the pattern (from -Pattern, or the first
 * positional argument when -Pattern is absent) is skipped, since a regex such as `a.*b` is not a path.
 */
function readerWildcards(name: string, args: readonly string[]): string[] {
  const positional: string[] = [];
  const paths: string[] = [];
  let patternGiven = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const [flag, inline] = token.toLowerCase().split(/:(.*)/s);
    const value = inline !== undefined && inline.length > 0 ? token.slice(flag.length + 1) : args[index + 1];
    if (inline === undefined || inline.length === 0) {
      index += 1;
    }
    if (flag === '-pattern') {
      patternGiven = true;
    } else if (flag === '-path' && value !== undefined) {
      paths.push(value);
    }
  }
  const isSelectString = name === 'select-string' || name === 'sls';
  paths.push(...(isSelectString && !patternGiven ? positional.slice(1) : positional));
  return paths.filter((path) => /[*?]/.test(path));
}

/** True when the last segment of a wildcard path could match a secret file name. */
function globCouldMatchSecret(path: string): boolean {
  const segment = path.replaceAll('\\', '/').split('/').at(-1) ?? path;
  const pattern = new RegExp(`^${segment.replace(/[.+^${}()|\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i');
  return SECRET_NAME_SAMPLES.some((name) => pattern.test(name));
}

/** The script given to a nested PowerShell with -Command / -c, or decoded from -EncodedCommand / -ec. */
function nestedPowerShellScript(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index].toLowerCase();
    if (flag.length >= 2 && ('-encodedcommand'.startsWith(flag) || flag === '-ec')) {
      const encoded = args[index + 1];
      return encoded === undefined ? undefined : Buffer.from(encoded, 'base64').toString('utf16le');
    }
    if (flag === '-c' || (flag.length >= 3 && '-command'.startsWith(flag))) {
      return args.slice(index + 1).join(' ');
    }
  }
  return undefined;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const WRAPPERS = new Set(['time', 'sudo', 'env', 'nohup', 'nice', 'command', 'exec', 'timeout', 'stdbuf']);
const RG_VALUE_FLAGS = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-M',
  '--regexp', '--file', '--glob', '--type', '--type-not', '--max-count', '--after-context',
  '--before-context', '--context', '--threads', '--max-columns']);
const GIT_GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--max-count', '--context',
  '--after-context', '--before-context', '--threads']);
/** grep short flags that take a value; anything after one in a cluster such as `-eRecursive` is that value. */
const GREP_VALUE_LETTERS = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D']);

/**
 * Splits a shell command into stages of words. Stages end at `;`, `&`, `|`, `(`, `)` and newlines outside
 * quotes, so `&&`, `||`, background jobs, pipes and subshells are all separate stages. Quotes group words and
 * are removed. Heredoc bodies are dropped, because they are data, not commands. In PowerShell the backtick
 * escapes the next character and a backslash is an ordinary path character.
 */
function splitShellStages(command: string, shell: Shell): string[][] {
  const stages: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  const pendingHeredocs: string[] = [];
  const lines = command.split('\n');

  const endWord = (): void => {
    if (inWord) {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endStage = (): void => {
    endWord();
    if (words.length > 0) {
      stages.push(words);
    }
    words = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (quote === undefined && pendingHeredocs.length > 0) {
      // Skip heredoc bodies up to each delimiter, in the order the heredocs were opened.
      if (line.trim() === pendingHeredocs[0]) {
        pendingHeredocs.shift();
      }
      continue;
    }
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      // Bash: a backslash escapes a quote or operator; other backslashes stay, for Windows paths.
      // PowerShell: a backtick escapes any character. Inside single quotes nothing is escaped.
      const escapes = shell === 'powershell'
        ? char === '`'
        : char === '\\' && next !== undefined && (quote === undefined ? /["'`;&|()\s\\]/ : /["`\\$]/).test(next);
      if (escapes && next !== undefined && quote !== "'") {
        word += next;
        inWord = true;
        index += 1;
        continue;
      }
      if (quote !== undefined) {
        if (char === quote) {
          quote = undefined;
        } else {
          word += char;
        }
        continue;
      }
      if (char === "'" || char === '"' || (char === '`' && shell === 'bash')) {
        quote = char;
        inWord = true;
      } else if (char === '<' && line[index + 1] === '<') {
        const match = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.slice(index));
        if (match) {
          pendingHeredocs.push(match[2]);
          index += match[0].length - 1;
          endWord();
        } else {
          endWord();
        }
      } else if (char === ';' || char === '&' || char === '|' || char === '(' || char === ')'
        || (shell === 'powershell' && (char === '{' || char === '}'))) {
        // PowerShell script blocks, as in `ForEach-Object { Get-Content $_ }`, hold their own commands.
        endStage();
      } else if (char === ' ' || char === '\t' || char === '\r') {
        endWord();
      } else {
        word += char;
        inWord = true;
      }
    }
    if (quote === undefined) {
      endStage();
    } else {
      word += '\n';
    }
  }
  endStage();
  return stages;
}

/** Drops leading `VAR=value` assignments and wrapper commands, and their own options, to reach the real command. */
function stripWrappers(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
    } else if (WRAPPERS.has(basename(token))) {
      index += 1;
      // Wrapper options, and timeout's duration, come before the wrapped command.
      while (index < tokens.length && (tokens[index].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(tokens[index]))) {
        index += 1;
      }
    } else {
      break;
    }
  }
  return tokens.slice(index);
}

/** git options that come before the subcommand, such as `-C dir`, `-c key=value` and `--no-pager`. */
function skipGitGlobalOptions(args: readonly string[]): string[] {
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    index += args[index] === '-C' || args[index] === '-c' ? 2 : 1;
  }
  return args.slice(index);
}

function basename(word: string): string {
  return word.replaceAll('\\', '/').split('/').at(-1) ?? word;
}

/**
 * True for `-r`, `-R`, `-rn`, `--recursive`, `--dereference-recursive`, `-d recurse` and `--directories=recurse`.
 * Values of pattern options (`-e -Error`, `-eRecursive`) and arguments after `--` are not flags.
 */
function isRecursiveGrep(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') {
      return false;
    }
    if (token === '--recursive' || token === '--dereference-recursive' || token === '--directories=recurse') {
      return true;
    }
    if (token === '--regexp' || token === '--file') {
      index += 1;
      continue;
    }
    if (!/^-[A-Za-z]/.test(token)) {
      continue;
    }
    for (let offset = 1; offset < token.length; offset += 1) {
      const letter = token[offset];
      if (letter === 'r' || letter === 'R') {
        return true;
      }
      if (GREP_VALUE_LETTERS.has(letter)) {
        const value = offset === token.length - 1 ? args[index + 1] : token.slice(offset + 1);
        if (letter === 'd' && value === 'recurse') {
          return true;
        }
        if (offset === token.length - 1) {
          index += 1;
        }
        break;
      }
    }
  }
  return false;
}

/**
 * For rg and git grep, which recurse by default: true unless every path argument names a file. The first
 * positional argument is the pattern unless one was given with -e or -f. A path counts as a file when its last
 * segment has an extension, so `.`, `src` and `.github` count as directories.
 */
function searchesDirectory(args: readonly string[], valueFlags: ReadonlySet<string>): boolean {
  const positional: string[] = [];
  let patternGiven = false;
  let afterDashes = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (afterDashes || !token.startsWith('-') || token === '-') {
      positional.push(token);
    } else if (token === '--') {
      afterDashes = true;
    } else if (valueFlags.has(token)) {
      patternGiven ||= token === '-e' || token === '-f' || token === '--regexp' || token === '--file';
      index += 1;
    }
  }
  const paths = patternGiven ? positional : positional.slice(1);
  return paths.length === 0 || paths.some((path) => !/[^/\\]\.[^/\\.]+$/.test(path));
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

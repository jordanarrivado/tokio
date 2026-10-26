import { posix } from 'node:path';

/**
 * Import resolution for Python, Go, and Rust. Like the rest of the repository map, this reads
 * import statements with patterns, not a parser, and maps them to repository files. Imports that do
 * not resolve to a repository file, such as the standard library or third-party packages, are dropped.
 */

const MAX_TARGETS_PER_FILE = 50;
const RUST_CRATE_ROOT_FILES = ['lib.rs', 'main.rs'] as const;
const RUST_MODULE_ENTRY_FILES = ['mod.rs', 'lib.rs', 'main.rs'] as const;

export const PY_FROM_IMPORT = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+?)\s*$/;
export const PY_IMPORT = /^\s*import\s+(.+?)\s*$/;
const GO_IMPORT_BLOCK = /^\s*import\s*\(([\s\S]*?)\)/gm;
const GO_SINGLE_IMPORT = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const RUST_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/;
const RUST_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|self|super)(?:::\w+)*)/;

export interface ImportIndex {
  known: ReadonlySet<string>;
  /** Go packages keyed by directory. Test files are excluded. */
  goPackages: ReadonlyMap<string, readonly string[]>;
  /** PSR-4 namespace prefixes (with a trailing backslash) and the directories they map to, longest prefix first. */
  phpNamespaces: readonly PhpNamespace[];
}

export interface PhpNamespace {
  prefix: string;
  directories: string[];
}

/** `use A\B\C;`, `use A\B\C as D;`, `use function A\b;`, and grouped `use A\B\{C, D as E};`. */
const PHP_USE = /^\s*use\s+(?:function\s+|const\s+)?([A-Za-z_\\][\w\\]*)(?:\s*\{([^}]*)\})?(?:\s+as\s+\w+)?\s*;/gm;
/** Laravel's default when composer.json is not scanned. */
const DEFAULT_PHP_NAMESPACES: readonly PhpNamespace[] = [{ prefix: 'App\\', directories: ['app'] }];

/**
 * PSR-4 prefixes from a composer.json, including autoload-dev. Without a readable file, Laravel's
 * App\ → app/ is assumed, because that covers most of a Laravel codebase.
 */
export function parseComposerNamespaces(composerJson: string | undefined, fallback = true): PhpNamespace[] {
  let parsed: unknown;
  try {
    parsed = composerJson === undefined ? undefined : JSON.parse(composerJson);
  } catch {
    parsed = undefined;
  }
  const namespaces: PhpNamespace[] = [];
  for (const section of ['autoload', 'autoload-dev']) {
    const psr4 = (parsed as Record<string, Record<string, unknown> | undefined> | undefined)?.[section]?.['psr-4'];
    if (typeof psr4 !== 'object' || psr4 === null) {
      continue;
    }
    for (const [prefix, value] of Object.entries(psr4 as Record<string, unknown>)) {
      const directories = (Array.isArray(value) ? value : [value])
        .filter((directory): directory is string => typeof directory === 'string')
        .map((directory) => directory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, ''));
      if (prefix && directories.length > 0) {
        namespaces.push({ prefix: prefix.endsWith('\\') ? prefix : `${prefix}\\`, directories });
      }
    }
  }
  const result = namespaces.length > 0 || !fallback ? namespaces : DEFAULT_PHP_NAMESPACES.map((namespace) => ({ ...namespace }));
  return result.sort((left, right) => right.prefix.length - left.prefix.length);
}

/** Fully qualified class names a PHP file imports with `use`, with leading backslashes removed. */
export function phpUseNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(PHP_USE)) {
    const base = match[1].replace(/^\\+/, '');
    if (match[2] === undefined) {
      names.push(base);
      continue;
    }
    // Grouped: `use App\Models\{User, Role as R};`
    const prefix = base.endsWith('\\') ? base : `${base}\\`;
    for (const part of match[2].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_][\w\\]*$/.test(name)) {
        names.push(prefix + name);
      }
    }
  }
  return names;
}

/** The file a fully qualified PHP class name lives in under PSR-4, when it is one of the known files. */
export function resolvePhpClass(name: string, namespaces: readonly PhpNamespace[], known: ReadonlySet<string>): string | undefined {
  for (const namespace of namespaces) {
    if (!name.startsWith(namespace.prefix)) {
      continue;
    }
    const rest = name.slice(namespace.prefix.length).replaceAll('\\', '/');
    for (const directory of namespace.directories) {
      const candidate = directory ? `${directory}/${rest}.php` : `${rest}.php`;
      if (known.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function createImportIndex(paths: readonly string[], composerJson?: string): ImportIndex {
  const goPackages = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.endsWith('.go') || path.endsWith('_test.go')) {
      continue;
    }
    const directory = posix.dirname(path);
    if (directory !== '.') {
      goPackages.set(directory, [...(goPackages.get(directory) ?? []), path]);
    }
  }
  return { known: new Set(paths), goPackages, phpNamespaces: parseComposerNamespaces(composerJson) };
}

/** Repository files that a Python, Go, Rust, or PHP file imports. JavaScript and TypeScript are resolved elsewhere. */
export function resolveLanguageImports(path: string, content: string, index: ImportIndex): string[] {
  let targets: string[];
  switch (posix.extname(path)) {
    case '.py':
      targets = pythonImports(path, content, index.known);
      break;
    case '.go':
      targets = goImports(content, index.goPackages);
      break;
    case '.rs':
      targets = rustImports(path, content, index.known);
      break;
    case '.php':
      targets = phpUseNames(content)
        .map((name) => resolvePhpClass(name, index.phpNamespaces, index.known))
        .filter((target): target is string => target !== undefined);
      break;
    default:
      return [];
  }
  return [...new Set(targets)]
    .filter((target) => target !== path && index.known.has(target))
    .slice(0, MAX_TARGETS_PER_FILE);
}

function pythonImports(path: string, content: string, known: ReadonlySet<string>): string[] {
  const directory = posix.dirname(path);
  const targets: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const fromImport = PY_FROM_IMPORT.exec(line);
    if (fromImport) {
      // Absolute imports start at the repository root. One leading dot is the current package, and
      // each further dot climbs one directory.
      const [, dots, module, names] = fromImport;
      const base = dots.length === 0
        ? '.'
        : posix.join(directory, ...Array<string>(dots.length - 1).fill('..'));
      const moduleBase = posix.join(base, module.replaceAll('.', '/'));
      if (module) {
        pushDefined(targets, pythonModuleFile(moduleBase, known));
      }
      // `from pkg import submodule` can name a module file rather than a symbol.
      for (const name of pythonNames(names)) {
        pushDefined(targets, pythonModuleFile(posix.join(moduleBase, name), known));
      }
      continue;
    }

    const plainImport = PY_IMPORT.exec(line);
    if (plainImport) {
      for (const item of plainImport[1].split(',')) {
        const module = item.trim().split(/\s+as\s+/)[0];
        if (/^[\w.]+$/.test(module)) {
          pushDefined(targets, pythonModuleFile(module.replaceAll('.', '/'), known));
        }
      }
    }
  }
  return targets;
}

export function pythonModuleFile(base: string, known: ReadonlySet<string>): string | undefined {
  return [`${base}.py`, posix.join(base, '__init__.py')].find((candidate) => known.has(candidate));
}

export function pythonNames(names: string): string[] {
  return names
    .replace(/[()]/g, '')
    .split(',')
    .map((item) => item.trim().split(/\s+as\s+/)[0])
    .filter((name) => /^\w+$/.test(name));
}

/** Import paths from Go import blocks and single-line imports. */
export function goImportPaths(content: string): string[] {
  const specs: string[] = [];
  for (const block of content.matchAll(GO_IMPORT_BLOCK)) {
    for (const spec of block[1].matchAll(/"([^"]+)"/g)) {
      specs.push(spec[1]);
    }
  }
  for (const single of content.matchAll(GO_SINGLE_IMPORT)) {
    specs.push(single[1]);
  }
  return specs;
}

function goImports(content: string, packages: ReadonlyMap<string, readonly string[]>): string[] {
  const targets: string[] = [];
  for (const spec of goImportPaths(content)) {
    // Module-qualified import paths end with the package directory. Take the most specific match.
    let best: string | undefined;
    for (const directory of packages.keys()) {
      const matches = spec === directory || spec.endsWith(`/${directory}`);
      if (matches && (best === undefined || directory.length > best.length)) {
        best = directory;
      }
    }
    if (best !== undefined) {
      targets.push(...(packages.get(best) ?? []));
    }
  }
  return targets;
}

function rustImports(path: string, content: string, known: ReadonlySet<string>): string[] {
  const name = posix.basename(path);
  const directory = posix.dirname(path);
  // mod.rs, lib.rs, and main.rs own their directory. Any other file owns a directory named after itself.
  const moduleDirectory = (RUST_MODULE_ENTRY_FILES as readonly string[]).includes(name)
    ? directory
    : posix.join(directory, posix.basename(path, '.rs'));
  const crateRoot = findRustCrateRoot(path, known);
  const targets: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const mod = RUST_MOD.exec(line);
    if (mod) {
      pushDefined(targets, rustModuleFile(posix.join(moduleDirectory, mod[1]), known));
      continue;
    }

    const use = RUST_USE.exec(line);
    if (!use) {
      continue;
    }
    const segments = use[1].split('::');
    let base: string | undefined;
    let index = 0;
    if (segments[0] === 'crate') {
      base = crateRoot;
      index = 1;
    } else {
      base = moduleDirectory;
      if (segments[0] === 'self') {
        index = 1;
      }
      while (segments[index] === 'super') {
        base = posix.dirname(base);
        index += 1;
      }
    }
    if (base === undefined) {
      continue;
    }

    // The last segment is often an item rather than a module, so try the longest module path first.
    const modulePath = segments.slice(index);
    for (let length = modulePath.length; length >= 1; length -= 1) {
      const found = rustModuleFile(posix.join(base, ...modulePath.slice(0, length)), known);
      if (found) {
        targets.push(found);
        break;
      }
    }
  }
  return targets;
}

function rustModuleFile(base: string, known: ReadonlySet<string>): string | undefined {
  return [`${base}.rs`, posix.join(base, 'mod.rs')].find((candidate) => known.has(candidate));
}

/** The nearest ancestor directory holding lib.rs or main.rs. Works for workspaces with several crates. */
function findRustCrateRoot(path: string, known: ReadonlySet<string>): string | undefined {
  let directory = posix.dirname(path);
  for (;;) {
    if (RUST_CRATE_ROOT_FILES.some((file) => known.has(posix.join(directory, file)))) {
      return directory;
    }
    if (directory === '.') {
      return undefined;
    }
    directory = posix.dirname(directory);
  }
}

function pushDefined(targets: string[], value: string | undefined): void {
  if (value !== undefined) {
    targets.push(value);
  }
}

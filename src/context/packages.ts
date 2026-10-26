import { posix } from 'node:path';
import {
  goImportPaths,
  parseComposerNamespaces,
  phpUseNames,
  PY_FROM_IMPORT,
  PY_IMPORT,
  pythonModuleFile,
  pythonNames,
  resolvePhpClass,
  type PhpNamespace
} from './imports';
import { extractSymbols, resolveRelativeImport, symbolName, type RepoFile } from './repomap';

/**
 * Links imports between catalog repositories. A repository publishes a package under its package.json
 * `name`, its go.mod module path, or its top-level Python packages. An import of that package in another
 * repository links to the files that define the imported names, or to the module or package entry when
 * no defining file is found. Like imports.ts, this reads import statements with patterns: a link is a
 * ranking hint, not a build graph.
 */

export interface PackageRepo {
  name: string;
  /** Paths relative to the repository root. */
  files: readonly RepoFile[];
  /** The go.mod module path, passed in because the scan does not read .mod files. */
  goModule?: string;
}

const MAX_LINKS_PER_FILE = 20;
const SCRIPT_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
/** `import`/`export ... from 'x'` (group 1 is the clause, group 2 the specifier), or `import 'x'`, `import('x')`, `require('x')`. */
const SCRIPT_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|\b(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
const PYTHON_PACKAGE_INIT = /^(?:src\/)?([A-Za-z_]\w*)\/__init__\.py$/;
/** Test packages share names across repositories, so they never count as published. */
const UNPUBLISHED_PYTHON = new Set(['test', 'tests']);

interface Published {
  name: string;
  files: readonly RepoFile[];
  known: ReadonlySet<string>;
  npmName?: string;
  npmEntries: string[];
  goModule?: string;
  /** Top-level package name → its directory, `pkg` or `src/pkg`. */
  pythonPackages: Map<string, string>;
  /** PSR-4 namespaces from the repository's own composer.json; none without one. */
  phpNamespaces: PhpNamespace[];
  definitions?: Map<string, string[]>;
}

/** Links keyed by `<repo>/<path>`, each pointing at `<repo>/<path>` files in other repositories. */
export function linkPackageImports(repos: readonly PackageRepo[]): Map<string, string[]> {
  const published = repos.map(describe);
  const links = new Map<string, string[]>();
  for (const from of published) {
    const others = published.filter((other) => other.name !== from.name);
    for (const file of from.files) {
      const targets = [...new Set(linksFrom(file, others, from))].slice(0, MAX_LINKS_PER_FILE);
      if (targets.length > 0) {
        links.set(`${from.name}/${file.path}`, targets);
      }
    }
  }
  return links;
}

function linksFrom(file: RepoFile, others: readonly Published[], own: Published): string[] {
  if (others.length === 0) {
    return [];
  }
  if (file.path.endsWith('.php')) {
    return phpLinks(file.content, others, own);
  }
  if (SCRIPT_FILE.test(file.path)) {
    return scriptLinks(file.content, others);
  }
  if (file.path.endsWith('.go')) {
    return goLinks(file.content, others);
  }
  if (file.path.endsWith('.py')) {
    return pythonLinks(file.content, others);
  }
  return [];
}

function scriptLinks(content: string, others: readonly Published[]): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(SCRIPT_IMPORT)) {
    const specifier = match[2] ?? match[3];
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      continue;
    }
    const names = match[1] === undefined ? [] : importedNames(match[1]);
    for (const target of others) {
      const subpath = packageSubpath(specifier, target.npmName);
      if (subpath === undefined) {
        continue;
      }
      const defining = names.flatMap((name) => definitionsOf(target).get(name) ?? []);
      const entry = defining.length > 0 ? [] : [scriptEntry(target, subpath)];
      links.push(...[...defining, ...entry]
        .filter((path): path is string => path !== undefined)
        .map((path) => `${target.name}/${path}`));
    }
  }
  return links;
}

function goLinks(content: string, others: readonly Published[]): string[] {
  const links: string[] = [];
  for (const spec of goImportPaths(content)) {
    for (const target of others) {
      const subpath = packageSubpath(spec, target.goModule);
      if (subpath === undefined) {
        continue;
      }
      const directory = subpath === '' ? '.' : subpath;
      links.push(...target.files
        .filter((file) => file.path.endsWith('.go') && !file.path.endsWith('_test.go') && posix.dirname(file.path) === directory)
        .map((file) => `${target.name}/${file.path}`));
    }
  }
  return links;
}

function pythonLinks(content: string, others: readonly Published[]): string[] {
  const imports: { module: string; names: string[] }[] = [];
  for (const line of content.split(/\r?\n/)) {
    const fromImport = PY_FROM_IMPORT.exec(line);
    if (fromImport) {
      // Relative imports stay inside their own repository.
      if (fromImport[1] === '' && fromImport[2] !== '') {
        imports.push({ module: fromImport[2], names: pythonNames(fromImport[3]) });
      }
      continue;
    }
    const plainImport = PY_IMPORT.exec(line);
    if (plainImport) {
      for (const item of plainImport[1].split(',')) {
        const module = item.trim().split(/\s+as\s+/)[0];
        if (/^[\w.]+$/.test(module)) {
          imports.push({ module, names: [] });
        }
      }
    }
  }

  const links: string[] = [];
  for (const { module, names } of imports) {
    const top = module.split('.')[0];
    for (const target of others) {
      const directory = target.pythonPackages.get(top);
      if (directory === undefined) {
        continue;
      }
      const base = posix.join(posix.dirname(directory), module.replaceAll('.', '/'));
      const files = [base, ...names.map((name) => posix.join(base, name))]
        .map((candidate) => pythonModuleFile(candidate, target.known));
      links.push(...files
        .filter((path): path is string => path !== undefined)
        .map((path) => `${target.name}/${path}`));
    }
  }
  return links;
}

/**
 * PHP `use` names that resolve under another repository's composer PSR-4 map. A namespace the importing
 * repository declares itself stays local, so two Laravel apps that both declare `App\` never cross-link.
 */
function phpLinks(content: string, others: readonly Published[], own: Published): string[] {
  const links: string[] = [];
  for (const name of phpUseNames(content)) {
    if (own.phpNamespaces.some((namespace) => name.startsWith(namespace.prefix))) {
      continue;
    }
    for (const target of others) {
      const resolved = resolvePhpClass(name, target.phpNamespaces, target.known);
      if (resolved) {
        links.push(`${target.name}/${resolved}`);
      }
    }
  }
  return links;
}

function describe(repo: PackageRepo): Published {
  const known = new Set(repo.files.map((file) => file.path));
  const manifest = parsePackageJson(repo.files.find((file) => file.path === 'package.json')?.content);
  const pythonPackages = new Map<string, string>();
  for (const path of known) {
    const match = PYTHON_PACKAGE_INIT.exec(path);
    if (match && !UNPUBLISHED_PYTHON.has(match[1]) && !pythonPackages.has(match[1])) {
      pythonPackages.set(match[1], posix.dirname(path));
    }
  }
  return {
    name: repo.name,
    files: repo.files,
    known,
    ...(manifest.name ? { npmName: manifest.name } : {}),
    npmEntries: manifest.entries,
    ...(repo.goModule ? { goModule: repo.goModule } : {}),
    pythonPackages,
    // No fallback: only a repository's own composer.json says which namespaces it publishes.
    phpNamespaces: parseComposerNamespaces(repo.files.find((file) => file.path === 'composer.json')?.content, false)
  };
}

function parsePackageJson(text: string | undefined): { name?: string; entries: string[] } {
  if (text === undefined) {
    return { entries: [] };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return { entries: [] };
    }
    const fields = parsed as Record<string, unknown>;
    const entries = ['types', 'main', 'module']
      .map((key) => fields[key])
      .filter((value): value is string => typeof value === 'string');
    return { ...(typeof fields.name === 'string' ? { name: fields.name } : {}), entries };
  } catch {
    return { entries: [] };
  }
}

/** '' for the package itself, the rest for a subpath, undefined when the specifier names another package. */
function packageSubpath(specifier: string, packageName: string | undefined): string | undefined {
  if (!packageName) {
    return undefined;
  }
  if (specifier === packageName) {
    return '';
  }
  return specifier.startsWith(`${packageName}/`) ? specifier.slice(packageName.length + 1) : undefined;
}

/** Names inside the braces of an import or export clause, without `type` and `as` aliases. */
function importedNames(clause: string): string[] {
  const braces = /\{([^}]*)\}/.exec(clause);
  if (!braces) {
    return [];
  }
  return braces[1]
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/** The file a package import or subpath import resolves to: package.json entries, then index files. */
function scriptEntry(target: Published, subpath: string): string | undefined {
  const bases = subpath === '' ? [...target.npmEntries, 'index', 'src/index'] : [subpath, `src/${subpath}`];
  for (const base of bases) {
    // An empty fromPath resolves the specifier from the repository root.
    const resolved = resolveRelativeImport('', `./${base}`, target.known);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function definitionsOf(target: Published): Map<string, string[]> {
  if (!target.definitions) {
    const definitions = new Map<string, string[]>();
    for (const file of target.files) {
      for (const symbol of extractSymbols(file.content, file.path)) {
        const name = symbolName(symbol.signature);
        if (name && !(definitions.get(name) ?? []).includes(file.path)) {
          definitions.set(name, [...(definitions.get(name) ?? []), file.path]);
        }
      }
    }
    target.definitions = definitions;
  }
  return target.definitions;
}

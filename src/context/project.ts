/**
 * Pure detection of project conventions and real validation commands from file names and
 * manifest text. Workspace access lives in workspace.ts so these stay unit-testable.
 */

const CONVENTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.github/copilot-instructions.md'
] as const;

const MAX_COMMANDS = 3;

export function detectConventionFiles(rootPaths: ReadonlySet<string>): string[] {
  return CONVENTION_FILES.filter((file) => rootPaths.has(file));
}

export function detectValidationCommands(input: {
  packageJson?: string;
  rootPaths: ReadonlySet<string>;
}): string[] {
  const { packageJson, rootPaths } = input;

  if (packageJson !== undefined) {
    const scripts = parseScripts(packageJson);
    if (scripts) {
      const runner = rootPaths.has('pnpm-lock.yaml') ? 'pnpm'
        : rootPaths.has('yarn.lock') ? 'yarn'
          : 'npm';
      const commands: string[] = [];
      if (scripts.has('verify')) {
        commands.push(`${runner} run verify`);
      } else {
        for (const name of ['check', 'typecheck', 'lint']) {
          if (scripts.has(name)) {
            commands.push(`${runner} run ${name}`);
          }
        }
        if (scripts.has('test')) {
          commands.push(runner === 'npm' ? 'npm test' : `${runner} test`);
        }
      }
      if (commands.length > 0) {
        return commands.slice(0, MAX_COMMANDS);
      }
    }
  }

  if (rootPaths.has('Cargo.toml')) {
    return ['cargo test'];
  }
  if (rootPaths.has('go.mod')) {
    return ['go test ./...'];
  }
  if (rootPaths.has('pyproject.toml') || rootPaths.has('pytest.ini') || rootPaths.has('setup.py')) {
    return ['pytest'];
  }
  return [];
}

function parseScripts(packageJson: string): Set<string> | undefined {
  try {
    const parsed: unknown = JSON.parse(packageJson);
    if (typeof parsed === 'object' && parsed !== null && 'scripts' in parsed) {
      const scripts = (parsed as { scripts: unknown }).scripts;
      if (typeof scripts === 'object' && scripts !== null) {
        return new Set(Object.keys(scripts));
      }
    }
  } catch {
    // Malformed manifest: fall back to other ecosystems.
  }
  return undefined;
}

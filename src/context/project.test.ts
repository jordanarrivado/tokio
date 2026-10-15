import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { detectConventionFiles, detectValidationCommands } from './project';

const paths = (...values: string[]) => new Set(values);

test('detects the Laravel test command only when artisan and composer.json both exist', () => {
  assert.deepEqual(detectValidationCommands({ rootPaths: paths('artisan', 'composer.json') }), ['php artisan test']);
  assert.deepEqual(detectValidationCommands({ rootPaths: paths('composer.json') }), []);
});

test('detects agent convention files at the repository root', () => {
  assert.deepEqual(
    detectConventionFiles(paths('README.md', 'AGENTS.md', 'CLAUDE.md')),
    ['CLAUDE.md', 'AGENTS.md']
  );
  assert.deepEqual(detectConventionFiles(paths('README.md')), []);
});

test('prefers a verify script and respects the package manager', () => {
  const packageJson = JSON.stringify({ scripts: { verify: 'x', test: 'y', lint: 'z' } });

  assert.deepEqual(detectValidationCommands({ packageJson, rootPaths: paths('package.json') }), ['npm run verify']);
  assert.deepEqual(
    detectValidationCommands({ packageJson, rootPaths: paths('package.json', 'pnpm-lock.yaml') }),
    ['pnpm run verify']
  );
});

test('combines check, lint, and test scripts when there is no verify script', () => {
  const packageJson = JSON.stringify({ scripts: { test: 'a', check: 'b', lint: 'c', build: 'd' } });

  assert.deepEqual(
    detectValidationCommands({ packageJson, rootPaths: paths('package.json') }),
    ['npm run check', 'npm run lint', 'npm test']
  );
});

test('falls back to other ecosystems and tolerates malformed manifests', () => {
  assert.deepEqual(detectValidationCommands({ rootPaths: paths('Cargo.toml') }), ['cargo test']);
  assert.deepEqual(detectValidationCommands({ rootPaths: paths('go.mod') }), ['go test ./...']);
  assert.deepEqual(detectValidationCommands({ rootPaths: paths('pyproject.toml') }), ['pytest']);
  assert.deepEqual(detectValidationCommands({ packageJson: '{not json', rootPaths: paths('package.json') }), []);
});

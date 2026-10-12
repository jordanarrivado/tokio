import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('tsconfig declares the node and vscode type packages used by the extension host code', () => {
  const config = JSON.parse(readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { types?: string[] };
  };

  assert.ok(config.compilerOptions.types?.includes('node'));
  assert.ok(config.compilerOptions.types?.includes('vscode'));
});

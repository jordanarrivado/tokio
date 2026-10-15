import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { estimateTokens } from '../core/tokens';
import { buildRepoMap, extractSymbols, resolveRelativeImport, type RepoFile } from './repomap';

const files: RepoFile[] = [
  {
    path: 'src/auth/login.ts',
    content: "import { SessionStore } from '../session/store';\n\nexport function redirectAfterLogin(user: string) {\n  return new SessionStore().start(user);\n}\n"
  },
  {
    path: 'src/session/store.ts',
    content: 'export class SessionStore {\n  start(user: string) {\n    return user;\n  }\n}\n'
  },
  {
    path: 'src/billing/invoice.ts',
    content: Array.from({ length: 40 }, (_, index) => `export function invoiceLine${index}() {}`).join('\n')
  },
  {
    path: 'src/util/format.ts',
    content: 'export const PAD = 2;\nexport const formatName = (name: string) => name.trim();\n'
  }
];

test('extracts top-level signatures with line numbers and skips plain constants', () => {
  const symbols = extractSymbols(files[3].content, files[3].path);
  assert.deepEqual(symbols, [{ line: 2, signature: 'export const formatName = (name: string) => name.trim();' }]);

  const python = extractSymbols('import os\n\ndef load(path):\n    pass\n\nclass Cache:\n    pass\n', 'app/io.py');
  assert.deepEqual(python.map((symbol) => symbol.line), [3, 6]);

  const go = extractSymbols('package main\n\nfunc (s *Server) Start() error {\n}\n', 'cmd/server.go');
  assert.equal(go[0].line, 3);
});

test('resolves relative imports including .js-to-.ts and index files', () => {
  const known = new Set(['src/session/store.ts', 'src/ui/index.tsx', 'src/core/a.ts']);
  assert.equal(resolveRelativeImport('src/auth/login.ts', '../session/store', known), 'src/session/store.ts');
  assert.equal(resolveRelativeImport('src/auth/login.ts', '../session/store.js', known), 'src/session/store.ts');
  assert.equal(resolveRelativeImport('src/app.ts', './ui', known), 'src/ui/index.tsx');
  assert.equal(resolveRelativeImport('src/app.ts', './missing', known), undefined);
});

test('ranks the target and its direct dependencies above unrelated files', () => {
  const map = buildRepoMap(files, {
    task: 'fix the redirect after login',
    targetPath: 'src/auth/login.ts',
    budgetTokens: 2000
  });

  assert.deepEqual(map.files.slice(0, 2), ['src/auth/login.ts', 'src/session/store.ts']);
  assert.ok(map.text.includes('src/auth/login.ts\n  3: export function redirectAfterLogin'));
  assert.equal(map.omittedFiles, 0);
});

test('stays within the token budget and reports omitted files', () => {
  const map = buildRepoMap(files, {
    task: 'fix the redirect after login',
    targetPath: 'src/auth/login.ts',
    budgetTokens: 60
  });

  assert.ok(estimateTokens(map.text) <= 60);
  assert.equal(map.tokens, estimateTokens(map.text));
  assert.ok(map.omittedFiles > 0);
  assert.ok(map.files.includes('src/auth/login.ts'));
});

test('collapses long symbol lists and still produces a map with no task terms', () => {
  const map = buildRepoMap(files, { task: 'zzz', budgetTokens: 4000, maxSymbolsPerFile: 3 });
  assert.ok(map.text.includes('... 37 more'));
  assert.ok(map.files.length > 0);
});

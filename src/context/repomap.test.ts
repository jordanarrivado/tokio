import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { estimateTokens } from '../core/tokens';
import { buildRepoMap, extractSymbols, maskJsComments, resolveRelativeImport, type RepoFile } from './repomap';

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

test('ignores declarations inside block comments, line comments, strings and template literals', () => {
  const source = [
    'export function real(a: number) {',
    '  return a;',
    '}',
    '/*',
    'export function inBlockComment() {',
    '*/',
    'const template = `',
    'function inTemplate() {',
    '`;',
    "const text = 'export function inString() {';",
    '// export function inLineComment() {',
    'export const handler = (x) => {',
    '  return x;',
    '};'
  ].join('\n');
  const symbols = extractSymbols(source, 'src/a.ts');
  assert.deepEqual(symbols, [
    { line: 1, signature: 'export function real(a: number)' },
    { line: 12, signature: 'export const handler = (x) =>' }
  ]);
});

test('keeps columns aligned when masking comments and strings', () => {
  const masked = maskJsComments("const a = 'x'; /* y */ const b = `z`;\nfunction c() {}");
  assert.equal(masked.length, 2);
  assert.equal(masked[0].length, "const a = 'x'; /* y */ const b = `z`;".length);
  assert.ok(!/[xyz]/.test(masked[0]), 'string and template contents are blanked');
  assert.ok(!masked[0].includes('/*'), 'comment markers are blanked');
  assert.ok(masked[0].includes('const b ='));
  assert.equal(masked[1], 'function c() {}');
});

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

test('ranks Python modules imported by a task-relevant file above unrelated files', () => {
  const python: RepoFile[] = [
    { path: 'app/billing/invoice.py', content: 'from app.ledger import tax\n\ndef invoice_total(items):\n    return tax.apply(items)\n' },
    { path: 'app/ledger/tax.py', content: 'def apply(items):\n    return items\n' },
    { path: 'app/misc/notes.py', content: 'def remember(text):\n    return text\n' }
  ];
  const map = buildRepoMap(python, { task: 'fix the invoice total', budgetTokens: 4000 });
  assert.ok(map.files.indexOf('app/ledger/tax.py') < map.files.indexOf('app/misc/notes.py'));
});

test('ranks files that co-change with a relevant file above unrelated files', () => {
  const coupled: RepoFile[] = [
    { path: 'src/billing/invoice.ts', content: 'export function invoiceTotal() {}\n' },
    { path: 'src/ledger/entries.ts', content: 'export function postEntry() {}\n' },
    { path: 'src/misc/notes.ts', content: 'export function remember() {}\n' }
  ];
  const coChange = new Map([
    ['src/billing/invoice.ts', ['src/ledger/entries.ts']],
    ['src/ledger/entries.ts', ['src/billing/invoice.ts']]
  ]);
  const map = buildRepoMap(coupled, { task: 'fix the invoice total', budgetTokens: 4000, coChange });
  assert.ok(map.files.indexOf('src/ledger/entries.ts') < map.files.indexOf('src/misc/notes.ts'));

  // Partners that are not scanned files are ignored rather than added to the map.
  const withGhost = buildRepoMap(coupled, {
    task: 'fix the invoice total',
    budgetTokens: 4000,
    coChange: new Map([['src/billing/invoice.ts', ['deleted/old.ts']]])
  });
  assert.equal(withGhost.files.includes('deleted/old.ts'), false);
});

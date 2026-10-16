import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createImportIndex, resolveLanguageImports } from './imports';

test('resolves Python relative and absolute imports to modules and package files', () => {
  const index = createImportIndex([
    'app/billing/invoice.py',
    'app/billing/__init__.py',
    'app/billing/tax.py',
    'app/util/money.py',
    'app/main.py'
  ]);

  const invoice = [
    'import os',
    'from . import tax',
    'from ..util.money import round_cents',
    'import app.billing.tax as t',
    ''
  ].join('\n');
  assert.deepEqual(
    resolveLanguageImports('app/billing/invoice.py', invoice, index).sort(),
    ['app/billing/tax.py', 'app/util/money.py']
  );

  // The package file and the named submodule are both imported.
  const main = resolveLanguageImports('app/main.py', 'from app.billing import invoice\n', index).sort();
  assert.deepEqual(main, ['app/billing/__init__.py', 'app/billing/invoice.py']);
});

test('resolves Python submodule names in from-imports to module files', () => {
  const index = createImportIndex(['app/billing/invoice.py', 'app/billing/tax.py', 'app/main.py']);
  const targets = resolveLanguageImports('app/main.py', 'from app.billing import invoice, tax as rates\n', index);
  assert.deepEqual(targets.sort(), ['app/billing/invoice.py', 'app/billing/tax.py']);
});

test('resolves Go imports to package directories and ignores stdlib and test files', () => {
  const index = createImportIndex([
    'internal/billing/invoice.go',
    'internal/billing/invoice_test.go',
    'internal/billing/tax.go',
    'cmd/server/main.go',
    'internal/util/money.go'
  ]);
  const main = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '',
    '\tbilling "github.com/acme/app/internal/billing"',
    ')',
    ''
  ].join('\n');
  assert.deepEqual(
    resolveLanguageImports('cmd/server/main.go', main, index).sort(),
    ['internal/billing/invoice.go', 'internal/billing/tax.go']
  );

  const single = 'package main\n\nimport "github.com/acme/app/internal/util"\n';
  assert.deepEqual(resolveLanguageImports('cmd/server/main.go', single, index), ['internal/util/money.go']);
});

test('resolves Rust mod declarations, crate paths, and super paths', () => {
  const index = createImportIndex([
    'src/lib.rs',
    'src/billing/mod.rs',
    'src/billing/invoice.rs',
    'src/billing/tax.rs',
    'src/billing/invoice/helpers.rs',
    'src/util.rs',
    'src/api.rs'
  ]);

  assert.deepEqual(
    resolveLanguageImports('src/lib.rs', 'pub mod billing;\nuse crate::util::round;\nuse std::fmt;\n', index).sort(),
    ['src/billing/mod.rs', 'src/util.rs']
  );

  const invoice = 'use super::tax::rate;\nuse crate::api::{Client};\nmod helpers;\n';
  assert.deepEqual(
    resolveLanguageImports('src/billing/invoice.rs', invoice, index).sort(),
    ['src/api.rs', 'src/billing/invoice/helpers.rs', 'src/billing/tax.rs']
  );
});

test('ignores files without a language rule and never returns the file itself', () => {
  const index = createImportIndex(['src/app.ts', 'src/notes.txt']);
  assert.deepEqual(resolveLanguageImports('src/app.ts', "import x from './app';", index), []);
  assert.deepEqual(resolveLanguageImports('src/notes.txt', 'from . import notes', index), []);
});

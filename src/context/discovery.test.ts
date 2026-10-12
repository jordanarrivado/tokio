import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  countTermHits,
  extractPathReferences,
  extractRelativeImports,
  extractSearchTerms,
  findRelatedTests,
  isSafeTextPath,
  isTestPath,
  rankContextPaths,
  resolveMentionedPaths
} from './discovery';

test('extracts bounded meaningful task terms', () => {
  const terms = extractSearchTerms('Please fix invoice retry behavior in the payment webhook and invoice service.');

  assert.deepEqual(terms, ['invoice', 'retry', 'behavior', 'payment', 'webhook', 'service']);
});

test('excludes common secret and non-text paths', () => {
  assert.equal(isSafeTextPath('src/payment.ts'), true);
  assert.equal(isSafeTextPath('docs/architecture.md'), true);
  assert.equal(isSafeTextPath('.env'), false);
  assert.equal(isSafeTextPath('config/credentials.json'), false);
  assert.equal(isSafeTextPath('certs/private.pem'), false);
  assert.equal(isSafeTextPath('assets/logo.png'), false);
});

test('extracts only relative imports with a hard limit', () => {
  const source = [
    "import { invoice } from './invoice';",
    "const db = require('../db/client');",
    "import('external-package');",
    "export { retry } from './retry.js';"
  ].join('\n');

  assert.deepEqual(extractRelativeImports(source), ['./invoice', '../db/client', './retry.js']);
});

test('ranks the explicit target, direct imports, and task-matching paths', () => {
  const ranked = rankContextPaths([
    'src/webhooks/payment.ts',
    'src/services/invoice.ts',
    'src/db/client.ts',
    'src/unrelated/profile.ts',
    '.env',
    'assets/payment.png'
  ], 'Fix invoice creation when the payment webhook retries.', 'src/webhooks/payment.ts', [
    '../services/invoice',
    '../db/client.ts'
  ]);

  assert.equal(ranked[0], 'src/webhooks/payment.ts');
  assert.ok(ranked.includes('src/services/invoice.ts'));
  assert.ok(ranked.includes('src/db/client.ts'));
  assert.ok(!ranked.includes('.env'));
});

test('suppresses weak audit matches and limits related suggestions', () => {
  const ranked = rankContextPaths([
    'pages/setup/employee-schedules/index.vue',
    'components/EmployeeSelectModal.vue',
    'components/modals/audits/ess/ESSItemViewsAuditModal.vue',
    'components/modals/audits/ess/ESSModuleViewsAuditModal.vue',
    'components/modals/audits/ItemViewsAuditModal.vue',
    'components/EmployeeList.vue',
    'components/EmployeeRow.vue',
    'components/EmployeeCard.vue'
  ], 'Selected employees should display directly in the list and eliminate the need to open a modal.',
  'pages/setup/employee-schedules/index.vue');

  assert.equal(ranked[0], 'pages/setup/employee-schedules/index.vue');
  assert.ok(ranked.includes('components/EmployeeSelectModal.vue'));
  assert.ok(ranked.length <= 4);
  assert.ok(ranked.every((path) => !/audit/i.test(path)));
});

test('keeps an audit path when directly imported by the target', () => {
  const ranked = rankContextPaths([
    'pages/audit.ts',
    'components/modals/audits/ItemViewsAuditModal.vue'
  ], 'Change the displayed item details.', 'pages/audit.ts', ['./ItemViewsAuditModal.vue']);

  assert.ok(ranked.includes('components/modals/audits/ItemViewsAuditModal.vue'));
});

test('counts distinct task terms present in file content', () => {
  const content = 'export function retryInvoice() { /* Webhook handler */ }';

  assert.equal(countTermHits(content, ['retry', 'webhook', 'payment']), 2);
  assert.equal(countTermHits('', ['retry']), 0);
});

test('content matches surface files whose names do not match the task', () => {
  const paths = ['src/jobs/worker.ts', 'src/ui/profile.ts', 'src/ui/layout.ts'];
  const prompt = 'Fix invoice retry behavior in the payment webhook.';

  assert.deepEqual(rankContextPaths(paths, prompt), []);
  const ranked = rankContextPaths(paths, prompt, undefined, [], {
    contentHits: new Map([['src/jobs/worker.ts', 3], ['src/ui/profile.ts', 1]])
  });

  assert.deepEqual(ranked, ['src/jobs/worker.ts']);
});

test('git and open-tab signals corroborate but never qualify a path alone', () => {
  const paths = ['src/a.ts', 'src/b.ts', 'src/invoice.ts'];
  const prompt = 'Fix invoice totals.';
  const signals = {
    changedPaths: new Set(['src/a.ts', 'src/invoice.ts']),
    openPaths: new Set(['src/a.ts', 'src/b.ts'])
  };

  const ranked = rankContextPaths(paths, prompt, undefined, [], signals);

  assert.ok(ranked.includes('src/invoice.ts'));
  assert.ok(ranked.includes('src/a.ts'), 'changed + open (30) clears the threshold');
  assert.ok(!ranked.includes('src/b.ts'), 'open alone (10) does not');
  assert.equal(ranked[0], 'src/invoice.ts');
});

test('extracts file paths from pasted stack traces and resolves them in the workspace', () => {
  const trace = 'TypeError: x is undefined\n    at save (src/forms/save.ts:42:7)\n    at C:\\repo\\src\\api\\client.ts:10:3';
  const references = extractPathReferences(trace);

  assert.ok(references.includes('src/forms/save.ts'));
  assert.ok(references.includes('repo/src/api/client.ts'));
  assert.deepEqual(
    [...resolveMentionedPaths(references, ['src/forms/save.ts', 'src/api/client.ts', 'src/other.ts'])].sort(),
    ['src/api/client.ts', 'src/forms/save.ts']
  );
});

test('finds conventionally named test files next to source files', () => {
  const all = ['src/save.ts', 'src/save.test.ts', 'src/other.ts', 'tests/test_parse.py', 'pkg/parse.go', 'pkg/parse_test.go'];

  assert.deepEqual(findRelatedTests(['src/save.ts'], all), ['src/save.test.ts']);
  assert.deepEqual(findRelatedTests(['pkg/parse.go'], all), ['pkg/parse_test.go']);
  assert.deepEqual(findRelatedTests(['src/save.test.ts'], all), []);
  assert.equal(isTestPath('src/__tests__/a.ts'), true);
  assert.equal(isTestPath('src/save.ts'), false);
});

test('paths named in the prompt outrank weak term matches', () => {
  const ranked = rankContextPaths(['src/a.ts', 'src/b.ts'], 'unrelated words', undefined, [], {
    mentionedPaths: new Set(['src/b.ts'])
  });

  assert.deepEqual(ranked, ['src/b.ts']);
});

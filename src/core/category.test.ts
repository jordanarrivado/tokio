import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { classifyWorkCategory } from './category';

const examples = [
  ['The checkout crashes with an unexpected error.', 'bug'],
  ['Add a new export option to the report screen.', 'feature'],
  ['Improve this workflow and eliminate the need to open the modal.', 'enhancement'],
  ['Refactor the payment service without changing behavior.', 'refactor'],
  ['Optimize the slow query latency and provide a benchmark.', 'performance'],
  ['Add integration tests and improve test coverage.', 'tests'],
  ['Update the README and API documentation.', 'documentation'],
  ['Investigate and identify the root cause of duplicate invoices.', 'investigation']
] as const;

for (const [prompt, expected] of examples) {
  test(`classifies ${expected} work`, () => {
    const result = classifyWorkCategory(prompt);

    assert.equal(result.category, expected);
    assert.notEqual(result.confidence, 'low');
    assert.ok(result.matchedSignals.length > 0);
  });
}

test('falls back to General when no category signal is present', () => {
  assert.deepEqual(classifyWorkCategory('Change the selected employee display.'), {
    category: 'general',
    confidence: 'low',
    matchedSignals: []
  });
});

test('reports both kinds of work when two strong signals are close', () => {
  const result = classifyWorkCategory('Add tests for the broken checkout.');

  assert.equal(result.category, 'bug');
  assert.equal(result.confidence, 'medium');
  assert.deepEqual(result.additional, ['tests']);
});

test('falls back to General when signals are too weak', () => {
  assert.equal(classifyWorkCategory('Tweak the screen.').category, 'general');
});

test('classification is deterministic', () => {
  const prompt = 'Diagnose why the service fails after retrying.';
  assert.deepEqual(classifyWorkCategory(prompt), classifyWorkCategory(prompt));
});

test("does not treat a negated request as that category", () => {
  assert.notEqual(classifyWorkCategory("Fix the crash. Don't refactor anything else.").category, 'refactor');
  assert.equal(classifyWorkCategory("Fix the crash. Don't refactor anything else.").category, 'bug');
});

test('reports a clear secondary category when two kinds of work are present', () => {
  const result = classifyWorkCategory('The checkout is broken, not working, and crashes after payment. Add tests to cover the fix.');

  assert.equal(result.category, 'bug');
  assert.deepEqual(result.additional, ['tests']);
});

test('detects several kinds of work in one prompt, strongest first', () => {
  const result = classifyWorkCategory(
    'Fix the SQL injection bug in the login form, add a migration for the new column, and update the CI pipeline.'
  );

  const found = [result.category, ...(result.additional ?? [])];
  for (const expected of ['security', 'migration', 'workflow', 'bug'] as const) {
    assert.ok(found.includes(expected), `missing ${expected} in ${found.join(', ')}`);
  }
});

test('caps the extra categories at three', () => {
  const result = classifyWorkCategory(
    'Security fix for the XSS vulnerability, a schema change migration, a GitHub Actions pipeline, unit tests, and README documentation.'
  );

  assert.ok((result.additional ?? []).length <= 3);
});

const newCategoryExamples = [
  ['Hotfix: the login page is down in production, urgent.', 'hotfix'],
  ['Redesign the settings screen to be responsive and use the design system.', 'ui'],
  ['Should we use a queue or cron? Compare the options and trade-offs.', 'decision'],
  ['Plan the export feature and break it down into milestones before coding.', 'planning'],
  ['Automate the release with a GitHub Actions pipeline.', 'workflow'],
  ['Patch the XSS vulnerability in the comment form.', 'security'],
  ['Write a migration to backfill the status column.', 'migration'],
  ['Upgrade the React dependency and handle breaking changes.', 'dependency'],
  ['Code review this pull request for correctness.', 'review']
] as const;

for (const [prompt, expected] of newCategoryExamples) {
  test(`classifies ${expected} work`, () => {
    const result = classifyWorkCategory(prompt);

    assert.equal(result.category, expected);
    assert.notEqual(result.confidence, 'low');
  });
}


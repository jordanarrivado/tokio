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

test('falls back to General when category scores are ambiguous', () => {
  const result = classifyWorkCategory('Add tests for the broken checkout.');

  assert.equal(result.category, 'general');
  assert.equal(result.confidence, 'low');
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
  assert.equal(result.secondary, 'tests');
});

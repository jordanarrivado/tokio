import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { refinePrompt } from './refine';
import type { Mode } from './types';

test('rejects empty and whitespace-only prompts', () => {
  assert.throws(() => refinePrompt({ rawPrompt: '' }), /Enter a task to refine/);
  assert.throws(() => refinePrompt({ rawPrompt: ' \n\t ' }), /Enter a task to refine/);
});

test('trims outer whitespace and preserves a multiline task verbatim', () => {
  const task = 'Fix the login redirect.\nKeep the existing error message.\nDo not change the API.';
  const result = refinePrompt({ rawPrompt: `  \n${task}\n  `, mode: 'minimal' });

  assert.ok(result.refinedPrompt.includes(`Task:\n${task}\n\n`));
  assert.equal(countOccurrences(result.refinedPrompt, task), 1);
});

test('uses adaptive mode by default', () => {
  const result = refinePrompt({ rawPrompt: 'Rename the submit label.' });

  assert.equal(result.mode, 'adaptive');
  assert.match(result.refinedPrompt, /Follow existing patterns/);
  assert.match(result.refinedPrompt, /Avoid unrelated edits/);
});

test('renders a trimmed optional target path without claiming it was inspected', () => {
  const result = refinePrompt({
    rawPrompt: 'Correct the button state.',
    targetPath: '  src/components/SubmitButton.tsx  '
  });

  assert.match(result.refinedPrompt, /Start with: src\/components\/SubmitButton\.tsx/);
  assert.doesNotMatch(result.refinedPrompt, /inspected/i);
});

test('omits a blank optional target path', () => {
  const result = refinePrompt({ rawPrompt: 'Correct the button state.', targetPath: '  ' });

  assert.doesNotMatch(result.refinedPrompt, /Start with:/);
});

test('produces distinct scope instructions for every mode', () => {
  const modes: Mode[] = ['minimal', 'adaptive', 'strict'];
  const results = modes.map((mode) => refinePrompt({ rawPrompt: 'Update the setting.', mode }));

  assert.deepEqual(results.map((result) => result.mode), modes);
  assert.equal(new Set(results.map((result) => result.refinedPrompt)).size, modes.length);
  assert.match(results[0].refinedPrompt, /smallest safe change/);
  assert.match(results[1].refinedPrompt, /direct dependencies/);
  assert.doesNotMatch(results[1].refinedPrompt, /explicit approval/);
  assert.match(results[2].refinedPrompt, /No new dependencies, schema, or architecture changes without approval/);
  assert.match(results[2].refinedPrompt, /change only necessary files and direct dependencies/);
});

test('preserves Unicode and all stated requirements', () => {
  const task = '修复保存按钮。\n保留“取消”操作。\nShow the message: Café saved ✓\nDo not remove emoji 🚀.';
  const result = refinePrompt({ rawPrompt: task, mode: 'strict' });

  assert.ok(result.refinedPrompt.includes(task));
  assert.equal(countOccurrences(result.refinedPrompt, task), 1);
});

test('preserves very long input without truncation', () => {
  const task = `Implement the migration.\n${'Keep requirement A exactly. '.repeat(5000)}Final requirement.`;
  const result = refinePrompt({ rawPrompt: task });

  assert.ok(result.refinedPrompt.includes(task));
  assert.equal(countOccurrences(result.refinedPrompt, task), 1);
});

test('preserves special characters as plain task text', () => {
  const task = '<script>alert("no")</script> & keep `code`, ${value}, quotes \' and " unchanged.';
  const result = refinePrompt({ rawPrompt: task, mode: 'minimal' });

  assert.ok(result.refinedPrompt.includes(task));
  assert.equal(countOccurrences(result.refinedPrompt, task), 1);
});

test('adds only bounded selected repository context', () => {
  const result = refinePrompt({
    rawPrompt: 'Fix invoice retries.',
    targetPath: 'src/webhook.ts',
    mode: 'strict',
    outputStyle: 'detailed',
    repositoryContext: {
      scope: 'architecture',
      files: [
        'src/webhook.ts',
        'src/invoice.ts',
        'src/invoice.ts',
        'src/db.ts',
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'src/ignored-sixth.ts'
      ],
      architectureNotes: 'Handlers delegate business logic to services.'
    }
  });

  assert.match(result.refinedPrompt, /Repository context \(discovered locally; verify before editing\)/);
  assert.match(result.refinedPrompt, /Architecture profile \(user-maintained reference\)/);
  assert.match(result.refinedPrompt, /src\/invoice\.ts/);
  assert.equal(countOccurrences(result.refinedPrompt, 'src/invoice.ts'), 1);
  assert.equal(countOccurrences(result.refinedPrompt, 'src/webhook.ts'), 1);
  assert.doesNotMatch(result.refinedPrompt, /ignored-sixth/);
});

test('adds concise category-specific guidance without changing the task', () => {
  const task = 'The checkout crashes after payment.';
  const result = refinePrompt({ rawPrompt: task, category: 'bug' });

  assert.equal(result.category, 'bug');
  assert.match(result.refinedPrompt, /Type: Bug Fix/);
  assert.match(result.refinedPrompt, /Confirm root cause/);
  assert.equal(countOccurrences(result.refinedPrompt, task), 1);
});

test('keeps General category assumption-free', () => {
  const result = refinePrompt({ rawPrompt: 'Change the selected employee display.', category: 'general' });

  assert.equal(result.category, 'general');
  assert.doesNotMatch(result.refinedPrompt, /Work type:|Category guidance:/);
});

test('uses compact output by default and keeps it shorter than detailed output', () => {
  const input = {
    rawPrompt: 'Improve the employee list display.',
    targetPath: 'pages/employees.vue',
    category: 'enhancement' as const,
    mode: 'adaptive' as const
  };
  const compact = refinePrompt(input).refinedPrompt;
  const detailed = refinePrompt({ ...input, outputStyle: 'detailed' }).refinedPrompt;

  assert.match(compact, /Constraints:/);
  assert.doesNotMatch(compact, /Category guidance:/);
  assert.match(detailed, /Category guidance:/);
  assert.ok(compact.length < detailed.length);
  assert.equal(countOccurrences(compact, input.rawPrompt), 1);
});

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

test('adds done-when criteria, validation commands, related tests, and conventions only when provided', () => {
  const result = refinePrompt({
    rawPrompt: 'Fix the save label.',
    acceptanceCriteria: '  The label reads Save changes.  ',
    repositoryContext: {
      scope: 'targeted',
      files: ['src/save.ts'],
      relatedTests: ['src/save.test.ts'],
      conventionFiles: ['CLAUDE.md'],
      validationCommands: ['npm run verify', 'npm test']
    }
  });

  assert.match(result.refinedPrompt, /Done when:\nThe label reads Save changes\./);
  assert.match(result.refinedPrompt, /Related tests:\n- src\/save\.test\.ts/);
  assert.match(result.refinedPrompt, /Follow the conventions in: CLAUDE\.md\./);
  assert.match(result.refinedPrompt, /Validate with: `npm run verify`, `npm test`$/);
  assert.doesNotMatch(refinePrompt({ rawPrompt: 'Fix it.' }).refinedPrompt, /Validate with|Done when/);
});

test('adds one guidance line per additional category, skipping the primary', () => {
  const result = refinePrompt({
    rawPrompt: 'Fix the crash.',
    category: 'bug',
    additionalCategories: ['tests', 'security', 'bug']
  });

  assert.match(result.refinedPrompt, /Also: Tests — .+\nAlso: Security — /);
  assert.doesNotMatch(result.refinedPrompt, /Also: Bug Fix/);
});

test('renders additional categories inside one Claude tag', () => {
  const result = refinePrompt({
    rawPrompt: 'Fix the crash.',
    category: 'bug',
    additionalCategories: ['tests', 'migration'],
    target: 'claude'
  });

  assert.match(result.refinedPrompt, /<also>\nTests — .+\nMigration — .+\n<\/also>/);
});

test('renders Claude and Codex target formats without changing the task text', () => {
  const task = 'Fix the redirect.';
  const claude = refinePrompt({ rawPrompt: task, target: 'claude', targetPath: 'src/a.ts' }).refinedPrompt;
  const codex = refinePrompt({ rawPrompt: task, target: 'codex' }).refinedPrompt;

  assert.match(claude, /^<task>\nFix the redirect\.\n<\/task>/);
  assert.match(claude, /<start_with>\nsrc\/a\.ts\n<\/start_with>/);
  assert.match(claude, /<constraints>\n- /);
  assert.match(codex, /^## Task\nFix the redirect\./);
  assert.match(codex, /## Constraints\n- /);
});

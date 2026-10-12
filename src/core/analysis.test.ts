import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { analyzePrompt } from './analysis';

test('returns an empty analysis for a blank prompt', () => {
  assert.deepEqual(analyzePrompt('   ', 'bug'), { score: 0, level: 'low', hints: [], splitSuggested: false });
});

test('asks a bug report for expected behavior and reproduction details', () => {
  const analysis = analyzePrompt('The save button in SaveForm is broken for me today.', 'bug');

  assert.ok(analysis.hints.some((hint) => /expected behavior/i.test(hint)));
  assert.ok(analysis.hints.some((hint) => /reproduction|error text/i.test(hint)));
  assert.notEqual(analysis.level, 'high');
});

test('rates a specific bug report as high clarity', () => {
  const analysis = analyzePrompt(
    'In src/save.ts the save button throws an error when the name is empty; it should show a validation message instead.',
    'bug'
  );

  assert.deepEqual(analysis.hints, []);
  assert.equal(analysis.level, 'high');
});

test('asks features for acceptance criteria and performance work for a target', () => {
  assert.ok(analyzePrompt('Add a dark theme toggle to the SettingsPanel component please.', 'feature')
    .hints.some((hint) => /acceptance/i.test(hint)));
  assert.ok(analyzePrompt('Make the loadReport function in reports.ts faster somehow.', 'performance')
    .hints.some((hint) => /baseline|target/i.test(hint)));
  assert.equal(analyzePrompt('Make loadReport in reports.ts under 200 ms for large files.', 'performance')
    .hints.some((hint) => /baseline|target/i.test(hint)), false);
});

test('suggests splitting prompts that contain several tasks', () => {
  const analysis = analyzePrompt('Update src/a.ts.\n1. fix the title\n2. add a footer\n3. rename the route', 'general');

  assert.equal(analysis.splitSuggested, true);
  assert.ok(analysis.hints.some((hint) => /several tasks/i.test(hint)));
});

test('analysis is deterministic and bounded', () => {
  const prompt = 'fix it';
  assert.deepEqual(analyzePrompt(prompt, 'bug'), analyzePrompt(prompt, 'bug'));
  assert.ok(analyzePrompt(prompt, 'bug').hints.length <= 4);
});

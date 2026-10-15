import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { RepoFile } from './repomap';
import {
  buildRouteSignals,
  decideConfidence,
  decideTier,
  findRelevantFiles,
  formatRoutePlan,
  planPhases,
  planRoute,
  type RouteSignals
} from './routing';

const files: RepoFile[] = [
  { path: 'src/payroll/run.ts', content: 'export function runPayroll() { return auth(); }' },
  { path: 'src/auth/session.ts', content: 'export function auth() { return true; }' },
  { path: 'README.md', content: 'Unrelated notes.' }
];

function signals(overrides: Partial<RouteSignals>): RouteSignals {
  return {
    category: 'general',
    categoryConfidence: 'medium',
    relevantFiles: 1,
    modules: 1,
    riskTerms: [],
    requirements: 1,
    taskWords: 5,
    ...overrides
  };
}

test('finds files by path or by repeated task terms in content, and always includes the target', () => {
  assert.deepEqual(
    findRelevantFiles(files, 'fix payroll auth bug').sort(),
    ['src/auth/session.ts', 'src/payroll/run.ts']
  );
  assert.deepEqual(
    findRelevantFiles(files, 'fix payroll auth bug', 'README.md').sort(),
    ['README.md', 'src/auth/session.ts', 'src/payroll/run.ts']
  );
  assert.deepEqual(findRelevantFiles(files, 'hi'), []);
});

test('ignores task terms that appear in most files, so they do not make files relevant', () => {
  const broad: RepoFile[] = Array.from({ length: 8 }, (_, index) => ({
    path: `src/module${index}/index.ts`,
    content: 'export const context = createContext();\n'
  }));

  // "context" is in every file, so it's common and matches nothing.
  assert.deepEqual(findRelevantFiles(broad, 'context'), []);

  // "payroll" is specific, so its one file is the only match.
  const withSpecific = [...broad, { path: 'src/payroll/run.ts', content: 'export const payroll = 1;\n' }];
  assert.deepEqual(findRelevantFiles(withSpecific, 'context payroll'), ['src/payroll/run.ts']);

  // The explicit target is relevant even when every term is common.
  assert.deepEqual(findRelevantFiles(broad, 'context', 'src/module0/index.ts'), ['src/module0/index.ts']);
});

test('counts modules, risk terms, and bullet requirements from the task', () => {
  const task = 'Migrate the payroll schema\n- update reports\n- add audit rows\n- keep exports';
  const built = buildRouteSignals({
    task,
    relevantFiles: ['src/payroll/run.ts', 'app/Http/export.php'],
    category: 'feature',
    categoryConfidence: 'medium'
  });

  assert.equal(built.modules, 2);
  assert.deepEqual([...built.riskTerms].sort(), ['migrate', 'payroll', 'schema']);
  assert.equal(built.requirements, 3);
});

test('assigns small, medium, and large tiers from the signals', () => {
  assert.equal(decideTier(signals({ relevantFiles: 1 })).tier, 'small');
  assert.equal(decideTier(signals({ relevantFiles: 4 })).tier, 'medium');
  assert.equal(decideTier(signals({ riskTerms: ['auth'] })).tier, 'medium');
  assert.equal(decideTier(signals({ relevantFiles: 3, riskTerms: ['migrate', 'payroll'] })).tier, 'large');
  assert.equal(decideTier(signals({ relevantFiles: 9 })).tier, 'large');
});

test('lowers confidence when signals disagree, and keeps the mid model in that case', () => {
  const keywordOnly = signals({ relevantFiles: 1, riskTerms: ['migrate', 'payroll'] });
  const tier = decideTier(keywordOnly).tier;
  assert.equal(tier, 'large');
  assert.equal(decideConfidence(keywordOnly, tier), 'low');
  assert.deepEqual(planPhases(tier, 'low')[0].model, 'mid');

  assert.equal(decideConfidence(signals({ relevantFiles: 0 }), 'small'), 'low');
  assert.equal(decideConfidence(signals({ relevantFiles: 9, categoryConfidence: 'high' }), 'large'), 'high');
});

test('recommends the large model for planning only on a confident large route', () => {
  const plan = planRoute({
    task: 'Migrate payroll and auth schema across services',
    relevantFiles: ['services/payroll/run.ts', 'modules/auth/guard.ts', 'app/Reports/export.ts'],
    category: 'refactor',
    categoryConfidence: 'medium'
  });

  assert.equal(plan.tier, 'large');
  assert.deepEqual(plan.phases.map((phase) => [phase.phase, phase.model]), [
    ['plan', 'large'],
    ['execute', 'mid'],
    ['validate', 'none']
  ]);
});

test('skips planning for small tasks', () => {
  const plan = planRoute({
    task: 'Rename a constant',
    relevantFiles: ['src/app.ts'],
    category: 'general',
    categoryConfidence: 'low'
  });

  assert.equal(plan.tier, 'small');
  assert.deepEqual(plan.phases.map((phase) => phase.model), ['none', 'mid', 'none']);
});

test('formats the plan with its signals, phases, validation, and apply steps', () => {
  const plan = planRoute({
    task: 'Migrate payroll and auth schema across services',
    relevantFiles: ['services/payroll/run.ts', 'modules/auth/guard.ts', 'app/Reports/export.ts'],
    category: 'refactor',
    categoryConfidence: 'medium'
  });
  const text = formatRoutePlan(plan, ['php artisan test']);

  assert.match(text, /^Route \(advisory/);
  assert.match(text, /Tier: large {3}Confidence: medium/);
  assert.match(text, /1\. plan: opus \(large\)\./);
  assert.match(text, /2\. execute: sonnet \(mid\)\./);
  assert.match(text, /Validation: php artisan test/);
  assert.doesNotMatch(formatRoutePlan(plan, []), /php artisan/);
});

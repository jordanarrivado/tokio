import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArchitectureMap } from '../context/archmap';
import { formatMapCheck, parseMapPrompts, runMapPrompts } from './mapcheck';

const CLI = join(__dirname, 'cli.js');

const MAP = [
  '## Login and sessions',
  'Keywords: login, session, password reset',
  '- POST /api/login -> src/login.ts#login',
  '',
  '## Loans',
  'Keywords: loan, amortization, loan deduction',
  '- POST /api/loans -> src/loans.ts#createLoan',
  '- Related: src/loans'
].join('\n');

const areas = parseArchitectureMap(MAP);

test('parseMapPrompts resolves area names case-insensitively and defaults allow to empty', () => {
  const cases = parseMapPrompts('[{ "prompt": "fix the login", "areas": ["login and SESSIONS"] }]', areas);
  assert.deepEqual(cases, [{ prompt: 'fix the login', areas: ['Login and sessions'], allow: [] }]);
});

test('parseMapPrompts names the problem in a bad prompts file', () => {
  assert.throws(() => parseMapPrompts('{', areas), /not valid JSON/);
  assert.throws(() => parseMapPrompts('{}', areas), /JSON array/);
  assert.throws(() => parseMapPrompts('[{ "areas": [] }]', areas), /Prompt 1 needs a non-empty "prompt"/);
  assert.throws(() => parseMapPrompts('[{ "prompt": "x", "areas": "Loans" }]', areas), /"areas" as an array/);
  assert.throws(() => parseMapPrompts('[{ "prompt": "x", "areas": ["Payroll"] }]', areas), /"Payroll", which is not an area/);
});

test('runMapPrompts reports missing and extra areas, and allow excuses an extra', () => {
  const cases = parseMapPrompts(JSON.stringify([
    { prompt: 'fix the login session timeout', areas: ['Login and sessions'] },
    { prompt: 'loan deduction amortization is wrong', areas: ['Login and sessions'] },
    { prompt: 'check if this is worth it for the team', areas: [] },
    { prompt: 'fix the login session timeout', areas: [], allow: ['Login and sessions'] }
  ]), areas);
  const results = runMapPrompts(areas, cases);
  assert.deepEqual(results.map((result) => [result.missing, result.extra]), [
    [[], []],
    [['Login and sessions'], ['Loans']],
    [[], []],
    [[], []]
  ]);

  const report = formatMapCheck(
    { path: '.tokio/map.md', areas: 2, routes: 2, stale: [], areaNames: ['Login and sessions', 'Loans'] },
    results,
    { cases }
  );
  assert.equal(report.ok, false);
  // Failures name the terms behind each matched or extra area, and why an expected one missed.
  assert.match(report.text, /FAIL "loan deduction amortization is wrong"\n {2}matched: Loans 1\.00 \(via loan, deduction, amortization\)/);
  assert.match(report.text, /\n {2}missing: Login and sessions: no task term found in the area/);
  assert.match(report.text, /\n {2}extra: {3}Loans \(via loan, deduction, amortization\)/);
  assert.match(report.text, /3 of 4 prompts match their expected areas\.\n1 of 2 areas have no sample prompt: Loans\./);
  assert.doesNotMatch(report.text, /^ok /m);

  const verbose = formatMapCheck({ path: '.tokio/map.md', areas: 2, routes: 2, stale: [] }, results, { verbose: true });
  assert.match(verbose.text, /ok {3}"fix the login session timeout"\n {2}matched: Login and sessions 1\.00 \(via login, session\)/);
});

test('a missing area below the relative cutoff is explained with its share of the best score', () => {
  const map = parseArchitectureMap([
    '## Payroll run',
    'Keywords: payroll run, net pay, gross pay, payroll deduction',
    '- POST /api/payroll -> src/payroll.ts#run',
    '',
    '## Loans',
    'Keywords: loan, loan deduction',
    '- POST /api/loans -> src/loans.ts#createLoan'
  ].join('\n'));
  const cases = parseMapPrompts(JSON.stringify([
    { prompt: 'net pay and gross pay are wrong after the payroll run deduction', areas: ['Payroll run', 'Loans'] }
  ]), map);
  const [result] = runMapPrompts(map, cases);
  assert.deepEqual(result.missing, ['Loans']);
  assert.match(result.reasons.Loans, /^only 1 strong term \(deduction|^scored 0\.\d\d of the best area, under the 0\.5 cutoff/);
});

test('formatMapCheck fails on stale entries and explains a missing prompts file', () => {
  const report = formatMapCheck({ path: '.tokio/map.md', areas: 2, routes: 2, stale: ['Loans: no file or folder at src/loans'] }, undefined);
  assert.equal(report.ok, false);
  assert.match(report.text, /2 areas, 2 routes, 1 stale\.\n {2}stale: Loans: no file or folder at src\/loans/);
  assert.match(report.text, /No prompts file\. Add \.tokio\/map-prompts\.json/);
});

test('CLI map check exits 0 when every prompt matches, 1 on a failing prompt, and resolves folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-map-check-'));
  await mkdir(join(root, '.tokio'), { recursive: true });
  await mkdir(join(root, 'src', 'loans'), { recursive: true });
  await writeFile(join(root, 'src', 'login.ts'), 'export function login() {}\n', 'utf8');
  await writeFile(join(root, 'src', 'loans.ts'), 'export function createLoan() {}\n', 'utf8');
  await writeFile(join(root, '.tokio', 'map.md'), MAP, 'utf8');
  const run = () => spawnSync(process.execPath, [CLI, 'map', 'check', '--root', root], { encoding: 'utf8' });

  await writeFile(join(root, '.tokio', 'map-prompts.json'), JSON.stringify([
    { prompt: 'fix the login session timeout', areas: ['Login and sessions'] },
    { prompt: 'loan deduction amortization is wrong', areas: ['Loans'] }
  ]), 'utf8');
  const passing = run();
  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  assert.match(passing.stdout, /2 areas, 2 routes, 0 stale\./);
  assert.match(passing.stdout, /2 of 2 prompts match/);

  await writeFile(join(root, '.tokio', 'map-prompts.json'), JSON.stringify([
    { prompt: 'loan deduction amortization is wrong', areas: ['Login and sessions'] }
  ]), 'utf8');
  const failing = run();
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /FAIL "loan deduction amortization is wrong"/);
});

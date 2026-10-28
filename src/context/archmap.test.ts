import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  checkMap,
  findSymbolRange,
  formatMapRouting,
  mapPaths,
  parseArchitectureMap,
  rankMapAreas,
  resolveMapAnchors,
  tokenize,
  type MapFile
} from './archmap';

const MAP = [
  '# Architecture',
  '',
  'Intro text that is not an area.',
  '',
  '## Auth',
  'Keywords: login, token, session',
  '- POST /api/login -> `src/auth/login.ts#handleLogin`',
  '- GET /api/me -> src/auth/me.ts#getMe',
  '- Related: src/auth/session.ts, src/db/users.ts',
  '',
  '## Payroll',
  '**Keywords:** payslip, salary, tax',
  'Runs the monthly payroll and computes withholding.',
  '- POST /api/payroll/run -> src/payroll/run.ts#runPayroll',
  '- Related: src/payroll/tax.ts',
  '',
  '```',
  '## Not a heading inside a fence',
  '- x -> src/fake.ts',
  '```',
  '',
  '## Reports',
  'Keywords: export, csv',
  '- GET /api/reports -> src/reports/list.ts'
].join('\n');

const FILES: Record<string, string> = {
  'src/auth/login.ts': [
    "import { start } from './session';",
    '',
    'export async function handleLogin(body: unknown) {',
    '  return start(body);',
    '}',
    '',
    '',
    'export function logout() {}',
    ''
  ].join('\n'),
  'src/auth/session.ts': 'export function start(body: unknown) { return body; }\n',
  'src/payroll/run.ts': 'export class PayrollRunner {\n  runPayroll() {\n    return 1;\n  }\n}\n',
  'src/payroll/tax.ts': 'export function tax() {}\n',
  'src/reports/list.ts': 'export function listReports() {}\n'
};

const lookup = (path: string): MapFile | undefined => (FILES[path] === undefined ? undefined : { path, content: FILES[path] });

test('parses headings into areas with keywords, routes, related files, and prose; skips the title and fenced code', () => {
  const areas = parseArchitectureMap(MAP);
  assert.deepEqual(areas.map((area) => area.name), ['Auth', 'Payroll', 'Reports']);
  const [auth, payroll] = areas;
  assert.deepEqual(auth.keywords, ['login', 'token', 'session']);
  assert.deepEqual(auth.routes[0], { label: 'POST /api/login', file: 'src/auth/login.ts', symbol: 'handleLogin' });
  assert.deepEqual(auth.related, ['src/auth/session.ts', 'src/db/users.ts']);
  assert.deepEqual(payroll.keywords, ['payslip', 'salary', 'tax']);
  assert.match(payroll.prose, /monthly payroll/);
  assert.deepEqual(areas[2].routes, [{ label: 'GET /api/reports', file: 'src/reports/list.ts' }]);
});

test('ranks the area whose keywords, routes, and symbols match the task, and drops weak matches', () => {
  const areas = parseArchitectureMap(MAP);
  const ranked = rankMapAreas(areas, 'Login fails when the session token expires');
  assert.deepEqual(ranked.map((entry) => entry.area.name), ['Auth']);
  assert.deepEqual(rankMapAreas(areas, 'salary withholding is wrong on the payslip').map((entry) => entry.area.name), ['Payroll']);
  assert.deepEqual(rankMapAreas(areas, 'unrelated quantum widgets'), []);
});

test('a route path written in the task picks its area even without shared words', () => {
  const ranked = rankMapAreas(parseArchitectureMap(MAP), 'returns 500 on /api/reports');
  assert.equal(ranked[0].area.name, 'Reports');
});

test('resolves routes to line ranges, lists related files, and reports stale entries', () => {
  const areas = parseArchitectureMap(MAP);
  const ranked = rankMapAreas(areas, 'login token bug');
  assert.deepEqual(mapPaths(ranked), ['src/auth/login.ts', 'src/auth/me.ts', 'src/auth/session.ts', 'src/db/users.ts']);
  const routing = resolveMapAnchors(ranked, lookup, 'login token bug');
  assert.deepEqual(routing.anchors[0], {
    area: 'Auth', path: 'src/auth/login.ts', label: 'POST /api/login', symbol: 'handleLogin', startLine: 3, endLine: 5
  });
  assert.deepEqual(routing.stale, ['Auth: no file or folder at src/auth/me.ts', 'Auth: no file or folder at src/db/users.ts']);
  const text = formatMapRouting(routing);
  assert.match(text, /^Architecture map: Auth\./);
  assert.match(text, /- src\/auth\/login\.ts:3-5 handleLogin \(POST \/api\/login\)/);
  assert.match(text, /- src\/auth\/session\.ts \(related\)/);
  assert.match(text, /may be out of date/);
});

test('finds methods and reports a missing symbol as stale but keeps the file', () => {
  assert.deepEqual(findSymbolRange({ path: 'src/payroll/run.ts', content: FILES['src/payroll/run.ts'] }, 'PayrollRunner.runPayroll'), { startLine: 2, endLine: 4 });
  const ranked = rankMapAreas(parseArchitectureMap('## Auth\n- login -> src/auth/login.ts#gone'), 'login');
  const routing = resolveMapAnchors(ranked, lookup);
  assert.deepEqual(routing.anchors, [{ area: 'Auth', path: 'src/auth/login.ts', label: 'login', symbol: 'gone' }]);
  assert.deepEqual(routing.stale, ['Auth: symbol gone not found in src/auth/login.ts']);
});

test('a method range stops at its closing brace, and a multi-line signature does not end it early', () => {
  const content = [
    'export class Broker {',
    '  private async read(',
    '    path: string',
    '  ): Promise<string> {',
    '    return path;',
    '  }',
    '',
    '  private other() {}',
    '}'
  ].join('\n');
  assert.deepEqual(findSymbolRange({ path: 'src/broker.ts', content }, 'Broker.read'), { startLine: 2, endLine: 6 });
  const python = 'class Runner:\n    def run(self):\n        return 1\n\n    def stop(self):\n        pass\n';
  assert.deepEqual(findSymbolRange({ path: 'src/runner.py', content: python }, 'run'), { startLine: 2, endLine: 3 });
});

test('tokenize splits camelCase and paths, drops stop words, and normalizes endings', () => {
  assert.deepEqual(tokenize('handleLogin in src/payroll_runs/HTTPServer.ts with the routes'), [
    'handle', 'login', 'src', 'payroll', 'runs', 'http', 'server', 'route'
  ]);
});

test('no matching area gives a plain message', () => {
  assert.equal(formatMapRouting({ areas: [], anchors: [], stale: [] }), 'Architecture map: no area matched the task.');
});

test('checkMap counts areas and routes and lists every stale entry in the map', () => {
  const result = checkMap(parseArchitectureMap(MAP), lookup);
  assert.equal(result.areas, 3);
  assert.equal(result.routes, 4);
  assert.deepEqual(result.stale, ['Auth: no file or folder at src/auth/me.ts', 'Auth: no file or folder at src/db/users.ts']);
});

test('a folder in a route or Related line resolves as a folder pointer, not a stale entry', () => {
  const areas = parseArchitectureMap([
    '## Users',
    'Keywords: user, role',
    '- user tests -> tests/Feature/User/',
    '- Related: app/Services/Report, app/Missing'
  ].join('\n'));
  const folders = new Set(['tests/Feature/User', 'app/Services/Report']);
  const routing = resolveMapAnchors(areas.map((area) => ({ area, score: 1 })), lookup, '', (path) => folders.has(path));
  assert.deepEqual(routing.stale, ['Users: no file or folder at app/Missing']);
  const text = formatMapRouting(routing);
  assert.match(text, /- tests\/Feature\/User\/ \(user tests\)/);
  assert.match(text, /- app\/Services\/Report\/ \(folder\)/);
  assert.deepEqual(checkMap(areas, lookup, (path) => folders.has(path)).stale, ['Users: no file or folder at app/Missing']);
});

test('an area needs more than one weak or generic word to match', () => {
  const areas = parseArchitectureMap([
    '## Login and sessions',
    'Keywords: login, session, password',
    'Checks the user file and request before sign-in.',
    '- POST /api/login -> app/Http/LoginController.php#login',
    '',
    '## Employee requests',
    'Keywords: leave request, reimbursement, approval',
    '- POST /api/requests -> app/Http/RequestController.php#store'
  ].join('\n'));
  // Prose and generic verbs alone never qualify an area.
  assert.deepEqual(rankMapAreas(areas, 'check if the generation of this file is worth it for the user'), []);
  assert.deepEqual(rankMapAreas(areas, 'can you ask them to fix the two problem and send it'), []);
  // Filler such as "for" or "use" in route labels and symbols never matches on its own.
  const labelled = parseArchitectureMap('## Search\n- read stored output for search -> src/search.ts#useSearch\n');
  assert.deepEqual(rankMapAreas(labelled, 'is this worth it for the team to use'), []);
  // One keyword in a short task, or two in a long one, still matches.
  assert.equal(rankMapAreas(areas, 'fix the login')[0]?.area.name, 'Login and sessions');
  assert.equal(
    rankMapAreas(areas, 'after the last deploy a reimbursement stays pending because its approval never arrives')[0]?.area.name,
    'Employee requests'
  );
});

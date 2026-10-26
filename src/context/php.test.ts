import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseCatalog } from '../broker/catalog';
import { scanRepository } from '../broker/scan';
import { parseComposerNamespaces, phpUseNames, resolvePhpClass } from './imports';
import { linkPackageImports } from './packages';
import { buildImportEdges, buildRepoMap, extractSymbols, symbolName, type RepoFile } from './repomap';

const CONTROLLER = [
  '<?php',
  '',
  'namespace App\\Http\\Controllers;',
  '',
  'use App\\Models\\Employee;',
  'use App\\Services\\{PayrollService, Report\\ContributionService as Contributions};',
  'use Illuminate\\Http\\Request;',
  '',
  '/**',
  ' * Handles payroll. Not a function declaration: function fake() {}',
  ' */',
  'final class PayrollController extends Controller {',
  '    public function __construct(protected readonly PayrollService $service) {}',
  '',
  '    public function store(Request $request) {',
  '        return $this->service->run(fn () => Employee::all());',
  '    }',
  '',
  '    private static function &cache(): array {',
  '        return [];',
  '    }',
  '}',
  '',
  'function helper() {}',
  ''
].join('\n');

test('PHP symbols: types, top-level functions, and methods, but not docblocks or closures', () => {
  const symbols = extractSymbols(CONTROLLER, 'app/Http/Controllers/PayrollController.php');
  assert.deepEqual(symbols.map((symbol) => [symbol.line, symbolName(symbol.signature)]), [
    [12, 'PayrollController'],
    [13, '__construct'],
    [15, 'store'],
    [19, 'cache'],
    [24, 'helper']
  ]);
  assert.deepEqual(
    extractSymbols('<?php\ninterface Payable {}\ntrait HasMoney {}\nenum Status: string {}\nabstract class Base {}\nreadonly class Money {}\n', 'x.php')
      .map((symbol) => symbolName(symbol.signature)),
    ['Payable', 'HasMoney', 'Status', 'Base', 'Money']
  );
});

test('PHP use statements: single, aliased, function, and grouped imports', () => {
  assert.deepEqual(phpUseNames(CONTROLLER), [
    'App\\Models\\Employee',
    'App\\Services\\PayrollService',
    'App\\Services\\Report\\ContributionService',
    'Illuminate\\Http\\Request'
  ]);
  assert.deepEqual(phpUseNames('<?php\nuse function App\\Support\\money;\nuse \\App\\Enums\\Status as S;\n'), ['App\\Support\\money', 'App\\Enums\\Status']);
});

test('composer PSR-4 namespaces map classes to files, with Laravel App\\ as the fallback', () => {
  const composer = JSON.stringify({
    autoload: { 'psr-4': { 'App\\': 'app/', 'Database\\Factories\\': 'database/factories/' } },
    'autoload-dev': { 'psr-4': { 'Tests\\': ['tests/', 'tests-extra/'] } }
  });
  const namespaces = parseComposerNamespaces(composer);
  assert.deepEqual(namespaces.map((namespace) => namespace.prefix), ['Database\\Factories\\', 'Tests\\', 'App\\']);
  const known = new Set(['app/Models/Employee.php', 'tests-extra/Unit/PayTest.php']);
  assert.equal(resolvePhpClass('App\\Models\\Employee', namespaces, known), 'app/Models/Employee.php');
  assert.equal(resolvePhpClass('Tests\\Unit\\PayTest', namespaces, known), 'tests-extra/Unit/PayTest.php');
  assert.equal(resolvePhpClass('Illuminate\\Http\\Request', namespaces, known), undefined);

  assert.deepEqual(parseComposerNamespaces(undefined), [{ prefix: 'App\\', directories: ['app'] }]);
  assert.deepEqual(parseComposerNamespaces('{ broken'), [{ prefix: 'App\\', directories: ['app'] }]);
  assert.deepEqual(parseComposerNamespaces(undefined, false), []);
});

test('PHP use imports become ranking edges inside a repository', () => {
  const files: RepoFile[] = [
    { path: 'composer.json', content: JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }) },
    { path: 'app/Http/Controllers/PayrollController.php', content: CONTROLLER },
    { path: 'app/Models/Employee.php', content: '<?php\nnamespace App\\Models;\nclass Employee {}\n' },
    { path: 'app/Services/PayrollService.php', content: '<?php\nnamespace App\\Services;\nclass PayrollService {}\n' },
    { path: 'app/Services/Report/ContributionService.php', content: '<?php\nclass ContributionService {}\n' },
    { path: 'app/Models/Unrelated.php', content: '<?php\nclass Unrelated {}\n' }
  ];
  const edges = buildImportEdges(files, new Set(files.map((file) => file.path)));
  assert.deepEqual(edges.get('app/Http/Controllers/PayrollController.php')?.sort(), [
    'app/Models/Employee.php',
    'app/Services/PayrollService.php',
    'app/Services/Report/ContributionService.php'
  ]);

  // The task names only the controller; its imports rank above an unrelated model.
  const map = buildRepoMap(files, { task: 'fix the payroll controller store', budgetTokens: 4000 });
  const listed = map.files;
  assert.equal(listed[0], 'app/Http/Controllers/PayrollController.php');
  assert.ok(listed.indexOf('app/Models/Employee.php') < listed.indexOf('app/Models/Unrelated.php'));
});

test('a PHP use links across repositories only through the other repository\'s own namespaces', () => {
  const laravel = (name: string, extra: Record<string, string> = {}) => ({
    name,
    files: Object.entries({
      'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'app/Models/User.php': '<?php\nclass User {}\n',
      ...extra
    }).map(([path, content]) => ({ path, content }))
  });
  const links = linkPackageImports([
    laravel('api', {
      'app/Http/Controllers/PayController.php': '<?php\nuse App\\Models\\User;\nuse Hier\\Shared\\Money;\n'
    }),
    laravel('admin'),
    {
      name: 'shared',
      files: [
        { path: 'composer.json', content: JSON.stringify({ autoload: { 'psr-4': { 'Hier\\Shared\\': 'src/' } } }) },
        { path: 'src/Money.php', content: '<?php\nclass Money {}\n' }
      ]
    }
  ]);
  // App\Models\User is api's own, so it never links to admin's User; Hier\Shared\Money links to shared.
  assert.deepEqual(links.get('api/app/Http/Controllers/PayController.php'), ['shared/src/Money.php']);
});

test('the scan skips Laravel generated folders at the root and honors a per-repository cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-php-'));
  const files: Record<string, string> = {
    'app/Models/User.php': '<?php\n',
    'storage/framework/views/compiled.php': '<?php\n',
    'storage/logs/laravel.log.md': 'log',
    'bootstrap/cache/services.php': '<?php\n',
    'app/storage/framework/Kept.php': '<?php\n'
  };
  for (let index = 0; index < 5; index += 1) {
    files[`app/Jobs/Job${index}.php`] = '<?php\n';
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  const scan = await scanRepository(root, { history: false });
  const paths = scan.files.map((file) => file.path);
  assert.ok(paths.includes('app/Models/User.php'));
  assert.ok(paths.includes('app/storage/framework/Kept.php'));
  assert.ok(!paths.some((path) => path.startsWith('storage/') || path.startsWith('bootstrap/cache/')));

  const capped = await scanRepository(root, { history: false, maxFiles: 3 });
  assert.equal(capped.files.length, 3);
  assert.equal(capped.truncated, true);
});

test('catalog maxFiles is an integer from 1 to 5000', () => {
  const catalog = (maxFiles: unknown) => JSON.stringify({ default: 'api', repos: [{ name: 'api', path: 'api', maxFiles }] });
  const root = resolve(tmpdir(), 'tokio-php-root');
  assert.equal(parseCatalog(catalog(2000), root).repos[0].maxFiles, 2000);
  for (const bad of [0, 5001, 2.5, '100']) {
    assert.throws(() => parseCatalog(catalog(bad), root), { message: 'Invalid tokio.repos.json: repos[0].maxFiles must be an integer from 1 to 5000.' });
  }
});

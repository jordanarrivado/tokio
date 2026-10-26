import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { linkPackageImports, type PackageRepo } from './packages';

function repo(name: string, files: Record<string, string>, goModule?: string): PackageRepo {
  return {
    name,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    ...(goModule ? { goModule } : {})
  };
}

const SHARED_JS = repo('shared', {
  'package.json': JSON.stringify({ name: '@org/shared', main: 'dist/index.js' }),
  'src/index.ts': "export * from './avatar';\n",
  'src/avatar.ts': 'export interface UserAvatar {}\n',
  'src/theme.ts': 'export type Theme = "light" | "dark";\n',
  'src/utils/format.ts': 'export function formatName() {}\n'
});

test('a JS import of a catalog package links to the files that define the imported names', () => {
  const links = linkPackageImports([
    repo('frontend', {
      'src/profile.tsx': [
        "import { UserAvatar, type Theme as Mode } from '@org/shared';",
        "import React from 'react';",
        "import { local } from './local';",
        'export function ProfilePage() {}'
      ].join('\n')
    }),
    SHARED_JS
  ]);
  assert.deepEqual(links.get('frontend/src/profile.tsx'), ['shared/src/avatar.ts', 'shared/src/theme.ts']);
});

test('a JS import with no known names links to the package entry, and a subpath import to that module', () => {
  const links = linkPackageImports([
    repo('frontend', {
      'src/all.ts': "import * as shared from '@org/shared';\n",
      'src/format.ts': "export { formatName } from '@org/shared/utils/format';\nconst lazy = () => import('@org/shared/utils/format');\n",
      'src/other.ts': "const pkg = require('@org/shared-extra');\n"
    }),
    SHARED_JS
  ]);
  // main points into dist/, which the scan skips, so the entry falls back to src/index.
  assert.deepEqual(links.get('frontend/src/all.ts'), ['shared/src/index.ts']);
  assert.deepEqual(links.get('frontend/src/format.ts'), ['shared/src/utils/format.ts']);
  assert.equal(links.has('frontend/src/other.ts'), false);
});

test('a repository never links to its own package', () => {
  const links = linkPackageImports([SHARED_JS, repo('shared-copy', {})]);
  assert.equal(links.size, 0);
  const self = linkPackageImports([repo('shared', { ...Object.fromEntries(SHARED_JS.files.map((file) => [file.path, file.content])), 'src/use.ts': "import { UserAvatar } from '@org/shared';\n" })]);
  assert.equal(self.size, 0);
});

test('a Go import under another repository module path links to that package directory only', () => {
  const links = linkPackageImports([
    repo('backend', {
      'api/upload.go': [
        'package api',
        'import (',
        '  "fmt"',
        '  "github.com/org/shared/types"',
        '  "github.com/other/thing/types"',
        ')'
      ].join('\n'),
      'main.go': 'package main\nimport "github.com/org/shared"\n'
    }),
    repo('shared', {
      'types/user.go': 'package types\n',
      'types/user_test.go': 'package types\n',
      'doc.go': 'package shared\n'
    }, 'github.com/org/shared')
  ]);
  assert.deepEqual(links.get('backend/api/upload.go'), ['shared/types/user.go']);
  assert.deepEqual(links.get('backend/main.go'), ['shared/doc.go']);
});

test('a Python absolute import of another repository package links to its module files', () => {
  const links = linkPackageImports([
    repo('backend', {
      'app/views.py': [
        'from shared_lib.models import User',
        'import shared_lib',
        'from corepkg import io',
        'from .local import helper',
        'from tests import fixtures'
      ].join('\n')
    }),
    repo('shared', {
      'shared_lib/__init__.py': '',
      'shared_lib/models.py': 'class User:\n    pass\n',
      'src/corepkg/__init__.py': '',
      'src/corepkg/io.py': 'def read():\n    pass\n',
      'tests/__init__.py': '',
      'tests/fixtures.py': ''
    })
  ]);
  assert.deepEqual(links.get('backend/app/views.py'), [
    'shared/shared_lib/models.py',
    'shared/shared_lib/__init__.py',
    'shared/src/corepkg/__init__.py',
    'shared/src/corepkg/io.py'
  ]);
});

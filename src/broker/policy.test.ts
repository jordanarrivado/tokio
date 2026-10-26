import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSecretReference, PolicyError, redactSecrets, resolveRepoPath } from './policy';

test('redacts credential-shaped values and reports only their kinds', () => {
  const result = redactSecrets([
    'key sk-ant-abcdefghijklmnopqrstuvwx1234',
    'aws AKIAABCDEFGHIJKLMNOP',
    'header Authorization: Bearer abcdefghijklmnop1234',
    'db postgres://app:hunter2hunter2@db.internal/main',
    'password = correcthorsebattery',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'
  ].join('\n'));

  assert.doesNotMatch(result.text, /sk-ant-abc|AKIAABC|abcdefghijklmnop1234|hunter2hunter2|correcthorse|MIIB/);
  assert.match(result.text, /\[REDACTED:connection-password\]@db\.internal/);
  assert.match(result.text, /Bearer \[REDACTED:bearer-token\]/);
  assert.deepEqual([...new Set(result.redactions)].sort(), [
    'api-key', 'assignment', 'aws-access-key', 'bearer-token', 'connection-password', 'private-key'
  ]);
});

test('leaves ordinary text unchanged', () => {
  const text = 'Fix the redirect loop in src/auth/login.ts after sign-in.';
  assert.deepEqual(redactSecrets(text), { text, redactions: [] });
});

test('finds secret paths referenced inside shell commands', () => {
  assert.equal(findSecretReference('cat .env'), '.env');
  assert.equal(findSecretReference('grep -r TOKEN config/.env.local'), 'config/.env.local');
  assert.equal(findSecretReference('npm test && node --env-file=.env app.js'), '.env');
  assert.equal(findSecretReference('npm test -- src/app.ts'), undefined);
});

test('checks only quoted strings inside heredoc bodies', () => {
  assert.equal(findSecretReference("python - <<'EOF'\nif event.key == 'd': pass\nEOF"), undefined);
  assert.equal(findSecretReference("python - <<'EOF'\nopen('.env').read()\nEOF"), '.env');
  assert.equal(findSecretReference('python - <<EOF\nopen("config/server.key")\nEOF'), 'config/server.key');
  assert.equal(findSecretReference("cat <<'EOF' > server.key\nx\nEOF"), 'server.key');
  assert.equal(findSecretReference("python - <<'EOF'\nx = event.key\nEOF\ncat .env"), '.env');
  assert.equal(findSecretReference('echo "<<EOF"\nevent.key'), 'event.key');
});

test('finds Windows-style secret paths that use backslashes and no dot', () => {
  assert.equal(findSecretReference('type config\\secrets'), 'config\\secrets');
  assert.equal(findSecretReference('Get-Content config\\credentials'), 'config\\credentials');
  assert.equal(findSecretReference('cat secrets\\db'), 'secrets\\db');
});

test('resolves safe repository paths and blocks secrets, traversal, and unsupported files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tokio-policy-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
  await writeFile(join(root, '.env'), 'TOKEN=1\n', 'utf8');
  await writeFile(join(root, 'logo.png'), 'binary', 'utf8');

  const allowed = await resolveRepoPath(root, 'src/app.ts');
  assert.equal(allowed.relative, 'src/app.ts');

  for (const blocked of ['.env', 'src/../.env', '../outside.ts', 'logo.png', 'missing.ts']) {
    await assert.rejects(resolveRepoPath(root, blocked), (error: unknown) => error instanceof PolicyError || error instanceof Error);
  }
  await assert.rejects(resolveRepoPath(root, '.env'), /secret path/);
  await assert.rejects(resolveRepoPath(root, '../outside.ts'), /outside the repository/);
});

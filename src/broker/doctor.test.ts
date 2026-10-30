import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkClaudeSettings, checkMcpConfig, runDoctor, type DoctorCheck } from './doctor';
import { SECRET_DENY_PATTERNS } from '../context/discovery';
import { AGENTS_BEGIN, AGENTS_END, initProject } from './init';

const scratchDirectories: string[] = [];
after(async () => {
  await Promise.all(scratchDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tokio-doctor-'));
  scratchDirectories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

function levels(checks: readonly DoctorCheck[]): DoctorCheck['level'][] {
  return checks.map((check) => check.level);
}

const HOOK = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell|SendMessage',
        hooks: [{ type: 'command', command: 'node /repo/out/broker/cli.js hook' }]
      }
    ]
  }
};

function hookWithMatcher(matcher: string | undefined): object {
  const entry = { ...HOOK.hooks.PreToolUse[0], matcher };
  return { hooks: { PreToolUse: [entry] } };
}

test('a tokio hook whose matcher misses a tool is a warning that names the tools and the fix', () => {
  const old = checkClaudeSettings(JSON.stringify(hookWithMatcher('Read|Edit|Write|MultiEdit|Grep|Glob|Bash')));
  const hook = old.find((check) => check.name === 'PreToolUse hook');
  assert.equal(hook?.level, 'warn');
  assert.match(hook?.detail ?? '', /PowerShell/);
  assert.match(hook?.detail ?? '', /tokio init --force/);

  const bashOnly = checkClaudeSettings(JSON.stringify(hookWithMatcher('Bash'))).find((check) => check.name === 'PreToolUse hook');
  assert.match(bashOnly?.detail ?? '', /Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob, PowerShell/);

  for (const matcher of ['Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|PowerShell|SendMessage', '*', '', undefined]) {
    const covered = checkClaudeSettings(JSON.stringify(hookWithMatcher(matcher))).find((check) => check.name === 'PreToolUse hook');
    assert.equal(covered?.level, 'ok', String(matcher));
  }
});

test('a misplaced permissions key inside a hook matcher is a failure', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit',
          permissions: { allow: ['Edit'] },
          hooks: [{ type: 'command', command: 'node /repo/out/broker/cli.js hook' }]
        }
      ]
    }
  };
  const checks = checkClaudeSettings(JSON.stringify(settings));
  const failure = checks.find((check) => check.level === 'fail');
  assert.ok(failure, 'expected a failure');
  assert.match(failure.detail, /Move it to the top level/);
});

test('a top-level permissions.allow rule is listed and is not a failure', () => {
  const checks = checkClaudeSettings(JSON.stringify({ permissions: { allow: ['Edit', 'Write'] }, ...HOOK }));
  assert.ok(!checks.some((check) => check.level === 'fail'));
  const allow = checks.find((check) => check.name === 'permissions.allow');
  assert.equal(allow?.detail, 'Edit, Write');
});

test('missing secret Read deny rules are a warning that names the fix', () => {
  const checks = checkClaudeSettings(JSON.stringify({ permissions: { deny: ['Read(.env)'] }, ...HOOK }));
  const deny = checks.find((check) => check.name === 'secret deny rules');
  assert.equal(deny?.level, 'warn');
  assert.match(deny?.detail ?? '', new RegExp(`${SECRET_DENY_PATTERNS.length - 1} of ${SECRET_DENY_PATTERNS.length}`));
  assert.match(deny?.detail ?? '', /tokio init/);
});

test('settings written by tokio init pass the deny-rule check', async () => {
  const root = await project({});
  await writeFile(join(root, 'out-cli.js'), '// built', 'utf8');
  await initProject({ root, cliPath: join(root, 'out-cli.js'), force: false, dryRun: false });
  const checks = await runDoctor(root);
  const deny = checks.find((check) => check.name === 'secret deny rules');
  assert.equal(deny?.level, 'ok', deny?.detail);
});

test('a registered output-hook is reported as registered', () => {
  const checks = checkClaudeSettings(JSON.stringify({
    hooks: {
      PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node D:/tokio/out/broker/cli.js output-hook' }] }]
    }
  }));
  const post = checks.find((check) => check.name === 'PostToolUse hook');
  assert.equal(post?.level, 'ok', post?.detail);
});

test('an unregistered PreToolUse hook is a warning', () => {
  const checks = checkClaudeSettings(JSON.stringify({ hooks: {} }));
  assert.ok(checks.some((check) => check.name === 'PreToolUse hook' && check.level === 'warn'));
});

test('invalid JSON in settings is a failure', () => {
  assert.deepEqual(levels(checkClaudeSettings('{ not json')), ['fail']);
});

test('a missing CLI path in .mcp.json is a failure', async () => {
  const root = await project({});
  const config = JSON.stringify({ mcpServers: { tokio: { command: 'node', args: ['missing/cli.js', 'mcp'] } } });
  const checks = checkMcpConfig(config, root);
  assert.deepEqual(levels(checks), ['fail']);
});

test('a healthy project has no warnings or failures', async () => {
  const root = await project({
    'out/broker/cli.js': '// built',
    '.mcp.json': JSON.stringify({ mcpServers: { tokio: { command: 'node', args: ['out/broker/cli.js', 'mcp'] } } }),
    '.claude/settings.json': JSON.stringify({
      permissions: { allow: ['Edit'], deny: SECRET_DENY_PATTERNS.map((pattern) => `Read(${pattern})`) },
      hooks: {
        ...HOOK.hooks,
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /repo/out/broker/cli.js prompt-hook' }] }]
      }
    }),
    '.codex/config.toml': '[mcp_servers.tokio]\ncommand = "node"\n',
    'AGENTS.md': `# Tools\n${AGENTS_BEGIN}\nuse tokio\n${AGENTS_END}\n`
  });
  const checks = await runDoctor(root);
  assert.deepEqual(
    checks.filter((check) => check.level === 'warn' || check.level === 'fail'),
    []
  );
});

test('a half-written AGENTS.md marker block is a failure', async () => {
  const root = await project({ 'AGENTS.md': `${AGENTS_BEGIN}\nno end marker\n` });
  const checks = await runDoctor(root);
  assert.ok(checks.some((check) => check.name === 'AGENTS.md' && check.level === 'fail'));
});

test('an empty project reports warnings and does not throw', async () => {
  const root = await project({});
  const checks = await runDoctor(root);
  assert.ok(checks.some((check) => check.level === 'warn'));
  assert.ok(!checks.some((check) => check.level === 'fail'));
});

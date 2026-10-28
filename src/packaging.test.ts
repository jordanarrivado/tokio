import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { listFiles } from '@vscode/vsce';

test('packaged extension activates and renders its view without development files', async () => {
  const files = await listFiles({ cwd: process.cwd(), packagedDependencies: [] });
  assert.ok(!files.some((file) => /^(?:node_modules|src|\.worktrees)\//.test(file)));
  assert.ok(!files.some((file) => file.endsWith('.test.js')));
  const directory = await mkdtemp(join(tmpdir(), 'tokio-package-'));
  try {
    // Only stage runtime JavaScript selected by the real VSIX packaging rules.
    for (const file of files.filter((file) => file.startsWith('out/') && file.endsWith('.js'))) {
      const destination = join(directory, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(process.cwd(), file), destination);
    }
    const result = spawnSync(process.execPath, ['-e', String.raw`
      const assert = require('node:assert/strict');
      const Module = require('node:module');
      const { Script } = require('node:vm');
      const load = Module._load;
      let provider;
      const disposable = { dispose() {} };
      const vscode = {
        window: {
          registerWebviewViewProvider(id, value) {
            assert.equal(id, 'tokio.view');
            provider = value;
            return disposable;
          }
        },
        workspace: {
          createFileSystemWatcher() {
            return { ...disposable, onDidCreate() { return disposable; }, onDidChange() { return disposable; }, onDidDelete() { return disposable; } };
          },
          onDidSaveTextDocument() { return disposable; }
        },
        commands: { registerCommand() { return disposable; } },
        Uri: { joinPath(base, ...parts) { return base + '/' + parts.join('/'); } }
      };
      Module._load = function(id, ...args) {
        return id === 'vscode' ? vscode : load.call(this, id, ...args);
      };
      const extension = require(process.argv[1]);
      extension.activate({ extensionUri: 'file:///tokio', subscriptions: [] });
      assert.ok(provider, 'activation must register the view');
      const webview = {
        cspSource: 'vscode-webview:',
        asWebviewUri(uri) { return uri; },
        onDidReceiveMessage() { return disposable; }
      };
      provider.resolveWebviewView({ webview, onDidDispose() { return disposable; } });
      assert.match(webview.html, /id="refine-form"/);
      assert.equal(webview.options.enableScripts, true);
      for (const match of webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
        new Script(match[1]);
      }
    `, join(directory, 'out', 'extension.js')], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

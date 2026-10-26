import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const panelSource = readFileSync(join(process.cwd(), 'src', 'ui', 'panel.ts'), 'utf8');

test('webview has a restrictive nonce-based content security policy', () => {
  assert.match(panelSource, /default-src 'none'/);
  assert.match(panelSource, /img-src \$\{cspSource\}/);
  assert.match(panelSource, /style-src 'nonce-\$\{nonce\}'/);
  assert.match(panelSource, /script-src 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(panelSource, /unsafe-inline|unsafe-eval/);
});

test('webview loads the packaged avatar through a scoped local resource URI', () => {
  assert.match(panelSource, /localResourceRoots: \[mediaRoot\]/);
  assert.match(panelSource, /webview\.asWebviewUri/);
  assert.match(panelSource, /tokio-avatar\.png/);
});

test('webview resynchronizes controls after Chromium restores form values', () => {
  assert.match(panelSource, /<form id="refine-form" novalidate autocomplete="off">/);
  assert.match(panelSource, /window\.addEventListener\('pageshow'/);
  assert.match(panelSource, /synchronizeRestoredFormState/);
  assert.match(panelSource, /requestAnimationFrame\(synchronizeRestoredFormState\)/);
});

test('webview contains no external request mechanisms or remote resources', () => {
  assert.doesNotMatch(panelSource, /https?:\/\//);
  assert.doesNotMatch(panelSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
});

test('webview treats messages as text and copies the live edited value', () => {
  assert.doesNotMatch(panelSource, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(panelSource, /refinedPrompt\.value = message\.refinedPrompt/);
  assert.match(panelSource, /inputError\.textContent = message\.message/);
  assert.match(panelSource, /text: refinedPrompt\.value/);
  assert.match(panelSource, /targetPath\.value = message\.value/);
  assert.match(panelSource, /rawPrompt\.value = [^;\n]*\(message\.value \|\| ''\)/);
  assert.doesNotMatch(panelSource, /navigator\.clipboard/);
});

const mapSource = readFileSync(join(process.cwd(), 'src', 'ui', 'map.ts'), 'utf8');

test('repository map has the same restrictive policy and text-only rendering as the panel', () => {
  assert.match(mapSource, /default-src 'none'/);
  assert.match(mapSource, /style-src 'nonce-\$\{nonce\}'/);
  assert.match(mapSource, /script-src 'nonce-\$\{nonce\}'/);
  assert.doesNotMatch(mapSource, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(mapSource, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(mapSource, /https?:\/\//);
  assert.doesNotMatch(mapSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.match(mapSource, /localResourceRoots: \[\]/);
});

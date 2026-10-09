import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { handleWebviewRequest, type ClipboardWriter, type EditorTools } from './messages';

test('returns a refinement response with the matching request id and mode', async () => {
  const response = await handleWebviewRequest({
    type: 'refine',
    requestId: 41,
    rawPrompt: 'Update the save label.',
    targetPath: 'src/save.ts',
    mode: 'strict'
  }, unusedClipboard());

  assert.equal(response?.type, 'refineResult');
  if (response?.type !== 'refineResult') {
    return;
  }
  assert.equal(response.requestId, 41);
  assert.equal(response.mode, 'strict');
  assert.match(response.refinedPrompt, /Update the save label/);
  assert.match(response.refinedPrompt, /Start with: src\/save\.ts/);
});

test('returns the engine validation message for a blank refinement request', async () => {
  const response = await handleWebviewRequest({
    type: 'refine',
    requestId: 2,
    rawPrompt: '   ',
    targetPath: '',
    mode: 'adaptive'
  }, unusedClipboard());

  assert.deepEqual(response, {
    type: 'refineError',
    requestId: 2,
    message: 'Enter a task to refine.'
  });
});

test('classifies raw prompts locally with confidence metadata', async () => {
  const response = await handleWebviewRequest({
    type: 'classify',
    requestId: 17,
    rawPrompt: 'Improve the workflow and eliminate the need to open a modal.'
  }, unusedClipboard());

  assert.equal(response?.type, 'classificationResult');
  if (response?.type !== 'classificationResult') {
    return;
  }
  assert.equal(response.requestId, 17);
  assert.equal(response.classification.category, 'enhancement');
  assert.notEqual(response.classification.confidence, 'low');
});

test('rechecks Auto category when refinement is submitted', async () => {
  const response = await handleWebviewRequest({
    type: 'refine',
    requestId: 18,
    rawPrompt: 'The checkout is broken and crashes after payment.',
    targetPath: '',
    mode: 'strict'
  }, unusedClipboard());

  assert.equal(response?.type, 'refineResult');
  if (response?.type !== 'refineResult') {
    return;
  }
  assert.equal(response.category, 'bug');
  assert.match(response.refinedPrompt, /Type: Bug Fix/);
});

test('ignores malformed and unsupported webview messages', async () => {
  assert.equal(await handleWebviewRequest(null, unusedClipboard()), undefined);
  assert.equal(await handleWebviewRequest({ type: 'unknown' }, unusedClipboard()), undefined);
  assert.equal(await handleWebviewRequest({
    type: 'refine',
    requestId: 3,
    rawPrompt: 'Task',
    targetPath: '',
    mode: 'invented'
  }, unusedClipboard()), undefined);
  assert.equal(await handleWebviewRequest({
    type: 'refine',
    requestId: 4,
    rawPrompt: 'Task',
    targetPath: '',
    mode: 'strict',
    repositoryContext: {
      scope: 'targeted',
      files: ['1.ts', '2.ts', '3.ts', '4.ts', '5.ts', '6.ts']
    }
  }, unusedClipboard()), undefined);
});

test('copies each exact edited output and does not reuse stale generated text', async () => {
  const writes: string[] = [];
  const clipboard: ClipboardWriter = {
    writeText: async (text) => {
      writes.push(text);
    }
  };

  await handleWebviewRequest({ type: 'copy', requestId: 1, text: 'Generated output' }, clipboard);
  const response = await handleWebviewRequest({
    type: 'copy',
    requestId: 2,
    text: '  Manually edited output ✓\nwith another line  '
  }, clipboard);

  assert.deepEqual(writes, [
    'Generated output',
    '  Manually edited output ✓\nwith another line  '
  ]);
  assert.deepEqual(response, {
    type: 'copyResult',
    requestId: 2,
    success: true,
    message: 'Copied the current refined prompt.'
  });
});

test('reports empty output without writing to the clipboard', async () => {
  let called = false;
  const response = await handleWebviewRequest({ type: 'copy', requestId: 5, text: '' }, {
    writeText: async () => {
      called = true;
    }
  });

  assert.equal(called, false);
  assert.deepEqual(response, {
    type: 'copyResult',
    requestId: 5,
    success: false,
    message: 'Nothing to copy.'
  });
});

test('reports clipboard failures without throwing', async () => {
  const response = await handleWebviewRequest({ type: 'copy', requestId: 6, text: 'Keep me' }, {
    writeText: async () => {
      throw new Error('clipboard unavailable');
    }
  });

  assert.deepEqual(response, {
    type: 'copyResult',
    requestId: 6,
    success: false,
    message: 'Could not copy the refined prompt.'
  });
});

test('returns a bounded context preview from the injected scanner', async () => {
  const calls: unknown[] = [];
  const response = await handleWebviewRequest({
    type: 'scanContext',
    requestId: 9,
    rawPrompt: 'Fix payment retries.',
    targetPath: 'src/payment.ts',
    scope: 'architecture'
  }, unusedClipboard(), {
    scan: async (input) => {
      calls.push(input);
      return {
        scope: 'architecture',
        files: ['src/payment.ts'],
        architectureNotes: 'Handlers call services.',
        notices: [],
        inspectedFiles: ['src/payment.ts', '.tokio/architecture.md']
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(response, {
    type: 'contextResult',
    requestId: 9,
    context: {
      scope: 'architecture',
      files: ['src/payment.ts'],
      architectureNotes: 'Handlers call services.',
      notices: [],
      inspectedFiles: ['src/payment.ts', '.tokio/architecture.md']
    }
  });
});

test('reports trust or workspace scan errors to the webview', async () => {
  const response = await handleWebviewRequest({
    type: 'scanContext',
    requestId: 10,
    rawPrompt: 'Fix payment retries.',
    targetPath: '',
    scope: 'targeted'
  }, unusedClipboard(), {
    scan: async () => {
      throw new Error('Trust this workspace before scanning repository context.');
    }
  });

  assert.deepEqual(response, {
    type: 'contextError',
    requestId: 10,
    message: 'Trust this workspace before scanning repository context.'
  });
});

test('returns the active workspace file and selected editor text', async () => {
  const tools = editorTools();
  const activeFile = await handleWebviewRequest({
    type: 'tool',
    requestId: 11,
    tool: 'activeFile'
  }, unusedClipboard(), undefined, tools);
  const selection = await handleWebviewRequest({
    type: 'tool',
    requestId: 12,
    tool: 'editorSelection'
  }, unusedClipboard(), undefined, tools);

  assert.deepEqual(activeFile, {
    type: 'toolResult',
    requestId: 11,
    tool: 'activeFile',
    success: true,
    value: 'src/features/save.ts',
    message: 'Using the active workspace file.'
  });
  assert.deepEqual(selection, {
    type: 'toolResult',
    requestId: 12,
    tool: 'editorSelection',
    success: true,
    value: 'Selected requirement ✓',
    message: 'Loaded the current editor selection.'
  });
});

test('opens the exact current refined text in an editor', async () => {
  const opened: string[] = [];
  const tools = editorTools({
    openText: async (text) => {
      opened.push(text);
    }
  });
  const text = '  Edited prompt\nwith exact whitespace  ';
  const response = await handleWebviewRequest({
    type: 'tool',
    requestId: 13,
    tool: 'openInEditor',
    text
  }, unusedClipboard(), undefined, tools);

  assert.deepEqual(opened, [text]);
  assert.deepEqual(response, {
    type: 'toolResult',
    requestId: 13,
    tool: 'openInEditor',
    success: true,
    message: 'Opened the current refined prompt in an editor.',
    value: undefined
  });
});

test('reports unavailable editor inputs and empty output', async () => {
  const tools = editorTools({
    getActiveFilePath: () => undefined,
    getSelectedText: () => undefined
  });

  const activeFile = await handleWebviewRequest({
    type: 'tool', requestId: 14, tool: 'activeFile'
  }, unusedClipboard(), undefined, tools);
  const selection = await handleWebviewRequest({
    type: 'tool', requestId: 15, tool: 'editorSelection'
  }, unusedClipboard(), undefined, tools);
  const open = await handleWebviewRequest({
    type: 'tool', requestId: 16, tool: 'openInEditor', text: ''
  }, unusedClipboard(), undefined, tools);

  assert.equal(activeFile?.type === 'toolResult' && activeFile.success, false);
  assert.equal(selection?.type === 'toolResult' && selection.success, false);
  assert.equal(open?.type === 'toolResult' && open.success, false);
});

function unusedClipboard(): ClipboardWriter {
  return {
    writeText: async () => {
      throw new Error('Clipboard should not be used by refinement requests.');
    }
  };
}

function editorTools(overrides: Partial<EditorTools> = {}): EditorTools {
  return {
    getActiveFilePath: () => 'src/features/save.ts',
    getSelectedText: () => 'Selected requirement ✓',
    openText: async () => undefined,
    ...overrides
  };
}

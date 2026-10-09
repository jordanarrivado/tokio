import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { WorkspaceContextService } from '../context/workspace';
import { handleWebviewRequest } from './messages';

export const VIEW_ID = 'tokio.view';

export class TokioViewProvider implements vscode.WebviewViewProvider {
  private readonly contextService = new WorkspaceContextService();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const { webview } = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const avatarUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'tokio-avatar.png'));
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };

    webview.html = getWebviewHtml(avatarUri, webview.cspSource);
    const messageSubscription = webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(webview, message);
    });
    webviewView.onDidDispose(() => messageSubscription.dispose());
  }

  private async handleMessage(webview: vscode.Webview, message: unknown): Promise<void> {
    const response = await handleWebviewRequest(message, {
      writeText: (text) => vscode.env.clipboard.writeText(text)
    }, this.contextService, {
      getActiveFilePath: () => getActiveWorkspaceFilePath(),
      getSelectedText: () => getSelectedEditorText(),
      openText: async (text) => {
        const document = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    });

    if (response) {
      await webview.postMessage(response);
    }
  }
}

function getActiveWorkspaceFilePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }
  return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
}

function getSelectedEditorText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  return editor.document.getText(editor.selection);
}

function getWebviewHtml(avatarUri: vscode.Uri, cspSource: string): string {
  const nonce = randomBytes(16).toString('hex');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tokio</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --ts-bg: #1b1c1e;
      --ts-surface: #0c1b27;
      --ts-surface-raised: #102330;
      --ts-input: #0a1823;
      --ts-border: #29404f;
      --ts-border-strong: #3a5362;
      --ts-accent: #10e77a;
      --ts-accent-hover: #31ef91;
      --ts-accent-soft: rgba(16, 231, 122, 0.08);
      --ts-text: #f2f7fb;
      --ts-muted: #9cafbf;
      --ts-danger: #ff7180;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 12px;
      color: var(--ts-text);
      background: var(--ts-bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    ::selection { color: var(--ts-bg); background: var(--ts-accent); }
    * { scrollbar-color: var(--ts-border-strong) var(--ts-bg); scrollbar-width: thin; }

    .app { width: 100%; max-width: 560px; margin: 0 auto; }

    .app-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }

    .brand-mark {
      width: 40px;
      height: 40px;
      flex: 0 0 40px;
      overflow: hidden;
      border: 1px solid var(--ts-border);
      border-radius: 10px;
      background: var(--ts-input);
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
    }

    .brand-copy { min-width: 0; flex: 1; }
    .brand-avatar {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .brand-copy h1 { margin: 0; font-size: 1.12rem; line-height: 1.2; }
    .brand-copy p { margin: 2px 0 0; }

    .local-badge {
      flex: 0 0 auto;
      padding: 3px 7px;
      border: 1px solid var(--ts-accent);
      border-radius: 999px;
      color: var(--ts-accent);
      background: transparent;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    form { display: grid; gap: 10px; }

    .card {
      display: grid;
      gap: 11px;
      padding: 12px;
      border: 1px solid var(--ts-border);
      border-radius: 9px;
      background: var(--ts-surface);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    }

    .section-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .section-title h2 { margin: 0; color: var(--ts-text); font-size: 0.98rem; }
    .step {
      padding: 3px 7px;
      border-radius: 999px;
      color: var(--ts-bg);
      background: var(--ts-accent);
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .field { display: grid; gap: 6px; min-width: 0; }
    label, .field-label { font-weight: 600; }

    textarea,
    input,
    select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--ts-border-strong);
      border-radius: 6px;
      padding: 8px 9px;
      color: var(--ts-text);
      background: var(--ts-input);
      font: inherit;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }

    textarea { min-height: 132px; resize: vertical; line-height: 1.45; }
    #refined-prompt { min-height: 220px; font-family: var(--vscode-editor-font-family); }
    textarea::placeholder, input::placeholder { color: #718595; opacity: 1; }
    select { accent-color: var(--ts-accent); }

    textarea:focus,
    input:focus,
    select:focus {
      outline: none;
      border-color: var(--ts-accent);
      box-shadow: 0 0 0 1px var(--ts-accent);
    }

    button:focus-visible,
    summary:focus-visible {
      outline: 1px solid var(--ts-accent);
      outline-offset: 2px;
    }

    button {
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px 11px;
      color: var(--ts-bg);
      background: var(--ts-accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease, opacity 120ms ease, transform 80ms ease;
    }

    button:hover:not(:disabled) { background: var(--ts-accent-hover); }
    button:active:not(:disabled) { transform: translateY(1px); }
    button:disabled { cursor: not-allowed; opacity: 0.48; }

    button.secondary {
      border-color: var(--ts-border-strong);
      color: var(--ts-text);
      background: var(--ts-surface-raised);
    }

    button.secondary:hover:not(:disabled) { border-color: var(--ts-accent); background: var(--ts-accent-soft); }

    button.ghost {
      border-color: var(--ts-border-strong);
      color: var(--ts-text);
      background: transparent;
    }

    button.ghost:hover:not(:disabled) { border-color: var(--ts-accent); color: var(--ts-accent); background: var(--ts-accent-soft); }
    button.compact { min-height: 28px; padding: 4px 8px; font-size: 0.9em; }
    #selection-button { border-color: var(--ts-accent); color: var(--ts-accent); }
    .cta { width: 100%; min-height: 38px; box-shadow: 0 4px 14px rgba(16, 231, 122, 0.12); }

    .input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    .toolbar, .output-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .output-actions button { flex: 1 1 105px; }

    .field-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
    }

    .stats { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .shortcut { float: right; opacity: 0.75; font-weight: 400; }

    .detection-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

    .detection-badge,
    .confidence-badge {
      padding: 3px 7px;
      border: 1px solid var(--ts-border);
      border-radius: 999px;
      font-size: 0.82em;
    }

    .detection-badge { border-color: var(--ts-accent); color: var(--ts-accent); background: var(--ts-accent-soft); }
    .confidence-badge { color: var(--ts-muted); }
    .confidence-badge[data-confidence="high"] { border-color: var(--ts-accent); color: var(--ts-accent); }
    .confidence-badge[data-confidence="medium"] { color: #f3c969; }

    .token-comparison {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .token-metric {
      display: grid;
      gap: 2px;
      min-width: 0;
      padding: 7px;
      border: 1px solid var(--ts-border);
      border-radius: 6px;
      background: var(--ts-input);
      text-align: center;
    }

    .token-metric span { color: var(--ts-muted); font-size: 0.78em; }
    .token-metric strong { overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }

    details.advanced {
      border: 1px solid rgba(16, 231, 122, 0.3);
      border-radius: 7px;
      padding: 9px;
      background: var(--ts-accent-soft);
    }

    details.advanced > summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--ts-text);
    }

    .advanced-content { display: grid; gap: 9px; padding-top: 10px; }

    fieldset {
      min-width: 0;
      margin: 0;
      border: 1px solid var(--ts-border);
      border-radius: 6px;
      padding: 8px;
    }

    legend { font-weight: 600; }
    .context-files { display: grid; gap: 6px; }
    .context-file { display: flex; gap: 7px; align-items: flex-start; font-weight: 400; overflow-wrap: anywhere; }
    .context-file input { width: auto; margin-top: 2px; }
    input[type="checkbox"] { accent-color: var(--ts-accent); }

    .architecture-preview {
      max-height: 160px;
      overflow: auto;
      margin: 0;
      padding: 8px;
      border: 1px solid var(--ts-border-strong);
      border-radius: 6px;
      color: var(--ts-text);
      background: var(--ts-input);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .hint,
    .status {
      margin: 0;
      color: var(--ts-muted);
      font-size: 0.88em;
      line-height: 1.4;
    }

    .status:not(:empty) {
      padding: 7px 8px;
      border-left: 2px solid var(--ts-accent);
      border-radius: 3px;
      background: var(--ts-accent-soft);
    }

    .error { margin: 0; color: var(--ts-danger); }
    .footer-note { padding: 2px 4px 8px; text-align: center; }
    [hidden] { display: none !important; }

    @media (max-width: 260px) {
      body { padding: 8px; }
      .card { padding: 10px; }
      .input-row { grid-template-columns: 1fr; }
      .local-badge { display: none; }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="app-header">
      <div class="brand-mark" aria-hidden="true">
        <img class="brand-avatar" src="${avatarUri}" alt="">
      </div>
      <div class="brand-copy">
        <h1>Tokio</h1>
        <p class="hint">Focused prompts, less wandering.</p>
      </div>
      <span class="local-badge" title="No AI or network requests">Local</span>
    </header>

    <form id="refine-form" novalidate autocomplete="off">
      <section class="card" aria-labelledby="request-heading">
        <div class="section-title">
          <h2 id="request-heading">Describe the change</h2>
          <span class="step">Step 1</span>
        </div>

        <div class="field">
          <div class="field-meta">
            <label for="raw-prompt">Raw prompt</label>
            <span id="raw-stats" class="hint stats">0 chars · ≈0 tokens</span>
          </div>
          <textarea id="raw-prompt" required aria-describedby="raw-hint input-error" placeholder="What should change? Include the pain point, expected behavior, and constraints."></textarea>
          <div class="toolbar" aria-label="Raw prompt tools">
            <button id="selection-button" class="ghost compact" type="button">Use Editor Selection</button>
          </div>
          <p id="raw-hint" class="hint">Original requirements remain verbatim in the refined prompt.</p>
          <p id="input-error" class="error" role="alert" hidden></p>
          <p id="input-tool-status" class="status" role="status" aria-live="polite"></p>
        </div>

        <div class="field">
          <label for="category">Work category</label>
          <select id="category" aria-describedby="category-description">
            <option value="auto" selected>Auto detect</option>
            <option value="general">General</option>
            <option value="bug">Bug Fix</option>
            <option value="feature">Feature</option>
            <option value="enhancement">Enhancement</option>
            <option value="refactor">Refactor</option>
            <option value="performance">Performance</option>
            <option value="tests">Tests</option>
            <option value="documentation">Documentation</option>
            <option value="investigation">Investigation</option>
            <option value="other">Other</option>
          </select>
          <div class="detection-row" aria-live="polite">
            <span id="category-result" class="detection-badge">Detected: General</span>
            <span id="category-confidence" class="confidence-badge" data-confidence="low">Low confidence</span>
          </div>
          <p id="category-description" class="hint">Auto detection is local and falls back to General when uncertain.</p>
        </div>

        <div class="field">
          <label for="target-path">Starting file <span class="hint">optional</span></label>
          <div class="input-row">
            <input id="target-path" type="text" placeholder="src/features/example.ts" autocomplete="off">
            <button id="active-file-button" class="ghost compact" type="button">Use Active File</button>
          </div>
        </div>
      </section>

      <section class="card" aria-labelledby="scope-heading">
        <div class="section-title">
          <h2 id="scope-heading">Control the scope</h2>
          <span class="step">Step 2</span>
        </div>

        <div class="field">
          <label for="mode">Refinement mode</label>
          <select id="mode" aria-describedby="mode-description">
            <option value="minimal">Minimal</option>
            <option value="adaptive" selected>Adaptive</option>
            <option value="strict">Strict</option>
          </select>
          <p id="mode-description" class="hint"></p>
        </div>

        <div class="field">
          <label for="output-style">Prompt detail</label>
          <select id="output-style" aria-describedby="output-style-hint">
            <option value="compact" selected>Compact — recommended</option>
            <option value="detailed">Detailed</option>
          </select>
          <p id="output-style-hint" class="hint">Compact removes repeated guidance while retaining scope and validation.</p>
        </div>

        <details id="context-details" class="advanced">
          <summary>Repository context <span class="hint">optional</span></summary>
          <div class="advanced-content">
            <div class="field">
              <label for="context-scope">Context access</label>
              <select id="context-scope" aria-describedby="context-hint">
                <option value="none" selected>None</option>
                <option value="targeted">Targeted files</option>
                <option value="architecture">Architecture profile + targeted</option>
              </select>
              <p id="context-hint" class="hint">Opt-in, read-only discovery. Scanning requires a trusted workspace.</p>
              <button id="scan-button" class="secondary" type="button" disabled>Preview Context</button>
              <p id="context-status" class="status" role="status" aria-live="polite"></p>
            </div>

            <div id="context-preview" class="field" hidden>
              <fieldset>
                <legend>Suggested starting files</legend>
                <div id="context-files" class="context-files"></div>
              </fieldset>
              <div id="architecture-block" class="field" hidden>
                <strong>Architecture profile preview</strong>
                <pre id="architecture-preview" class="architecture-preview"></pre>
              </div>
              <p id="context-notices" class="hint"></p>
            </div>
          </div>
        </details>
      </section>

      <button id="refine-button" class="cta" type="submit" disabled>
        Refine Prompt <span class="shortcut">Ctrl ↵</span>
      </button>

      <section class="card" aria-labelledby="output-heading">
        <div class="section-title">
          <h2 id="output-heading">Refined prompt</h2>
          <span id="refined-stats" class="hint stats">0 chars · ≈0 tokens</span>
        </div>
        <textarea id="refined-prompt" aria-describedby="result-status" placeholder="Your editable, scoped prompt will appear here."></textarea>
        <div class="token-comparison" aria-label="Estimated prompt token comparison">
          <div class="token-metric"><span>Raw input</span><strong id="raw-token-total">≈0</strong></div>
          <div class="token-metric"><span>Refined</span><strong id="refined-token-total">≈0</strong></div>
          <div class="token-metric"><span>Difference</span><strong id="token-delta">0</strong></div>
        </div>
        <p class="hint">Prompt-only estimates use characters ÷ 4. Actual model and end-to-end usage will differ.</p>
        <div class="output-actions" aria-label="Refined prompt tools">
          <button id="copy-button" type="button">Copy Prompt</button>
          <button id="open-button" class="secondary" type="button">Open in Editor</button>
          <button id="clear-button" class="ghost" type="button">Clear</button>
        </div>
        <p id="result-status" class="status" role="status" aria-live="polite"></p>
      </section>

      <p class="hint footer-note">Everything runs locally. Review, copy, and paste manually into your coding agent.</p>
    </form>
  </main>

  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const form = document.getElementById('refine-form');
      const rawPrompt = document.getElementById('raw-prompt');
      const rawStats = document.getElementById('raw-stats');
      const selectionButton = document.getElementById('selection-button');
      const inputToolStatus = document.getElementById('input-tool-status');
      const category = document.getElementById('category');
      const categoryResult = document.getElementById('category-result');
      const categoryConfidence = document.getElementById('category-confidence');
      const categoryDescription = document.getElementById('category-description');
      const targetPath = document.getElementById('target-path');
      const activeFileButton = document.getElementById('active-file-button');
      const mode = document.getElementById('mode');
      const modeDescription = document.getElementById('mode-description');
      const outputStyle = document.getElementById('output-style');
      const contextScope = document.getElementById('context-scope');
      const contextDetails = document.getElementById('context-details');
      const scanButton = document.getElementById('scan-button');
      const contextStatus = document.getElementById('context-status');
      const contextPreviewPanel = document.getElementById('context-preview');
      const contextFiles = document.getElementById('context-files');
      const architectureBlock = document.getElementById('architecture-block');
      const architecturePreview = document.getElementById('architecture-preview');
      const contextNotices = document.getElementById('context-notices');
      const refineButton = document.getElementById('refine-button');
      const refinedPrompt = document.getElementById('refined-prompt');
      const refinedStats = document.getElementById('refined-stats');
      const rawTokenTotal = document.getElementById('raw-token-total');
      const refinedTokenTotal = document.getElementById('refined-token-total');
      const tokenDelta = document.getElementById('token-delta');
      const copyButton = document.getElementById('copy-button');
      const openButton = document.getElementById('open-button');
      const clearButton = document.getElementById('clear-button');
      const inputError = document.getElementById('input-error');
      const resultStatus = document.getElementById('result-status');

      let requestId = 0;
      let pendingRequestId = 0;
      let copyRequestId = 0;
      let pendingCopyRequestId = 0;
      let scanRequestId = 0;
      let pendingScanRequestId = 0;
      let toolRequestId = 0;
      let pendingToolRequestId = 0;
      let classificationRequestId = 0;
      let pendingClassificationRequestId = 0;
      let classificationTimer;
      let resolvedCategory = 'general';
      let contextPreview = null;
      let outputRevision = 0;
      let outputRevisionAtRequest = 0;

      const savedState = vscode.getState();
      if (savedState) {
        rawPrompt.value = savedState.rawPrompt || '';
        category.value = savedState.categorySelection || 'auto';
        targetPath.value = savedState.targetPath || '';
        mode.value = savedState.mode || 'adaptive';
        outputStyle.value = savedState.outputStyle || 'compact';
        contextScope.value = savedState.contextScope || 'none';
        refinedPrompt.value = savedState.refinedPrompt || '';
      }
      contextDetails.open = contextScope.value !== 'none';

      const saveState = () => {
        vscode.setState({
          rawPrompt: rawPrompt.value,
          categorySelection: category.value,
          targetPath: targetPath.value,
          mode: mode.value,
          outputStyle: outputStyle.value,
          contextScope: contextScope.value,
          refinedPrompt: refinedPrompt.value
        });
      };

      const updateRefineAvailability = () => {
        const isBlank = rawPrompt.value.trim().length === 0;
        const needsContext = contextScope.value !== 'none';
        refineButton.disabled = isBlank || (needsContext && !contextPreview);
        scanButton.disabled = isBlank || !needsContext;
        if (!isBlank) {
          inputError.hidden = true;
          inputError.textContent = '';
        }
      };

      const formatStats = (value) => {
        const characters = value.length;
        const estimatedTokens = estimateTokens(value);
        return characters.toLocaleString() + ' chars · ≈' + estimatedTokens.toLocaleString() + ' tokens';
      };

      const estimateTokens = (value) => value.length === 0 ? 0 : Math.ceil(value.length / 4);

      const updateStats = () => {
        rawStats.textContent = formatStats(rawPrompt.value);
        refinedStats.textContent = formatStats(refinedPrompt.value);
        const comparableRaw = rawPrompt.value + (targetPath.value.trim() ? '\\n\\n' + targetPath.value.trim() : '');
        const rawEstimate = estimateTokens(comparableRaw);
        const refinedEstimate = estimateTokens(refinedPrompt.value);
        const difference = refinedEstimate - rawEstimate;
        rawTokenTotal.textContent = '≈' + rawEstimate.toLocaleString();
        refinedTokenTotal.textContent = '≈' + refinedEstimate.toLocaleString();
        tokenDelta.textContent = (difference > 0 ? '+' : '') + difference.toLocaleString();
      };

      const updateModeDescription = () => {
        const descriptions = {
          minimal: 'Smallest safe change, focused validation, brief report.',
          adaptive: 'Follows existing patterns and avoids unrelated edits.',
          strict: 'Adds approval gates for dependencies, schemas, and architecture.'
        };
        modeDescription.textContent = descriptions[mode.value] || descriptions.adaptive;
      };

      const categoryLabels = {
        general: 'General',
        bug: 'Bug Fix',
        feature: 'Feature',
        enhancement: 'Enhancement',
        refactor: 'Refactor',
        performance: 'Performance',
        tests: 'Tests',
        documentation: 'Documentation',
        investigation: 'Investigation',
        other: 'Other'
      };

      const renderCategory = (classification) => {
        if (category.value !== 'auto') {
          resolvedCategory = category.value;
          categoryResult.textContent = 'Manual: ' + categoryLabels[resolvedCategory];
          categoryConfidence.textContent = 'Override';
          categoryConfidence.dataset.confidence = 'manual';
          categoryDescription.textContent = 'Manual override is active. Select Auto detect to resume suggestions.';
          return;
        }

        resolvedCategory = classification?.category || 'general';
        const confidence = classification?.confidence || 'low';
        const signals = classification?.matchedSignals || [];
        categoryResult.textContent = 'Detected: ' + categoryLabels[resolvedCategory];
        categoryConfidence.textContent = confidence.charAt(0).toUpperCase() + confidence.slice(1) + ' confidence';
        categoryConfidence.dataset.confidence = confidence;
        categoryDescription.textContent = signals.length > 0
          ? 'Matched signals: ' + signals.join(', ') + '.'
          : 'No clear category signal; General keeps the prompt assumption-free.';
      };

      const requestCategoryClassification = () => {
        clearTimeout(classificationTimer);
        pendingClassificationRequestId = 0;
        if (category.value !== 'auto') {
          renderCategory();
          return;
        }
        if (rawPrompt.value.trim().length === 0) {
          pendingClassificationRequestId = 0;
          renderCategory({ category: 'general', confidence: 'low', matchedSignals: [] });
          return;
        }

        classificationTimer = setTimeout(() => {
          classificationRequestId += 1;
          pendingClassificationRequestId = classificationRequestId;
          vscode.postMessage({
            type: 'classify',
            requestId: classificationRequestId,
            rawPrompt: rawPrompt.value
          });
        }, 180);
      };

      const requestEditorTool = (tool, text) => {
        toolRequestId += 1;
        pendingToolRequestId = toolRequestId;
        vscode.postMessage({
          type: 'tool',
          requestId: toolRequestId,
          tool,
          text
        });
      };

      const invalidateContext = (showMessage) => {
        contextPreview = null;
        pendingScanRequestId = 0;
        contextPreviewPanel.hidden = true;
        contextFiles.replaceChildren();
        architecturePreview.textContent = '';
        architectureBlock.hidden = true;
        contextNotices.textContent = '';
        contextStatus.textContent = showMessage && contextScope.value !== 'none'
          ? 'Context changed. Preview it again before refining.'
          : '';
        updateRefineAvailability();
      };

      const renderContextPreview = () => {
        contextFiles.replaceChildren();
        if (contextPreview.files.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'hint';
          empty.textContent = 'No suggested files. You can still use the architecture profile if available.';
          contextFiles.appendChild(empty);
        } else {
          contextPreview.files.forEach((path) => {
            const label = document.createElement('label');
            label.className = 'context-file';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = path;
            checkbox.checked = true;
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(path));
            contextFiles.appendChild(label);
          });
        }

        const architecture = contextPreview.architectureNotes || '';
        architecturePreview.textContent = architecture;
        architectureBlock.hidden = architecture.length === 0;
        const inspected = contextPreview.inspectedFiles.length > 0
          ? 'Inspected locally: ' + contextPreview.inspectedFiles.join(', ') + '.'
          : 'Ranking read a bounded set of workspace files locally; nothing was sent anywhere.';
        contextNotices.textContent = [inspected, ...contextPreview.notices].join(' ');
        contextPreviewPanel.hidden = false;
      };

      const selectedRepositoryContext = () => {
        if (!contextPreview || contextScope.value === 'none') {
          return undefined;
        }

        const files = Array.from(contextFiles.querySelectorAll('input[type="checkbox"]:checked'))
          .map((checkbox) => checkbox.value);
        return {
          scope: contextPreview.scope,
          files,
          architectureNotes: contextPreview.architectureNotes
        };
      };

      rawPrompt.addEventListener('input', () => {
        inputToolStatus.textContent = '';
        invalidateContext(true);
        updateRefineAvailability();
        updateStats();
        requestCategoryClassification();
        saveState();
      });
      category.addEventListener('change', () => {
        requestCategoryClassification();
        saveState();
      });
      targetPath.addEventListener('input', () => {
        inputToolStatus.textContent = '';
        invalidateContext(true);
        updateStats();
        saveState();
      });
      mode.addEventListener('change', () => {
        updateModeDescription();
        saveState();
      });
      outputStyle.addEventListener('change', saveState);
      contextScope.addEventListener('change', () => {
        invalidateContext(false);
        saveState();
      });
      refinedPrompt.addEventListener('input', () => {
        outputRevision += 1;
        resultStatus.textContent = '';
        updateStats();
        saveState();
      });

      selectionButton.addEventListener('click', () => {
        inputToolStatus.textContent = 'Reading the current editor selection...';
        requestEditorTool('editorSelection');
      });

      activeFileButton.addEventListener('click', () => {
        inputToolStatus.textContent = 'Reading the active workspace file...';
        requestEditorTool('activeFile');
      });

      openButton.addEventListener('click', () => {
        resultStatus.textContent = 'Opening the current refined prompt...';
        requestEditorTool('openInEditor', refinedPrompt.value);
      });

      scanButton.addEventListener('click', () => {
        if (rawPrompt.value.trim().length === 0 || contextScope.value === 'none') {
          return;
        }

        scanRequestId += 1;
        pendingScanRequestId = scanRequestId;
        contextStatus.textContent = 'Scanning bounded repository context locally...';
        scanButton.disabled = true;
        vscode.postMessage({
          type: 'scanContext',
          requestId: scanRequestId,
          rawPrompt: rawPrompt.value,
          targetPath: targetPath.value,
          scope: contextScope.value
        });
      });

      copyButton.addEventListener('click', () => {
        copyRequestId += 1;
        pendingCopyRequestId = copyRequestId;
        resultStatus.textContent = refinedPrompt.value.length === 0 ? 'Checking output...' : 'Copying...';
        vscode.postMessage({
          type: 'copy',
          requestId: copyRequestId,
          text: refinedPrompt.value
        });
      });

      clearButton.addEventListener('click', () => {
        rawPrompt.value = '';
        category.value = 'auto';
        resolvedCategory = 'general';
        targetPath.value = '';
        mode.value = 'adaptive';
        outputStyle.value = 'compact';
        contextScope.value = 'none';
        contextDetails.open = false;
        refinedPrompt.value = '';
        inputError.textContent = '';
        inputError.hidden = true;
        inputToolStatus.textContent = '';
        resultStatus.textContent = 'Cleared.';
        pendingRequestId = 0;
        pendingCopyRequestId = 0;
        invalidateContext(false);
        outputRevision += 1;
        updateRefineAvailability();
        updateModeDescription();
        updateStats();
        requestCategoryClassification();
        saveState();
        rawPrompt.focus();
      });

      document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !refineButton.disabled) {
          event.preventDefault();
          form.requestSubmit();
        }
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const task = rawPrompt.value.trim();
        if (!task) {
          inputError.textContent = 'Enter a task to refine.';
          inputError.hidden = false;
          rawPrompt.focus();
          updateRefineAvailability();
          return;
        }

        requestId += 1;
        pendingRequestId = requestId;
        outputRevisionAtRequest = outputRevision;
        inputError.hidden = true;
        inputError.textContent = '';
        resultStatus.textContent = 'Refining locally…';

        vscode.postMessage({
          type: 'refine',
          requestId,
          rawPrompt: rawPrompt.value,
          targetPath: targetPath.value,
          mode: mode.value,
          category: category.value === 'auto' ? undefined : resolvedCategory,
          outputStyle: outputStyle.value,
          repositoryContext: selectedRepositoryContext()
        });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) {
          return;
        }

        if (message.type === 'copyResult') {
          if (message.requestId === pendingCopyRequestId) {
            resultStatus.textContent = message.message;
          }
          return;
        }

        if (message.type === 'classificationResult') {
          if (message.requestId === pendingClassificationRequestId && category.value === 'auto') {
            renderCategory(message.classification);
          }
          return;
        }

        if (message.type === 'toolResult') {
          if (message.requestId !== pendingToolRequestId) {
            return;
          }

          if (message.tool === 'activeFile' || message.tool === 'editorSelection') {
            inputToolStatus.textContent = message.message;
          } else {
            resultStatus.textContent = message.message;
          }

          if (message.success && message.tool === 'activeFile') {
            targetPath.value = message.value || '';
            invalidateContext(true);
            updateStats();
            saveState();
          }

          if (message.success && message.tool === 'editorSelection') {
            rawPrompt.value = message.value || '';
            invalidateContext(true);
            updateRefineAvailability();
            updateStats();
            requestCategoryClassification();
            saveState();
            rawPrompt.focus();
          }
          return;
        }

        if (message.type === 'contextResult' || message.type === 'contextError') {
          if (message.requestId !== pendingScanRequestId) {
            return;
          }

          if (message.type === 'contextResult') {
            contextPreview = message.context;
            renderContextPreview();
            const architectureSize = (contextPreview.architectureNotes || '').length;
            contextStatus.textContent = 'Context preview ready: ' + contextPreview.files.length
              + ' suggested path(s), ' + architectureSize
              + ' architecture character(s). Deselect irrelevant files before refining.';
          } else {
            contextPreview = null;
            contextStatus.textContent = message.message || 'Unable to scan repository context.';
          }
          updateRefineAvailability();
          return;
        }

        if (message.requestId !== pendingRequestId) {
          return;
        }

        if (message.type === 'refineResult') {
          if (outputRevision !== outputRevisionAtRequest) {
            resultStatus.textContent = 'Output changed while refining; refine again to replace it.';
            return;
          }

          refinedPrompt.value = message.refinedPrompt;
          outputRevision += 1;
          resultStatus.textContent = 'Refined locally. You can edit the result.';
          updateStats();
          saveState();
          return;
        }

        if (message.type === 'refineError') {
          inputError.textContent = message.message || 'Unable to refine this prompt.';
          inputError.hidden = false;
          resultStatus.textContent = '';
        }
      });

      const synchronizeRestoredFormState = () => {
        contextDetails.open = contextScope.value !== 'none';
        updateRefineAvailability();
        updateModeDescription();
        updateStats();
        requestCategoryClassification();
        saveState();
      };

      window.addEventListener('pageshow', () => {
        requestAnimationFrame(() => {
          synchronizeRestoredFormState();
          requestAnimationFrame(synchronizeRestoredFormState);
        });
      });

      updateRefineAvailability();
      updateModeDescription();
      updateStats();
      requestCategoryClassification();
    })();
  </script>
</body>
</html>`;
}

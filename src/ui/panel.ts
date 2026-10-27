import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { WorkspaceContextService } from '../context/workspace';
import { RepositoryMapPanel } from './map';
import { handleWebviewRequest } from './messages';
import { createRepoCatalogService } from './repos';

export const VIEW_ID = 'tokio.view';
export const OPEN_MAP_COMMAND = 'tokio.openRepositoryMap';

/** Repository actions that change the catalog or write scope, so an open map or sidebar should refresh. */
const REPO_MUTATIONS = new Set(['grant', 'revoke', 'clearGrants', 'setDefault', 'add', 'remove']);

export class TokioViewProvider implements vscode.WebviewViewProvider {
  private readonly contextService = new WorkspaceContextService();
  private webview: vscode.Webview | undefined;
  /** Shared with the repository map, so both edit the same catalog through the same checks. */
  public readonly repoCatalog = createRepoCatalogService({
    root: () => getTrustedWorkspaceRoot(),
    pickFolder: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Add Repository'
      });
      return picked?.[0]?.fsPath;
    },
    pickFile: async (directory) => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(directory),
        openLabel: 'Use File'
      });
      return picked?.[0]?.fsPath;
    },
    confirm: async (message) => (await vscode.window.showWarningMessage(message, { modal: true }, 'Remove')) === 'Remove',
    openMap: () => {
      void vscode.commands.executeCommand(OPEN_MAP_COMMAND);
    }
  });

  public constructor(private readonly extensionUri: vscode.Uri) {}

  /** Asks the sidebar to reload the catalog after the repository map changed it. */
  public notifyReposChanged(): void {
    void this.webview?.postMessage({ type: 'reposChanged' });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    const { webview } = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const avatarUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'tokio-avatar.png'));
    webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };

    webview.html = getWebviewHtml(avatarUri, webview.cspSource);
    this.webview = webview;
    const messageSubscription = webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(webview, message);
    });
    webviewView.onDidDispose(() => {
      messageSubscription.dispose();
      this.webview = undefined;
    });
  }

  private async handleMessage(webview: vscode.Webview, message: unknown): Promise<void> {
    const response = await handleWebviewRequest(message, {
      writeText: (text) => vscode.env.clipboard.writeText(text)
    }, this.contextService, {
      getActiveFilePath: () => getActiveWorkspaceFilePath(),
      getSelectedText: () => getSelectedEditorText(),
      getDiagnosticsText: () => getActiveFileDiagnostics(),
      openText: async (text) => {
        const document = await vscode.workspace.openTextDocument({ content: text, language: 'plaintext' });
        await vscode.window.showTextDocument(document, { preview: true });
      }
    }, this.repoCatalog);

    if (response) {
      await webview.postMessage(response);
    }
    const action = (message as { action?: unknown } | undefined)?.action;
    if (response?.type === 'reposResult' && response.success && typeof action === 'string' && REPO_MUTATIONS.has(action)) {
      RepositoryMapPanel.notifyChanged();
    }
  }
}

/** The first workspace folder, where tokio.repos.json lives. Changing write scope needs a trusted, local folder. */
function getTrustedWorkspaceRoot(): string {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before changing repository settings.');
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') {
    throw new Error('Open a local workspace folder to manage repositories.');
  }
  return folder.uri.fsPath;
}

function getActiveWorkspaceFilePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }
  return vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
}

const MAX_DIAGNOSTIC_LINES = 10;

function getActiveFileDiagnostics(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }

  const path = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
  const lines = vscode.languages.getDiagnostics(uri)
    .filter((item) => item.severity <= vscode.DiagnosticSeverity.Warning)
    .sort((left, right) => left.severity - right.severity)
    .slice(0, MAX_DIAGNOSTIC_LINES)
    .map((item) => {
      const level = item.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const code = item.code !== undefined && typeof item.code !== 'object' ? ` [${item.code}]` : '';
      return `${path}:${item.range.start.line + 1}:${item.range.start.character + 1} ${level}${code}: ${item.message}`;
    });
  return lines.length > 0 ? lines.join('\n') : undefined;
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
    /* One token set, mapped to the VS Code theme, so the panel matches light, dark, and high-contrast themes. */
    :root {
      --bg: var(--vscode-sideBar-background, #1f1f1f);
      --surface: var(--vscode-editorWidget-background, #252526);
      --field: var(--vscode-input-background, #2a2a2a);
      --field-fg: var(--vscode-input-foreground, var(--text));
      --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.3)));
      --border-strong: var(--vscode-input-border, var(--border));
      --text: var(--vscode-foreground, #cccccc);
      --muted: var(--vscode-descriptionForeground, #9d9d9d);
      --placeholder: var(--vscode-input-placeholderForeground, #8a8a8a);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-text: var(--vscode-textLink-foreground, #3794ff);
      --accent-soft: color-mix(in srgb, var(--accent-text) 12%, transparent);
      --secondary: var(--vscode-button-secondaryBackground, #3a3d41);
      --secondary-fg: var(--vscode-button-secondaryForeground, var(--text));
      --secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
      --focus: var(--vscode-focusBorder, #007fd4);
      --ok: var(--vscode-testing-iconPassed, #73c991);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --danger: var(--vscode-errorForeground, #f48771);
      --mono: var(--vscode-editor-font-family, monospace);
      --radius: 8px;
      --radius-sm: 6px;
      --gap: 12px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 12px 12px 0;
      color: var(--text);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }

    ::selection { color: var(--accent-fg); background: var(--accent); }
    * { scrollbar-width: thin; }

    .app { width: 100%; max-width: 600px; margin: 0 auto; }

    /* Header */
    .app-header { display: flex; align-items: center; gap: 10px; margin-bottom: var(--gap); }
    .brand-mark {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: var(--field);
    }
    .brand-avatar { display: block; width: 100%; height: 100%; object-fit: cover; }
    .app-header h1 { margin: 0; font-size: 1.05rem; font-weight: 650; line-height: 1.2; }
    .step-counter { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }

    /* minmax(0, 1fr) lets columns shrink below their content, so a long line never widens the panel. */
    form { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); }

    /* Cards */
    .card {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--gap);
      min-width: 0;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--surface);
    }

    .section-title, .card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .section-title h2, .card-head h2 { flex: 1; min-width: 0; margin: 0; font-size: 0.95rem; font-weight: 650; }
    .step {
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      flex: 0 0 20px;
      border-radius: 50%;
      color: var(--accent-fg);
      background: var(--accent);
      font-size: 0.75em;
      font-weight: 700;
    }

    /* Collapsible card: the summary is the card header. */
    .card.collapsible { padding: 0; gap: 0; }
    .card.collapsible > details > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 14px;
      cursor: pointer;
      list-style: none;
      border-radius: var(--radius);
    }
    .card.collapsible > details > summary::-webkit-details-marker { display: none; }
    .card.collapsible > details > summary:hover { background: var(--hover); }
    .card.collapsible > details[open] > summary { border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
    .card.collapsible .card-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); padding: 14px; }
    .chevron { color: var(--muted); transition: transform 120ms ease; }
    details[open] > summary .chevron { transform: rotate(90deg); }

    /* Fields */
    .field { display: grid; gap: 6px; min-width: 0; }
    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--gap); }
    /* Wide fields sit side by side only when each gets room for a file path. */
    .field-grid.wide { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    label, .field-label { font-weight: 600; font-size: 0.92em; }
    .field-meta { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }

    textarea, input, select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 7px 9px;
      color: var(--field-fg);
      background: var(--field);
      font: inherit;
    }
    textarea { min-height: 120px; resize: vertical; line-height: 1.5; }
    #acceptance { min-height: 52px; }
    #refined-prompt { min-height: 220px; font-family: var(--mono); font-size: var(--vscode-editor-font-size); }
    textarea::placeholder, input::placeholder { color: var(--placeholder); opacity: 1; }
    select { cursor: pointer; }
    textarea:focus, input:focus, select:focus { outline: 1px solid var(--focus); outline-offset: -1px; border-color: var(--focus); }
    button:focus-visible, summary:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
    input[type="checkbox"] { width: auto; accent-color: var(--accent); }

    .input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }

    /* Buttons: primary, secondary, ghost, and a compact size for any of them. */
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 30px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: 5px 12px;
      color: var(--accent-fg);
      background: var(--accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    button.secondary { color: var(--secondary-fg); background: var(--secondary); }
    button.secondary:hover:not(:disabled) { background: var(--secondary-hover); }
    button.ghost { border-color: var(--border-strong); color: var(--text); background: transparent; font-weight: 500; }
    button.ghost:hover:not(:disabled) { background: var(--hover); }
    button.compact { min-height: 26px; padding: 3px 9px; font-size: 0.88em; }
    .toolbar, .output-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .output-actions button { flex: 1 1 auto; white-space: nowrap; }

    .cta { width: 100%; min-height: 36px; font-size: 1em; }
    .cta.stale { outline: 2px solid var(--warn); outline-offset: 2px; }
    .shortcut { margin-left: auto; padding: 1px 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.18); font-size: 0.8em; font-weight: 500; opacity: 0.85; }
    .cta-label { flex: 1; text-align: center; }

    /* Chips: one shape for every badge, with a tone per meaning. */
    .chip,
    .local-badge,
    .detection-badge,
    .confidence-badge,
    .also-badge,
    .repo-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: transparent;
      font-size: 0.8em;
      font-weight: 500;
      line-height: 1.6;
      white-space: nowrap;
    }
    .local-badge { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); font-weight: 600; }
    .detection-badge, .repo-badge[data-access="write"] { color: var(--accent-text); border-color: color-mix(in srgb, var(--accent-text) 45%, transparent); background: var(--accent-soft); }
    .confidence-badge[data-confidence="high"] { color: var(--ok); }
    .confidence-badge[data-confidence="medium"], .repo-badge[data-access="granted"] { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
    .confidence-badge[data-confidence="manual"] { color: var(--text); }
    .repo-badge[data-access="missing"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
    .also-badge { border-style: dashed; color: var(--accent-text); }
    .also-badges { display: contents; }
    .detection-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

    /* Workspace scope: one line by default, compact rows when open. The armed strip is always shown while a grant is live. */
    .scope { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin-bottom: var(--gap); }
    .scope > details { border: 1px solid var(--border); border-radius: var(--radius-sm); }
    .scope-strip {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 30px;
      padding: 4px 10px;
      cursor: pointer;
      list-style: none;
      border-radius: var(--radius-sm);
      font-size: 0.9em;
    }
    .scope-strip::-webkit-details-marker { display: none; }
    .scope-strip:hover { background: var(--hover); }
    .scope > details[open] > .scope-strip { border-bottom: 1px solid var(--border); border-radius: var(--radius-sm) var(--radius-sm) 0 0; }
    .scope-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
    .scope-text strong { color: var(--ok); font-weight: 650; }
    .scope-body { display: grid; gap: 8px; padding: 8px 10px 10px; }
    .scope-foot { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
    .scope-foot select { width: auto; padding: 2px 6px; font-size: 0.88em; }

    .armed {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 6px 5px 10px;
      border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
      border-left: 3px solid var(--warn);
      border-radius: var(--radius-sm);
      color: var(--warn);
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      font-size: 0.9em;
      font-weight: 600;
    }
    .armed span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .armed[data-soon="true"] { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); border-left-color: var(--danger); }

    .repo-rows { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .repo-row { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 30px; padding: 0 2px; border-radius: 4px; }
    .repo-row:hover { background: var(--hover); }
    .repo-index { width: 16px; flex: 0 0 16px; color: var(--muted); font-size: 0.8em; text-align: right; font-variant-numeric: tabular-nums; }
    .repo-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .repo-row[data-access="write"] .repo-name { color: var(--ok); font-weight: 650; }
    .repo-row[data-access="missing"] .repo-name { color: var(--danger); text-decoration: line-through; }
    .repo-toggle[aria-pressed="true"] { border-color: color-mix(in srgb, var(--warn) 55%, transparent); color: var(--warn); font-variant-numeric: tabular-nums; }
    .repo-more { position: relative; }
    .repo-more > summary {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      color: var(--muted);
      cursor: pointer;
      list-style: none;
      font-size: 0.72em;
      letter-spacing: 0.05em;
    }
    .repo-more > summary::-webkit-details-marker { display: none; }
    .repo-more > summary:hover, .repo-more[open] > summary { color: var(--text); background: var(--hover); }
    .repo-menu {
      position: absolute;
      right: 0;
      top: calc(100% + 4px);
      z-index: 3;
      display: grid;
      gap: 4px;
      min-width: 160px;
      padding: 6px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--surface);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
    }
    .repo-menu button { justify-content: flex-start; }
    .repo-row:has(.repo-more[open]) { position: relative; z-index: 5; }

    /* Repositories the task names, suggested only: granting edits still takes a click. */
    .scope-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 0.86em; }
    .scope-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      padding: 1px 2px 1px 9px;
      border: 1px dashed var(--border-strong);
      border-radius: 999px;
      color: var(--muted);
    }
    .scope-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scope-chip[data-access="granted"] { border-style: solid; border-color: color-mix(in srgb, var(--warn) 55%, transparent); color: var(--warn); padding-right: 9px; }
    .scope-chip[data-access="missing"] { color: var(--danger); padding-right: 9px; }
    .scope-chip button { min-height: 20px; padding: 0 7px; border-radius: 999px; font-size: 0.95em; }

    /* Prompt clarity */
    .analysis {
      display: grid;
      gap: 4px;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--muted);
      border-radius: var(--radius-sm);
      background: var(--field);
    }
    .analysis:has(.analysis-level[data-level="high"]) { border-left-color: var(--ok); }
    .analysis:has(.analysis-level[data-level="medium"]) { border-left-color: var(--warn); }
    .analysis:has(.analysis-level[data-level="low"]) { border-left-color: var(--danger); }
    .analysis-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; font-weight: 600; font-size: 0.92em; }
    .analysis-level { font-size: 0.85em; color: var(--muted); }
    .analysis-level[data-level="high"] { color: var(--ok); }
    .analysis-level[data-level="medium"] { color: var(--warn); }
    .analysis-level[data-level="low"] { color: var(--danger); }
    .analysis-hints { margin: 0; padding-left: 18px; color: var(--muted); font-size: 0.88em; }

    /* Result */
    .token-comparison { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .token-metric {
      display: grid;
      gap: 1px;
      min-width: 0;
      padding: 7px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--field);
    }
    .token-metric span { color: var(--muted); font-size: 0.78em; }
    .token-metric strong { overflow: hidden; text-overflow: ellipsis; font-size: 1.05em; font-variant-numeric: tabular-nums; }
    .history-list { display: grid; gap: 4px; }
    .history-item { width: 100%; justify-content: flex-start; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }

    /* Inline disclosure inside a card */
    details.advanced { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--field); }
    details.advanced > summary {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      list-style: none;
      font-weight: 600;
      font-size: 0.92em;
    }
    details.advanced > summary::-webkit-details-marker { display: none; }
    details.advanced > summary:hover { background: var(--hover); }
    details.advanced > summary::before { content: '›'; display: inline-block; width: 10px; color: var(--muted); transition: transform 120ms ease; }
    details.advanced[open] > summary::before { transform: rotate(90deg); }
    .advanced-content { display: grid; gap: 10px; padding: 4px 10px 10px; }

    fieldset { min-width: 0; margin: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; }
    legend { padding: 0 4px; font-weight: 600; font-size: 0.92em; }
    .context-files { display: grid; gap: 6px; }
    .context-file { display: flex; gap: 7px; align-items: flex-start; font-weight: 400; overflow-wrap: anywhere; }
    .context-file input { margin-top: 3px; }
    .architecture-preview {
      max-height: 160px;
      overflow: auto;
      margin: 0;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      font-family: var(--mono);
      font-size: var(--vscode-editor-font-size);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    /* Text */
    .hint, .status { margin: 0; color: var(--muted); font-size: 0.86em; }
    label .hint, summary .hint { font-weight: 400; }
    .stats { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .status:not(:empty) {
      padding: 6px 9px;
      border-left: 2px solid var(--accent-text);
      border-radius: 4px;
      color: var(--text);
      background: var(--accent-soft);
    }
    .error { margin: 0; color: var(--danger); font-size: 0.9em; }
    #stage-review { justify-self: center; }
    .view { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--gap); }

    /* Hierarchy: the main card stands out; the workspace and utilities step back. */
    .primary-card { border-color: color-mix(in srgb, var(--accent-text) 30%, var(--border)); }
    .primary-card > .section-title h2 { font-size: 1rem; }
    #raw-prompt { min-height: 140px; }
    .subsection { display: grid; gap: 8px; padding-top: var(--gap); border-top: 1px solid var(--border); }
    .subsection-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; }
    .subsection-head h3 { margin: 0; font-size: 0.92em; font-weight: 600; }
    details.advanced.nested { background: transparent; }

    /* Attached context, each removable before refining. */
    .context-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .context-chips:empty { display: none; }
    .context-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      padding: 1px 2px 1px 9px;
      border: 1px solid color-mix(in srgb, var(--accent-text) 45%, transparent);
      border-radius: 999px;
      color: var(--accent-text);
      background: var(--accent-soft);
      font-size: 0.82em;
    }
    .context-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .context-chip button { min-height: 20px; width: 20px; padding: 0; border-radius: 50%; color: inherit; background: transparent; font-weight: 400; }
    .context-chip button:hover:not(:disabled) { background: var(--hover); }

    /* One dominant action per view, kept in reach at the bottom. */
    .action-bar {
      position: sticky;
      bottom: 0;
      z-index: 2;
      display: grid;
      gap: 6px;
      padding: 8px 0 10px;
      background: linear-gradient(to bottom, transparent, var(--bg) 30%);
    }
    .action-hint { text-align: center; }
    .action-hint:empty { display: none; }
    .cta[aria-busy="true"] { cursor: progress; }

    .banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--warn) 50%, transparent);
      border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--warn) 10%, transparent);
      font-size: 0.9em;
    }
    .empty-state { justify-items: start; }
    .empty-state h2 { margin: 0; font-size: 0.95rem; }
    .review-links { justify-content: flex-start; }
    details.utility { background: transparent; }
    .utility-row { display: flex; justify-content: center; }
    button.link { min-height: 24px; padding: 2px 6px; color: var(--muted); background: transparent; font-weight: 500; text-decoration: underline; text-underline-offset: 2px; }
    button.link:hover:not(:disabled) { color: var(--text); background: transparent; }
    button.danger-link[data-confirm="true"] { color: var(--danger); }

    [hidden] { display: none !important; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

    @media (max-width: 280px) {
      body { padding: 8px 8px 0; }
      .card { padding: 11px; }
      .card.collapsible .card-body { padding: 11px; }
      .input-row { grid-template-columns: 1fr; }
      .local-badge, .shortcut { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="app-header">
      <div class="brand-mark" aria-hidden="true">
        <img class="brand-avatar" src="${avatarUri}" alt="">
      </div>
      <h1>Tokio</h1>
      <span id="step-counter" class="hint step-counter">Step 1 of 4 · Compose</span>
      <span class="local-badge" title="No AI or network requests">● Local</span>
      <details class="repo-more app-menu">
        <summary title="Workspace actions" aria-label="Workspace actions">•••</summary>
        <div class="repo-menu">
          <button id="repos-map" class="ghost compact" type="button" title="Open the draggable repository map in an editor tab">⤢ Open Map</button>
          <button id="repos-add" class="ghost compact" type="button">+ Add Repository</button>
          <button id="repos-clear" class="ghost compact" type="button">Revoke All Edits</button>
        </div>
      </details>
    </header>

    <section class="scope" aria-label="Workspace">
      <div id="armed-strip" class="armed" role="status" hidden>
        <span id="armed-text"></span>
        <button id="armed-revoke" class="ghost compact" type="button">Revoke</button>
      </div>
      <details id="repos-details">
        <summary class="scope-strip" title="The agent edits only the write target (✎). Open to allow edits in another repository.">
          <span class="chevron" aria-hidden="true">›</span>
          <span id="repos-summary" class="scope-text">Reading workspace…</span>
        </summary>
        <div class="scope-body">
          <ol id="repos-list" class="repo-rows" aria-label="Repositories in merge order"></ol>
          <div class="scope-foot">
            <label for="repos-hours" class="hint">New edit grants last</label>
            <select id="repos-hours">
              <option value="1">1 hour</option>
              <option value="2">2 hours</option>
              <option value="4" selected>4 hours</option>
              <option value="8">8 hours</option>
              <option value="24">24 hours</option>
            </select>
          </div>
        </div>
      </details>
      <p id="repos-status" class="status" role="status" aria-live="polite"></p>
    </section>

    <form id="refine-form" novalidate autocomplete="off">
      <div id="compose-view" class="view">
        <section class="card primary-card" aria-labelledby="request-heading">
          <div class="section-title">
            <h2 id="request-heading">Describe your change</h2>
            <span id="raw-stats" class="hint stats">≈0 tokens</span>
          </div>

          <div class="field">
            <label for="raw-prompt" class="visually-hidden">Describe your change</label>
            <textarea id="raw-prompt" required aria-describedby="raw-hint input-error" placeholder="What should change? Include the pain point, expected behavior, and constraints."></textarea>
            <p id="input-error" class="error" role="alert" hidden></p>
            <div id="scope-chips" class="scope-chips" aria-live="polite" hidden></div>
            <div id="analysis" class="analysis" aria-live="polite" hidden>
              <div class="analysis-head">
                <span>Prompt clarity</span>
                <span id="analysis-level" class="analysis-level" data-level="low"></span>
              </div>
              <ul id="analysis-hints" class="analysis-hints"></ul>
            </div>
            <p id="raw-hint" class="hint">Your original requirements stay verbatim in the refined prompt.</p>
          </div>

          <div class="subsection" role="group" aria-labelledby="context-heading">
            <div class="subsection-head">
              <h3 id="context-heading">Add context</h3>
              <span class="hint">optional</span>
            </div>
            <div class="toolbar" aria-label="Add context from the editor">
              <button id="selection-button" class="ghost compact" type="button" title="Appends the selected editor text to your description.">+ Selection</button>
              <button id="diagnostics-button" class="ghost compact" type="button" title="Attaches the active file's errors and warnings. Replaces a block added earlier.">+ Errors</button>
            </div>
            <div id="context-chips" class="context-chips" aria-live="polite"></div>
            <p id="input-tool-status" class="status" role="status" aria-live="polite"></p>
            <div class="field-grid wide">
              <div class="field">
                <label for="target-path">Starting file</label>
                <div class="input-row">
                  <input id="target-path" type="text" placeholder="src/features/example.ts" autocomplete="off">
                  <button id="active-file-button" class="ghost compact" type="button" title="Uses the file open in the editor.">Active File</button>
                </div>
              </div>
              <div class="field">
                <label for="acceptance">Done when</label>
                <textarea id="acceptance" rows="2" placeholder="e.g. the form shows an error and existing tests pass."></textarea>
              </div>
            </div>
          </div>

          <div class="subsection field">
            <div class="subsection-head">
              <label for="category">Work category</label>
              <div class="detection-row" aria-live="polite">
                <span id="category-result" class="detection-badge">Auto detect</span>
                <span id="category-confidence" class="confidence-badge" data-confidence="low">On Refine</span>
                <span id="category-also" class="also-badges" hidden></span>
              </div>
            </div>
            <select id="category" aria-describedby="category-description">
              <option value="auto" selected>Auto detect</option>
              <option value="general">General</option>
              <optgroup label="Plan">
                <option value="planning">Planning</option>
                <option value="decision">Decision</option>
                <option value="investigation">Investigation</option>
              </optgroup>
              <optgroup label="Build">
                <option value="feature">Feature</option>
                <option value="enhancement">Enhancement</option>
                <option value="ui">UI Work</option>
                <option value="refactor">Refactor</option>
                <option value="performance">Performance</option>
                <option value="migration">Migration</option>
              </optgroup>
              <optgroup label="Fix">
                <option value="bug">Bug Fix</option>
                <option value="hotfix">Production Hotfix</option>
                <option value="security">Security</option>
              </optgroup>
              <optgroup label="Maintain">
                <option value="dependency">Dependency Upgrade</option>
                <option value="workflow">Workflow / Automation</option>
              </optgroup>
              <optgroup label="Support">
                <option value="tests">Tests</option>
                <option value="documentation">Documentation</option>
                <option value="review">Code Review</option>
              </optgroup>
              <option value="other">Other</option>
            </select>
            <p id="category-description" class="hint">Press Refine Prompt to detect every kind of work in the prompt. Each one adds a Type or Also line for you.</p>
          </div>

          <details id="customize-details" class="advanced">
            <summary>Customize refinement <span id="settings-summary" class="hint"></span></summary>
            <div class="advanced-content">
              <div class="field-grid">
                <div class="field">
                  <label for="mode">Mode</label>
                  <select id="mode" aria-describedby="mode-description">
                    <option value="minimal">Minimal</option>
                    <option value="adaptive" selected>Adaptive</option>
                    <option value="strict">Strict</option>
                  </select>
                </div>
                <div class="field">
                  <label for="output-style">Detail</label>
                  <select id="output-style" aria-describedby="output-style-hint" title="Compact removes repeated guidance while retaining scope and validation.">
                    <option value="compact" selected>Compact</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </div>
                <div class="field">
                  <label for="target">Agent</label>
                  <select id="target" aria-describedby="target-hint" title="Changes only the section format, not the content.">
                    <option value="generic" selected>Generic</option>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </div>
              </div>
              <p id="mode-description" class="hint"></p>
              <p id="output-style-hint" class="hint" hidden>Compact removes repeated guidance while retaining scope and validation.</p>
              <p id="target-hint" class="hint" hidden>Changes only the section format, not the content.</p>

              <details id="context-details" class="advanced nested">
                <summary>Repository context <span class="hint">read-only scan</span></summary>
                <div class="advanced-content">
                  <div class="field">
                    <label for="context-scope">Context access</label>
                    <select id="context-scope" aria-describedby="context-hint">
                      <option value="none" selected>None</option>
                      <option value="targeted">Targeted files</option>
                      <option value="architecture">Architecture profile + targeted</option>
                    </select>
                    <p id="context-hint" class="hint">Opt-in, read-only discovery. Scanning requires a trusted workspace.</p>
                    <button id="scan-button" class="secondary compact" type="button" disabled>Preview Context</button>
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
            </div>
          </details>
        </section>

        <div class="action-bar">
          <button id="refine-button" class="cta" type="submit" disabled>
            <span class="cta-label">Refine Prompt</span> <span class="shortcut">Ctrl ↵</span>
          </button>
          <p id="refine-hint" class="hint action-hint" aria-live="polite"></p>
          <button id="stage-review" class="link" type="button" hidden>Back to refined prompt ›</button>
        </div>
      </div>

      <div id="review-view" class="view" hidden>
        <div id="review-empty" class="card empty-state">
          <h2>Nothing to review yet</h2>
          <p class="hint">Describe your change in Compose, then press Refine Prompt.</p>
          <button id="review-compose-button" class="secondary" type="button">Go to Compose</button>
        </div>

        <section id="review-content" class="card primary-card" aria-labelledby="output-heading">
          <div id="stale-banner" class="banner" role="status" hidden>
            <span>Your inputs changed since this result.</span>
            <button id="refine-again-button" class="compact" type="button">Refine Again</button>
          </div>
          <div class="section-title">
            <h2 id="output-heading">Refined prompt</h2>
            <span id="refined-stats" class="hint stats">≈0 tokens</span>
          </div>
          <textarea id="refined-prompt" aria-label="Refined prompt" aria-describedby="result-status" placeholder="Your editable, scoped prompt will appear here."></textarea>
          <p id="result-status" class="status" role="status" aria-live="polite"></p>
          <div class="token-comparison" aria-label="Estimated prompt token comparison">
            <div class="token-metric"><span>Original</span><strong id="raw-token-total">≈0</strong></div>
            <div class="token-metric"><span>Refined</span><strong id="refined-token-total">≈0</strong></div>
            <div class="token-metric"><span>Difference</span><strong id="token-delta">0</strong></div>
          </div>
          <details id="compare-details" class="advanced">
            <summary>Compare with original</summary>
            <div class="advanced-content">
              <pre id="original-preview" class="architecture-preview"></pre>
            </div>
          </details>
          <div class="toolbar review-links">
            <button id="edit-original-button" class="ghost compact" type="button">← Edit Original</button>
          </div>
        </section>

        <div class="action-bar">
          <div class="output-actions" aria-label="Use the refined prompt">
            <button id="copy-button" type="button">Copy Prompt</button>
            <button id="open-button" class="secondary" type="button">Open in Editor</button>
          </div>
          <p class="hint action-hint">Estimates use characters ÷ 4. Actual model usage will differ.</p>
        </div>

        <details id="history-details" class="advanced utility">
          <summary>History <span id="history-count" class="hint"></span></summary>
          <div class="advanced-content">
            <div id="history-list" class="history-list"></div>
            <button id="history-clear" class="ghost compact" type="button">Clear history</button>
          </div>
        </details>
        <div class="utility-row">
          <button id="clear-button" class="link danger-link" type="button">Clear everything…</button>
        </div>
      </div>
    </form>
  </main>

  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const form = document.getElementById('refine-form');
      const rawPrompt = document.getElementById('raw-prompt');
      const rawStats = document.getElementById('raw-stats');
      const selectionButton = document.getElementById('selection-button');
      const diagnosticsButton = document.getElementById('diagnostics-button');
      const analysisPanel = document.getElementById('analysis');
      const analysisLevel = document.getElementById('analysis-level');
      const analysisHints = document.getElementById('analysis-hints');
      const acceptance = document.getElementById('acceptance');
      const target = document.getElementById('target');
      const historyDetails = document.getElementById('history-details');
      const historyCount = document.getElementById('history-count');
      const historyList = document.getElementById('history-list');
      const historyClear = document.getElementById('history-clear');
      const inputToolStatus = document.getElementById('input-tool-status');
      const category = document.getElementById('category');
      const categoryResult = document.getElementById('category-result');
      const categoryConfidence = document.getElementById('category-confidence');
      const categoryDescription = document.getElementById('category-description');
      const categoryAlso = document.getElementById('category-also');
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
      const reposDetails = document.getElementById('repos-details');
      const reposSummary = document.getElementById('repos-summary');
      const reposList = document.getElementById('repos-list');
      const reposHours = document.getElementById('repos-hours');
      const reposAdd = document.getElementById('repos-add');
      const reposMap = document.getElementById('repos-map');
      const reposClear = document.getElementById('repos-clear');
      const reposStatus = document.getElementById('repos-status');
      const armedStrip = document.getElementById('armed-strip');
      const armedText = document.getElementById('armed-text');
      const armedRevoke = document.getElementById('armed-revoke');
      let reposRequestId = 0;
      let pendingReposRequestId = 0;
      let reposView;
      let pendingReposAction = 'list';
      // Set once the repository code below is ready; the stats update calls it on every prompt change.
      let renderScopeChips = () => {};
      let reposStatusTimer;

      // Journey: Compose and Review are two views of one task; Refine and Use are tracked as steps.
      const composeView = document.getElementById('compose-view');
      const reviewView = document.getElementById('review-view');
      const stageReview = document.getElementById('stage-review');
      const stepCounter = document.getElementById('step-counter');
      const contextChips = document.getElementById('context-chips');
      const settingsSummary = document.getElementById('settings-summary');
      const refineHint = document.getElementById('refine-hint');
      const refineLabel = refineButton.querySelector('.cta-label');
      const reviewEmpty = document.getElementById('review-empty');
      const reviewContent = document.getElementById('review-content');
      const staleBanner = document.getElementById('stale-banner');
      const refineAgainButton = document.getElementById('refine-again-button');
      const editOriginalButton = document.getElementById('edit-original-button');
      const reviewComposeButton = document.getElementById('review-compose-button');
      const originalPreview = document.getElementById('original-preview');
      let view = 'compose';
      let refining = false;
      let used = false;
      let refinedFrom = '';
      let clearArmedTimer;

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
      let pendingRawForHistory = '';
      let history = [];
      const MAX_HISTORY = 10;

      const savedState = vscode.getState();
      if (savedState) {
        acceptance.value = savedState.acceptance || '';
        target.value = savedState.target || 'generic';
        history = Array.isArray(savedState.history) ? savedState.history.slice(0, MAX_HISTORY) : [];
        rawPrompt.value = savedState.rawPrompt || '';
        category.value = savedState.categorySelection || 'auto';
        targetPath.value = savedState.targetPath || '';
        mode.value = savedState.mode || 'adaptive';
        outputStyle.value = savedState.outputStyle || 'compact';
        contextScope.value = savedState.contextScope || 'none';
        refinedPrompt.value = savedState.refinedPrompt || '';
        view = savedState.view === 'review' ? 'review' : 'compose';
        used = savedState.used === true;
        refinedFrom = savedState.refinedFrom || '';
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
          refinedPrompt: refinedPrompt.value,
          acceptance: acceptance.value,
          target: target.value,
          history,
          view,
          used,
          refinedFrom
        });
        markIfStale();
        renderContextChips();
        updateSettingsSummary();
        updateJourney();
      };

      // Snapshot of the inputs behind the shown result, so a later change is visibly pending.
      let refinedSettings = '';
      let settingsAtRequest = '';
      const staleMessage = 'Inputs changed since the last refine. Press Refine Prompt to update the result.';
      const currentSettings = () => JSON.stringify([
        rawPrompt.value, category.value, targetPath.value, mode.value, outputStyle.value,
        target.value, acceptance.value, contextScope.value
      ]);
      const markIfStale = () => {
        const stale = refinedSettings !== '' && refinedPrompt.value.length > 0
          && currentSettings() !== refinedSettings;
        refineButton.classList.toggle('stale', stale);
        // The banner in Review carries the stale notice; the status line keeps only action results.
        staleBanner.hidden = !stale;
        if (resultStatus.textContent === staleMessage) {
          resultStatus.textContent = '';
        }
      };

      // Removes a block previously added by "Add Current Errors" so a refresh replaces it.
      const stripErrorBlock = (text) => text
        .replace(/(?:^|\\n\\n)Current errors:\\n(?:[^\\n]*:\\d+:\\d+ (?:error|warning)[^\\n]*(?:\\n|$))+/g, '')
        .trim();
      const errorBlockLines = (text) => {
        const block = /(?:^|\\n\\n)Current errors:\\n((?:[^\\n]*:\\d+:\\d+ (?:error|warning)[^\\n]*(?:\\n|$))+)/.exec(text);
        return block ? block[1].trim().split('\\n').length : 0;
      };

      const showView = (next, focus) => {
        view = next;
        composeView.hidden = next !== 'compose';
        reviewView.hidden = next !== 'review';
        window.scrollTo({ top: 0 });
        if (focus) {
          (next === 'compose' ? rawPrompt : refinedPrompt).focus({ preventScroll: true });
        }
        saveState();
      };

      const updateJourney = () => {
        const hasResult = refinedPrompt.value.length > 0;
        const stale = !staleBanner.hidden;
        // The main button names the next action, so one counter replaces the four-step bar.
        const [number, name] = refining
          ? [2, 'Refining…']
          : view === 'review'
            ? used && !stale ? [4, 'Used'] : [3, 'Review']
            : [1, 'Compose'];
        stepCounter.textContent = 'Step ' + number + ' of 4 · ' + name;
        stageReview.hidden = view !== 'compose' || !hasResult;
        reviewEmpty.hidden = hasResult;
        reviewContent.hidden = !hasResult;
        copyButton.disabled = !hasResult;
        openButton.disabled = !hasResult;
      };

      // One readable line for the collapsed settings, so defaults are visible without opening them.
      const updateSettingsSummary = () => {
        const label = (select) => select.options[select.selectedIndex]?.text || '';
        const context = contextScope.value === 'none' ? 'no repo context' : label(contextScope);
        settingsSummary.textContent = [label(mode), label(outputStyle), label(target), context].join(' · ');
      };

      const afterContextChange = (message) => {
        inputToolStatus.textContent = message;
        invalidateContext(true);
        updateRefineAvailability();
        updateStats();
        requestCategoryClassification();
        saveState();
      };

      // Attached context, each with a remove button, so it can be checked before refining.
      const renderContextChips = () => {
        const chips = [];
        const errors = errorBlockLines(rawPrompt.value);
        if (errors > 0) {
          chips.push([errors + (errors === 1 ? ' error attached' : ' errors attached'), 'Remove the attached errors', () => {
            rawPrompt.value = stripErrorBlock(rawPrompt.value);
            afterContextChange('Removed the attached errors.');
          }]);
        }
        if (targetPath.value.trim()) {
          chips.push(['Start: ' + targetPath.value.trim(), 'Clear the starting file', () => {
            targetPath.value = '';
            afterContextChange('Cleared the starting file.');
          }]);
        }
        if (acceptance.value.trim()) {
          chips.push(['Done-when set', 'Clear the completion criteria', () => {
            acceptance.value = '';
            afterContextChange('Cleared the completion criteria.');
          }]);
        }
        contextChips.replaceChildren(...chips.map(([text, title, remove]) => {
          const chip = document.createElement('span');
          chip.className = 'context-chip';
          const label = document.createElement('span');
          label.textContent = text;
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = '×';
          button.title = title;
          button.setAttribute('aria-label', title);
          button.addEventListener('click', remove);
          chip.append(label, button);
          return chip;
        }));
      };

      const finishRefining = () => {
        refining = false;
        refineLabel.textContent = 'Refine Prompt';
        refineButton.removeAttribute('aria-busy');
        updateRefineAvailability();
        updateJourney();
      };

      const disarmClear = () => {
        clearTimeout(clearArmedTimer);
        delete clearButton.dataset.confirm;
        clearButton.textContent = 'Clear everything…';
      };

      const renderAnalysis = (analysis) => {
        analysisHints.replaceChildren();
        if (!analysis || rawPrompt.value.trim().length === 0) {
          analysisPanel.hidden = true;
          return;
        }
        analysisLevel.textContent = analysis.level.charAt(0).toUpperCase() + analysis.level.slice(1)
          + ' · ' + analysis.score + '/100';
        analysisLevel.dataset.level = analysis.level;
        analysis.hints.forEach((hint) => {
          const item = document.createElement('li');
          item.textContent = hint;
          analysisHints.appendChild(item);
        });
        if (analysis.hints.length === 0) {
          const item = document.createElement('li');
          item.textContent = 'No obvious gaps detected.';
          analysisHints.appendChild(item);
        }
        analysisPanel.hidden = false;
      };

      const renderHistory = () => {
        historyList.replaceChildren();
        historyCount.textContent = history.length > 0 ? '(' + history.length + ')' : '';
        history.forEach((entry) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ghost compact history-item';
          const firstLine = (entry.raw || '').split('\\n')[0].trim();
          button.textContent = firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine;
          button.title = 'Restore this prompt';
          button.addEventListener('click', () => {
            rawPrompt.value = entry.raw || '';
            refinedPrompt.value = entry.refined || '';
            // The settings behind a history entry are unknown, so do not flag it as stale.
            refinedSettings = '';
            outputRevision += 1;
            invalidateContext(true);
            updateRefineAvailability();
            updateStats();
            requestCategoryClassification();
            resultStatus.textContent = 'Restored from history.';
            refinedFrom = entry.raw || '';
            originalPreview.textContent = refinedFrom;
            used = false;
            showView('review');
          });
          historyList.appendChild(button);
        });
        if (history.length === 0) {
          const empty = document.createElement('span');
          empty.className = 'hint';
          empty.textContent = 'Refined prompts appear here.';
          historyList.appendChild(empty);
        }
      };

      const addToHistory = (raw, refined) => {
        history = [{ raw, refined }, ...history.filter((entry) => entry.raw !== raw)].slice(0, MAX_HISTORY);
        renderHistory();
      };

      const updateRefineAvailability = () => {
        const isBlank = rawPrompt.value.trim().length === 0;
        const needsContext = contextScope.value !== 'none';
        refineButton.disabled = refining || isBlank || (needsContext && !contextPreview);
        scanButton.disabled = isBlank || !needsContext;
        // Say why Refine is unavailable instead of leaving a silent disabled button.
        refineHint.textContent = refining
          ? 'Refining locally…'
          : isBlank
            ? 'Describe your change to enable Refine.'
            : needsContext && !contextPreview
              ? 'Preview repository context in Customize refinement, or set Context access to None.'
              : '';
        if (!isBlank) {
          inputError.hidden = true;
          inputError.textContent = '';
        }
      };

      const formatStats = (value) => {
        const estimatedTokens = estimateTokens(value);
        return '≈' + estimatedTokens.toLocaleString() + ' tokens';
      };

      const estimateTokens = (value) => value.length === 0 ? 0 : Math.ceil(value.length / 4);

      const updateStats = () => {
        rawStats.textContent = formatStats(rawPrompt.value);
        renderScopeChips();
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
        hotfix: 'Production Hotfix',
        feature: 'Feature',
        enhancement: 'Enhancement',
        ui: 'UI Work',
        refactor: 'Refactor',
        performance: 'Performance',
        tests: 'Tests',
        documentation: 'Documentation',
        investigation: 'Investigation',
        decision: 'Decision',
        planning: 'Planning',
        workflow: 'Workflow / Automation',
        security: 'Security',
        migration: 'Migration',
        dependency: 'Dependency Upgrade',
        review: 'Code Review',
        other: 'Other'
      };

      const renderAlso = (additional) => {
        const labels = (additional || []).map((value) => categoryLabels[value]).filter(Boolean);
        categoryAlso.replaceChildren(...labels.map((label) => {
          const badge = document.createElement('span');
          badge.className = 'also-badge';
          badge.textContent = '+ ' + label;
          return badge;
        }));
        categoryAlso.hidden = labels.length === 0;
      };

      // Auto detect runs when Refine is pressed, so the badge waits for it.
      const renderPendingDetection = () => {
        renderAlso([]);
        resolvedCategory = 'general';
        categoryResult.textContent = 'Auto detect';
        categoryConfidence.textContent = 'On Refine';
        categoryConfidence.dataset.confidence = 'low';
        categoryDescription.textContent = 'Press Refine Prompt to detect every kind of work in the prompt. Each one adds a Type or Also line for you.';
      };

      const renderCategory = (classification) => {
        if (category.value !== 'auto') {
          renderAlso([]);
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
        const additional = classification?.additional || [];
        renderAlso(additional);
        categoryDescription.textContent = (signals.length > 0
          ? 'Matched signals: ' + signals.join(', ') + '.'
          : 'No clear category signal; General keeps the prompt assumption-free.')
          + (additional.length > 0 ? ' Also found: each extra category adds one guidance line.' : '');
      };

      const requestCategoryClassification = (delay = 180) => {
        clearTimeout(classificationTimer);
        pendingClassificationRequestId = 0;
        if (category.value === 'auto') {
          renderPendingDetection();
        } else {
          renderCategory();
        }
        if (rawPrompt.value.trim().length === 0) {
          pendingClassificationRequestId = 0;
          renderAnalysis(undefined);
          return;
        }

        classificationTimer = setTimeout(() => {
          classificationRequestId += 1;
          pendingClassificationRequestId = classificationRequestId;
          vscode.postMessage({
            type: 'classify',
            requestId: classificationRequestId,
            rawPrompt: rawPrompt.value,
            category: category.value === 'auto' ? undefined : category.value
          });
        }, delay);
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

      rawPrompt.addEventListener('input', (event) => {
        inputToolStatus.textContent = '';
        invalidateContext(true);
        updateRefineAvailability();
        updateStats();
        // A paste is a finished thought, so show its categories at once instead of waiting for typing to pause.
        requestCategoryClassification(event.inputType === 'insertFromPaste' ? 0 : 180);
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

      acceptance.addEventListener('input', () => {
        saveState();
      });
      target.addEventListener('change', saveState);

      diagnosticsButton.addEventListener('click', () => {
        inputToolStatus.textContent = 'Reading errors and warnings for the active file...';
        requestEditorTool('diagnostics');
      });

      historyClear.addEventListener('click', () => {
        history = [];
        renderHistory();
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

      // Clear discards edited work, so it asks for a second click first.
      clearButton.addEventListener('click', () => {
        if (clearButton.dataset.confirm !== 'true') {
          clearButton.dataset.confirm = 'true';
          clearButton.textContent = 'Click again to clear the prompt, result, and options';
          clearTimeout(clearArmedTimer);
          clearArmedTimer = setTimeout(disarmClear, 4000);
          return;
        }
        disarmClear();
        rawPrompt.value = '';
        category.value = 'auto';
        resolvedCategory = 'general';
        targetPath.value = '';
        mode.value = 'adaptive';
        outputStyle.value = 'compact';
        target.value = 'generic';
        acceptance.value = '';
        contextScope.value = 'none';
        contextDetails.open = false;
        refinedPrompt.value = '';
        refinedSettings = '';
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
        used = false;
        refinedFrom = '';
        originalPreview.textContent = '';
        // A pending refine is dropped with the inputs, so its result is ignored.
        finishRefining();
        showView('compose', true);
      });

      stageReview.addEventListener('click', () => showView('review'));
      editOriginalButton.addEventListener('click', () => showView('compose', true));
      reviewComposeButton.addEventListener('click', () => showView('compose', true));
      refineAgainButton.addEventListener('click', () => {
        if (refineButton.disabled) {
          showView('compose', true);
          return;
        }
        form.requestSubmit();
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
        pendingRawForHistory = rawPrompt.value;
        settingsAtRequest = currentSettings();
        inputError.hidden = true;
        inputError.textContent = '';
        resultStatus.textContent = 'Refining locally…';
        refining = true;
        refineLabel.textContent = 'Refining…';
        refineButton.setAttribute('aria-busy', 'true');
        updateRefineAvailability();
        updateJourney();

        vscode.postMessage({
          type: 'refine',
          requestId,
          rawPrompt: rawPrompt.value,
          targetPath: targetPath.value,
          mode: mode.value,
          category: category.value === 'auto' ? undefined : resolvedCategory,
          outputStyle: outputStyle.value,
          target: target.value,
          acceptanceCriteria: acceptance.value.trim() ? acceptance.value : undefined,
          repositoryContext: selectedRepositoryContext()
        });
      });

      const requestRepos = (action, name) => {
        reposRequestId += 1;
        pendingReposRequestId = reposRequestId;
        pendingReposAction = action;
        // A plain reload stays quiet; only changes the user asked for report progress.
        if (action !== 'list') {
          showReposStatus('Updating...');
        }
        vscode.postMessage({
          type: 'repos',
          requestId: reposRequestId,
          action,
          name,
          hours: action === 'grant' ? Number(reposHours.value) : undefined
        });
      };

      // Repository messages fade after a few seconds, so the strip stays one line.
      const showReposStatus = (text) => {
        clearTimeout(reposStatusTimer);
        reposStatus.textContent = text || '';
        if (text) {
          reposStatusTimer = setTimeout(() => { reposStatus.textContent = ''; }, 4000);
        }
      };

      const repoButton = (label, title, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ghost compact';
        button.textContent = label;
        button.title = title;
        button.addEventListener('click', onClick);
        return button;
      };

      const formatUntil = (iso) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
      };

      const minutesLeft = (iso) => Math.ceil((new Date(iso).getTime() - Date.now()) / 60000);

      // Time left on a grant, as 3h05m or 12m.
      const formatLeft = (iso) => {
        const minutes = minutesLeft(iso);
        if (!(minutes > 0)) {
          return 'expired';
        }
        return minutes >= 60 ? Math.floor(minutes / 60) + 'h' + String(minutes % 60).padStart(2, '0') + 'm' : minutes + 'm';
      };

      const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) {
          node.className = className;
        }
        if (text !== undefined) {
          node.textContent = text;
        }
        return node;
      };

      const isGranted = (repo) => repo.access === 'granted' && !repo.missing;

      // Merge position, 1-based; 0 when the catalog leaves a repository out of the order.
      const mergePosition = (repo) => reposView.mergeOrder.indexOf(repo.name) + 1;
      const byMergeOrder = (a, b) => (mergePosition(a) || Infinity) - (mergePosition(b) || Infinity);

      // One repository per row: merge position, name, and one control for its access.
      const repoNode = (repo) => {
        const state = repo.missing ? 'missing' : repo.access;
        const row = element('li', 'repo-row');
        row.dataset.access = state;
        const position = mergePosition(repo);
        row.append(element('span', 'repo-index', position > 0 ? String(position) : '·'));

        const name = element('span', 'repo-name', (state === 'write' ? '✎ ' : '') + repo.name);
        name.title = repo.path + (repo.purpose ? ' · ' + repo.purpose : '')
          + (repo.dependsOn.length > 0 ? ' · depends on ' + repo.dependsOn.join(', ') : '');
        row.append(name);

        // The write target is marked by ✎ alone; it has no control, since it is always writable.
        if (state === 'missing') {
          const badge = element('span', 'repo-badge', 'missing');
          badge.dataset.access = state;
          row.append(badge);
        } else if (state !== 'write') {
          // The toggle is the access state: pressed means the agent may edit here until the grant ends.
          const granted = state === 'granted';
          const toggle = granted
            ? repoButton('✎ ' + formatLeft(repo.grantedUntil), 'Edits allowed until ' + formatUntil(repo.grantedUntil) + '. Click to make ' + repo.name + ' read-only.', () => requestRepos('revoke', repo.name))
            : repoButton('Allow edits', repo.name + ' is read-only. Click to let the agent edit it for ' + reposHours.selectedOptions[0].text + '.', () => requestRepos('grant', repo.name));
          toggle.classList.add('repo-toggle');
          toggle.dataset.repo = repo.name;
          toggle.setAttribute('aria-pressed', String(granted));
          row.append(toggle);
        }

        if (repo.access !== 'write') {
          const more = element('details', 'repo-more');
          const summary = element('summary', '', '•••');
          summary.title = 'More actions for ' + repo.name;
          summary.setAttribute('aria-label', 'More actions for ' + repo.name);
          const menu = element('div', 'repo-menu');
          menu.append(
            repoButton('Make Write Target', 'Make ' + repo.name + ' the default write target', () => requestRepos('setDefault', repo.name)),
            repoButton('Remove', 'Remove ' + repo.name + ' from tokio.repos.json', () => requestRepos('remove', repo.name))
          );
          more.append(summary, menu);
          row.append(more);
        }
        return row;
      };

      // One line that answers "what can the agent edit?" without opening the list.
      const renderScopeSummary = (view) => {
        const write = view.repos.find((repo) => repo.name === view.defaultRepo);
        const granted = view.repos.filter(isGranted);
        const read = view.repos.filter((repo) => repo.access === 'read' && !repo.missing);
        const missing = view.repos.filter((repo) => repo.missing).length;
        reposSummary.replaceChildren(element('strong', '', '✎ ' + [write ? write.name : view.defaultRepo, ...granted.map((repo) => repo.name)].join(' + ')));
        if (!view.fromFile) {
          reposSummary.append(' · open to add a repository');
          return;
        }
        if (read.length > 0) {
          reposSummary.append(read.length <= 3 ? ' · read: ' + read.map((repo) => repo.name).join(', ') : ' · ' + read.length + ' read-only');
        }
        if (missing > 0) {
          reposSummary.append(' · ' + missing + ' missing');
        }
      };

      // Always visible while any grant is live, with the time left; it turns red in the last 10 minutes.
      const renderArmed = () => {
        const granted = reposView ? reposView.repos.filter(isGranted) : [];
        armedStrip.hidden = granted.length === 0;
        reposClear.disabled = granted.length === 0;
        if (granted.length === 0) {
          return;
        }
        armedText.textContent = 'Edits allowed: ' + granted.map((repo) => repo.name + ' ' + formatLeft(repo.grantedUntil)).join(', ');
        armedText.title = granted.map((repo) => repo.name + ' until ' + formatUntil(repo.grantedUntil)).join('\\n');
        armedStrip.dataset.soon = String(granted.some((repo) => minutesLeft(repo.grantedUntil) <= 10));
        armedRevoke.textContent = granted.length === 1 ? 'Revoke' : 'Revoke all';
        armedRevoke.title = granted.length === 1 ? 'Make ' + granted[0].name + ' read-only again' : 'Make every granted repository read-only again';
      };

      const renderRepos = (view) => {
        reposView = view;
        reposList.replaceChildren(...[...view.repos].sort(byMergeOrder).map(repoNode));
        renderScopeSummary(view);
        renderArmed();
        renderScopeChips();
      };

      // True when the text names the repository as a whole word, or contains its folder path; like mentions() in the broker.
      const taskMentions = (text, repo) => {
        const lower = text.toLowerCase();
        const path = repo.path.toLowerCase();
        if (path && lower.split(String.fromCharCode(92)).join('/').includes(path)) {
          return true;
        }
        const name = repo.name.toLowerCase();
        const wordChar = /[a-z0-9_-]/;
        for (let index = lower.indexOf(name); index >= 0; index = lower.indexOf(name, index + 1)) {
          const before = lower.charAt(index - 1);
          const after = lower.charAt(index + name.length);
          if (!wordChar.test(before) && !wordChar.test(after)) {
            return true;
          }
        }
        return false;
      };

      const scopeChips = document.getElementById('scope-chips');
      renderScopeChips = () => {
        const named = reposView
          ? reposView.repos.filter((repo) => repo.access !== 'write' && taskMentions(rawPrompt.value, repo)).sort(byMergeOrder)
          : [];
        scopeChips.hidden = named.length === 0;
        if (named.length === 0) {
          scopeChips.replaceChildren();
          return;
        }
        scopeChips.replaceChildren(element('span', 'hint', 'Task mentions'), ...named.map((repo) => {
          const state = repo.missing ? 'missing' : repo.access;
          const chip = element('span', 'scope-chip');
          chip.dataset.access = state;
          if (state === 'granted') {
            chip.append(element('span', '', '✎ ' + repo.name + ' ' + formatLeft(repo.grantedUntil)));
            chip.title = 'The agent may edit ' + repo.name + ' until ' + formatUntil(repo.grantedUntil) + '.';
          } else if (state === 'missing') {
            chip.append(element('span', '', repo.name + ' · missing'));
            chip.title = 'The folder ' + repo.path + ' is missing.';
          } else {
            chip.append(element('span', '', repo.name + ' · read-only'));
            chip.title = 'The agent can read ' + repo.name + ' but not edit it.';
            chip.append(repoButton('Allow edits', 'Let the agent edit ' + repo.name + ' for ' + reposHours.selectedOptions[0].text + '.', () => requestRepos('grant', repo.name)));
          }
          return chip;
        }));
      };

      // Count grants down, and reload once one ends so the access shown is never stale.
      setInterval(() => {
        if (!reposView) {
          return;
        }
        if (reposView.repos.some((repo) => isGranted(repo) && !(minutesLeft(repo.grantedUntil) > 0))) {
          requestRepos('list');
          showReposStatus('An edit grant ended. That repository is read-only again.');
          return;
        }
        renderArmed();
        renderScopeChips();
        reposView.repos.filter(isGranted).forEach((repo) => {
          const toggle = reposList.querySelector('.repo-toggle[data-repo="' + CSS.escape(repo.name) + '"]');
          if (toggle) {
            toggle.textContent = '✎ ' + formatLeft(repo.grantedUntil);
          }
        });
      }, 30000);

      armedRevoke.addEventListener('click', () => {
        const granted = reposView ? reposView.repos.filter(isGranted) : [];
        if (granted.length === 1) {
          requestRepos('revoke', granted[0].name);
        } else if (granted.length > 1) {
          requestRepos('clearGrants');
        }
      });
      // Menu actions close the menu, so it never covers the result.
      const fromMenu = (button, action) => button.addEventListener('click', () => {
        button.closest('details')?.removeAttribute('open');
        requestRepos(action);
      });
      fromMenu(reposAdd, 'add');
      fromMenu(reposMap, 'openMap');
      fromMenu(reposClear, 'clearGrants');
      // The catalog can change outside the panel, so reload whenever the panel comes back into view.
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          requestRepos('list');
        }
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) {
          return;
        }

        // The repository map changed the catalog, so reload it here too.
        if (message.type === 'reposChanged') {
          requestRepos('list');
          return;
        }

        if (message.type === 'reposResult') {
          if (message.requestId !== pendingReposRequestId) {
            return;
          }
          if (message.view) {
            renderRepos(message.view);
          }
          // A reload that works needs no message; failures and requested changes do.
          if (!message.success || pendingReposAction !== 'list') {
            showReposStatus(message.message);
          }
          return;
        }

        if (message.type === 'copyResult') {
          if (message.requestId === pendingCopyRequestId) {
            resultStatus.textContent = message.message;
            if (message.success) {
              used = true;
              saveState();
            }
          }
          return;
        }

        if (message.type === 'classificationResult') {
          if (message.requestId === pendingClassificationRequestId) {
            // Only the clarity hints update while typing; categories are shown after Refine.
            renderAnalysis(message.analysis);
          }
          return;
        }

        if (message.type === 'toolResult') {
          if (message.requestId !== pendingToolRequestId) {
            return;
          }

          if (message.tool === 'activeFile' || message.tool === 'editorSelection' || message.tool === 'diagnostics') {
            inputToolStatus.textContent = message.message;
          } else {
            resultStatus.textContent = message.message;
          }

          if (message.success && message.tool === 'openInEditor') {
            used = true;
            saveState();
          }

          if (message.success && message.tool === 'activeFile') {
            targetPath.value = message.value || '';
            invalidateContext(true);
            updateStats();
            saveState();
          }

          if (message.tool === 'diagnostics') {
            const withoutOldErrors = stripErrorBlock(rawPrompt.value);
            const removedOldBlock = withoutOldErrors !== rawPrompt.value.trim();
            rawPrompt.value = message.success
              ? (withoutOldErrors ? withoutOldErrors + '\\n\\n' : '') + 'Current errors:\\n' + (message.value || '')
              : withoutOldErrors;
            if (!message.success && removedOldBlock) {
              inputToolStatus.textContent = message.message + ' Removed the previous error block.';
            }
            if (message.success) {
              const count = errorBlockLines(rawPrompt.value);
              inputToolStatus.textContent = count + (count === 1 ? ' error' : ' errors')
                + (removedOldBlock ? ' attached, replacing the earlier block.' : ' attached to your description.');
            }
            invalidateContext(true);
            updateRefineAvailability();
            updateStats();
            requestCategoryClassification();
            saveState();
          }

          if (message.success && message.tool === 'editorSelection') {
            // Add to what the user already typed instead of replacing it.
            const typed = rawPrompt.value.trim();
            rawPrompt.value = (typed ? typed + '\\n\\n' : '') + (message.value || '');
            inputToolStatus.textContent = 'Selection appended to your description.';
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
          finishRefining();
          if (outputRevision !== outputRevisionAtRequest) {
            resultStatus.textContent = 'Output changed while refining; refine again to replace it.';
            showView('review');
            return;
          }

          refinedPrompt.value = message.refinedPrompt;
          addToHistory(pendingRawForHistory, message.refinedPrompt);
          outputRevision += 1;
          refinedSettings = settingsAtRequest;
          if (message.classification && category.value === 'auto') {
            renderCategory(message.classification);
          }
          resultStatus.textContent = 'Refined locally. Edit it here, then copy it or open it in the editor.';
          refinedFrom = pendingRawForHistory;
          originalPreview.textContent = refinedFrom;
          used = false;
          updateStats();
          // Bring the result into view; the original stays one click away under Edit Original.
          showView('review');
          return;
        }

        if (message.type === 'refineError') {
          finishRefining();
          inputError.textContent = message.message || 'Unable to refine this prompt.';
          inputError.hidden = false;
          resultStatus.textContent = '';
          showView('compose');
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

      renderHistory();
      originalPreview.textContent = refinedFrom;
      updateRefineAvailability();
      updateModeDescription();
      updateStats();
      requestCategoryClassification();
      // Restore the view the user left, without stealing focus.
      composeView.hidden = view !== 'compose';
      reviewView.hidden = view !== 'review';
      saveState();
      // Fill the workspace summary up front, so repository status is visible while composing.
      requestRepos('list');
    })();
  </script>
</body>
</html>`;
}

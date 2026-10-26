import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { handleWebviewRequest } from './messages';
import type { RepoCatalogService } from './repos';

/**
 * The repository map: an editor tab where repositories are nodes on a board. Drag a node to arrange it,
 * drag from its port onto another node to record a dependency, and pin file links between repositories.
 * Positions are saved per user; dependencies and links go to tokio.repos.json, where the router uses them.
 */

const MUTATING_ACTIONS = new Set([
  'grant', 'revoke', 'clearGrants', 'setDefault', 'add', 'remove',
  'addDependency', 'removeDependency', 'addLink', 'removeLink'
]);

/** How often the open map rereads the audit log to show which repository an agent is working in. */
const ACTIVITY_POLL_MS = 2_000;

export class RepositoryMapPanel {
  private static current: RepositoryMapPanel | undefined;
  private polling = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly service: RepoCatalogService,
    private readonly onChanged: () => void
  ) {
    panel.webview.html = getMapHtml(panel.webview.cspSource);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    // Changes made in the sidebar show up when the map comes back into view.
    panel.onDidChangeViewState(() => {
      if (panel.visible) {
        void panel.webview.postMessage({ type: 'reposChanged' });
      }
    });
    const timer = setInterval(() => {
      void this.postActivity();
    }, ACTIVITY_POLL_MS);
    panel.onDidDispose(() => {
      clearInterval(timer);
      RepositoryMapPanel.current = undefined;
    });
  }

  /** Skipped while hidden, and while the previous read is still running. */
  private async postActivity(): Promise<void> {
    if (!this.panel.visible || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const repos = await this.service.activity();
      await this.panel.webview.postMessage({ type: 'activity', repos });
    } catch {
      // No workspace or no catalog: the map shows its own error, and activity stays empty.
    } finally {
      this.polling = false;
    }
  }

  public static show(service: RepoCatalogService, onChanged: () => void): void {
    if (RepositoryMapPanel.current) {
      RepositoryMapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel('tokio.repositoryMap', 'Tokio: Repository Map', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    });
    RepositoryMapPanel.current = new RepositoryMapPanel(panel, service, onChanged);
  }

  /** Tells an open map that the catalog changed elsewhere, such as in the sidebar. */
  public static notifyChanged(): void {
    void RepositoryMapPanel.current?.panel.webview.postMessage({ type: 'reposChanged' });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const response = await handleWebviewRequest(message, { writeText: async () => {} }, undefined, undefined, this.service);
    if (!response) {
      return;
    }
    await this.panel.webview.postMessage(response);
    const action = (message as { action?: unknown }).action;
    if (response.type === 'reposResult' && response.success && typeof action === 'string' && MUTATING_ACTIONS.has(action)) {
      this.onChanged();
    }
  }
}

function getMapHtml(cspSource: string): string {
  const nonce = randomBytes(16).toString('hex');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Repository Map</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #1f1f1f);
      --surface: var(--vscode-editorWidget-background, #252526);
      --field: var(--vscode-input-background, #2a2a2a);
      --field-fg: var(--vscode-input-foreground, var(--text));
      --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.3)));
      --border-strong: var(--vscode-input-border, var(--border));
      --text: var(--vscode-foreground, #cccccc);
      --muted: var(--vscode-descriptionForeground, #9d9d9d);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-text: var(--vscode-textLink-foreground, #3794ff);
      --secondary: var(--vscode-button-secondaryBackground, #3a3d41);
      --secondary-fg: var(--vscode-button-secondaryForeground, var(--text));
      --secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
      --focus: var(--vscode-focusBorder, #007fd4);
      --ok: var(--vscode-testing-iconPassed, #73c991);
      --warn: var(--vscode-editorWarning-foreground, #cca700);
      --danger: var(--vscode-errorForeground, #f48771);
      --active: var(--vscode-charts-orange, #d18616);
      --edit: var(--vscode-charts-green, #89d185);
      --mono: var(--vscode-editor-font-family, monospace);
      --radius: 10px;
      --node-width: 230px;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      color: var(--text);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
      overflow: hidden;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 4px 11px;
      color: var(--accent-fg);
      background: var(--accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    button.secondary { color: var(--secondary-fg); background: var(--secondary); }
    button.secondary:hover:not(:disabled) { background: var(--secondary-hover); }
    button.ghost { border-color: var(--border-strong); color: var(--text); background: transparent; font-weight: 500; }
    button.ghost:hover:not(:disabled) { background: var(--hover); }
    button.compact { min-height: 24px; padding: 2px 8px; font-size: 0.88em; }
    button:focus-visible, .node:focus-visible { outline: 1px solid var(--focus); outline-offset: 2px; }
    input, select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      padding: 5px 8px;
      color: var(--field-fg);
      background: var(--field);
      font: inherit;
    }
    input:focus, select:focus { outline: 1px solid var(--focus); outline-offset: -1px; }
    label { font-weight: 600; font-size: 0.9em; }
    .hint { margin: 0; color: var(--muted); font-size: 0.86em; }
    [hidden] { display: none !important; }

    /* Toolbar */
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .toolbar h1 { margin: 0 6px 0 0; font-size: 1rem; }
    .spacer { flex: 1; }
    .add-menu { position: relative; }
    .add-button { width: 30px; min-height: 30px; padding: 0; border-radius: 50%; font-size: 1.2em; }
    .menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 20;
      display: grid;
      gap: 4px;
      min-width: 190px;
      padding: 6px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
    }
    .menu button { justify-content: flex-start; }
    .legend { display: flex; flex-wrap: wrap; gap: 10px; color: var(--muted); font-size: 0.82em; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .legend i { display: inline-block; width: 22px; border-top: 2px solid var(--muted); }
    .legend i.dep { border-top-color: var(--text); }
    .legend i.link { border-top-color: var(--accent-text); }
    .legend i.detected { border-top-style: dotted; }
    .legend i.live { border-top: 3px dotted var(--active); }
    .legend i.live.editing { border-top-color: var(--edit); }
    #status { min-height: 1.2em; }

    /* Board */
    .workspace { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 0; }
    /* The viewport clips; the board moves inside it with one transform, so pan and zoom stay cheap. */
    #viewport {
      position: relative;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      background-color: var(--bg);
      background-image: radial-gradient(color-mix(in srgb, var(--muted) 30%, transparent) 1px, transparent 1px);
      background-size: 16px 16px;
    }
    #viewport.panning { cursor: grabbing; }
    #board { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
    .canvas-controls {
      position: absolute;
      right: 12px;
      bottom: 12px;
      z-index: 15;
      display: flex;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
    }
    .canvas-controls button { min-width: 30px; }
    #zoom-reset { min-width: 54px; font-variant-numeric: tabular-nums; }
    .canvas-hint { position: absolute; left: 12px; bottom: 14px; z-index: 15; pointer-events: none; }
    .lines-menu { position: relative; }
    .lines-menu .menu { min-width: 230px; gap: 8px; padding: 10px; }
    .menu-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 8px; font-size: 0.88em; }
    .menu-row label { font-weight: 500; }
    .menu-check { display: flex; align-items: center; gap: 8px; font-size: 0.88em; }
    .menu-check input { width: auto; }
    /* Markers take their color from the svg, not the line, so the arrowheads follow this color. */
    #edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; color: color-mix(in srgb, var(--text) 75%, transparent); }
    #edge-paths path { fill: none; stroke-width: 2; }
    #arrow path { fill: currentColor; stroke: none; }
    #edges .dep { stroke: color-mix(in srgb, var(--text) 70%, transparent); }
    #edges .link { stroke: var(--accent-text); }
    /* Dash patterns come from the Lines settings, per connection kind. */
    #edges .detected { stroke: color-mix(in srgb, var(--muted) 80%, transparent); }
    #edge-paths path { stroke-linecap: round; }
    #edges .draft { stroke: var(--accent-text); stroke-dasharray: 6 4; }
    #edges .selected { stroke-width: 3.5; }
    /* Status lines: a missing repository's connectors break up in red; an agent's connectors light up and flow. */
    #edges path.missing { stroke: color-mix(in srgb, var(--danger) 70%, transparent); }
    #edges path.live { stroke: color-mix(in srgb, var(--active) 55%, transparent); }
    #edges path.flow {
      stroke: var(--active);
      stroke-width: 3;
      stroke-dasharray: 2 12;
      filter: drop-shadow(0 0 3px var(--active));
      animation: flow 0.9s linear infinite;
    }
    #edges path.live.editing { stroke: color-mix(in srgb, var(--edit) 55%, transparent); }
    #edges path.flow.editing { stroke: var(--edit); filter: drop-shadow(0 0 3px var(--edit)); }
    #edges path.flow.blocked { stroke: var(--danger); filter: drop-shadow(0 0 3px var(--danger)); }
    @keyframes flow { to { stroke-dashoffset: -14; } }
    .edge-label {
      position: absolute;
      z-index: 2;
      transform: translate(-50%, -50%);
      min-height: 22px;
      padding: 1px 9px;
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      color: var(--muted);
      background: var(--bg);
      font-size: 0.78em;
      font-weight: 500;
      white-space: nowrap;
    }
    .edge-label:hover:not(:disabled) { color: var(--text); background: var(--surface); }
    .edge-label[data-kind="link"] { border-color: color-mix(in srgb, var(--accent-text) 60%, transparent); color: var(--accent-text); }
    .edge-label[aria-pressed="true"] { border-color: var(--focus); color: var(--text); }

    .node {
      --node-color: var(--muted);
      position: absolute;
      z-index: 3;
      display: grid;
      gap: 8px;
      width: var(--node-width);
      padding: 10px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: 0 3px 12px rgba(0, 0, 0, 0.28);
      user-select: none;
      touch-action: none;
    }
    .node[data-access="write"] {
      --node-color: var(--ok);
      border-color: color-mix(in srgb, var(--ok) 70%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--ok) 25%, transparent), 0 0 16px color-mix(in srgb, var(--ok) 24%, transparent);
    }
    .node[data-access="granted"] { --node-color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
    .node[data-access="missing"] { --node-color: var(--danger); border-style: dashed; border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
    /* Agent activity, from the audit log. Working and blocked glow; recent keeps a soft border. */
    .node[data-activity="working"] { --glow: var(--active); border-color: var(--active); animation: node-glow 1.6s ease-in-out infinite; }
    .node[data-activity="blocked"] { --glow: var(--danger); border-color: var(--danger); animation: node-glow 1.6s ease-in-out infinite; }
    .node[data-activity="recent"] { border-color: color-mix(in srgb, var(--active) 45%, var(--border-strong)); }
    @keyframes node-glow {
      0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--glow) 35%, transparent), 0 0 10px color-mix(in srgb, var(--glow) 25%, transparent); }
      50% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--glow) 60%, transparent), 0 0 26px color-mix(in srgb, var(--glow) 55%, transparent); }
    }
    .activity { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted); font-size: 0.78em; }
    .activity[hidden] { display: none; }
    .activity::before { content: ''; width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: currentColor; }
    .node[data-activity="working"][data-action="editing"] { --glow: var(--edit); border-color: var(--edit); }
    .node[data-activity="working"] .activity { color: var(--glow); }
    .node[data-activity="blocked"] .activity { color: var(--danger); }
    .node[data-activity="working"] .activity::before, .node[data-activity="blocked"] .activity::before { animation: blink 1s ease-in-out infinite; }
    @keyframes blink { 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) {
      .node[data-activity], .activity::before, #edges path.flow { animation: none !important; }
      .node[data-activity="working"], .node[data-activity="blocked"] { box-shadow: 0 0 0 2px color-mix(in srgb, var(--glow) 60%, transparent), 0 0 18px color-mix(in srgb, var(--glow) 45%, transparent); }
    }
    .node[aria-selected="true"] { outline: 2px solid var(--focus); outline-offset: 2px; }
    .node.dragging { cursor: grabbing; opacity: 0.92; z-index: 10; }
    .node.drop-target { outline: 2px dashed var(--accent-text); outline-offset: 3px; }
    .node-head { display: flex; align-items: center; gap: 10px; min-width: 0; cursor: grab; }
    .tile {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border-radius: 8px;
      color: var(--node-color);
      background: color-mix(in srgb, var(--node-color) 16%, var(--field));
      font-size: 0.78em;
      font-weight: 800;
    }
    .node-copy { display: grid; min-width: 0; flex: 1; }
    .node-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: var(--mono); font-size: 0.8em; }
    .dot { width: 9px; height: 9px; flex: 0 0 9px; align-self: flex-start; margin-top: 3px; border-radius: 50%; background: var(--node-color); box-shadow: 0 0 6px var(--node-color); }
    .node[data-access="read"] .dot { background: transparent; border: 1.5px solid var(--muted); box-shadow: none; }
    .chip {
      justify-self: start;
      padding: 1px 8px;
      border: 1px solid color-mix(in srgb, var(--node-color) 55%, transparent);
      border-radius: 999px;
      color: var(--node-color);
      font-size: 0.78em;
      line-height: 1.6;
    }
    .node[data-access="write"] .chip { color: var(--accent-text); border-color: color-mix(in srgb, var(--accent-text) 50%, transparent); background: color-mix(in srgb, var(--accent-text) 12%, transparent); }
    /* The port: drag it onto another node to record that this one depends on that one. */
    .port {
      position: absolute;
      right: -8px;
      top: 50%;
      width: 16px;
      height: 16px;
      margin-top: -8px;
      border: 2px solid var(--accent-text);
      border-radius: 50%;
      background: var(--bg);
      cursor: crosshair;
    }
    .port:hover { background: var(--accent-text); }

    .empty-board { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--muted); }

    /* Inspector */
    #inspector {
      display: grid;
      align-content: start;
      gap: 12px;
      width: 320px;
      max-height: 100%;
      overflow: auto;
      padding: 14px;
      border-left: 1px solid var(--border);
      background: var(--surface);
    }
    /* Collapsed, the canvas takes the inspector's column. */
    .workspace.details-collapsed #inspector { display: none; }
    #details-toggle[aria-pressed="true"] { background: var(--hover); }
    #inspector h2 { margin: 0; font-size: 0.98rem; }
    #inspector h3 { margin: 4px 0 0; font-size: 0.88em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .inspector-head { display: flex; align-items: center; gap: 8px; }
    .inspector-head h2 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .pair-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .pair-list li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
      align-items: center;
      padding: 7px 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--field);
      font-size: 0.86em;
    }
    .pair-list code { grid-column: 1; overflow-wrap: anywhere; font-family: var(--mono); font-size: 0.95em; }
    .pair-list .meta { grid-column: 1; color: var(--muted); }
    .pair-list button { grid-column: 2; grid-row: 1 / span 3; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .hours-select { width: auto; min-height: 24px; padding: 2px 6px; font-size: 0.88em; }
    .form { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
    .end-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 6px; }
    .error { color: var(--danger); }
  </style>
</head>
<body>
  <header class="toolbar">
    <h1>Repository Map</h1>
    <div class="add-menu">
      <button id="add-button" class="add-button" type="button" title="Add" aria-haspopup="true" aria-expanded="false">+</button>
      <div id="add-menu" class="menu" role="menu" hidden>
        <button id="add-repo" class="ghost compact" type="button" role="menuitem">Add Repository…</button>
        <button id="add-link" class="ghost compact" type="button" role="menuitem">Add File Link…</button>
      </div>
    </div>
    <button id="auto-layout" class="ghost compact" type="button" title="Arrange nodes automatically">Auto Layout</button>
    <div class="lines-menu">
      <button id="lines-button" class="ghost compact" type="button" aria-haspopup="true" aria-expanded="false" title="Connector shape and line styles">Lines ▾</button>
      <div id="lines-panel" class="menu" hidden>
        <div class="menu-row">
          <label for="line-shape">Shape</label>
          <select id="line-shape">
            <option value="curved">Curved</option>
            <option value="straight">Straight</option>
            <option value="step">Step</option>
          </select>
        </div>
        <div class="menu-row">
          <label for="line-dependency">Depends on</label>
          <select id="line-dependency" data-kind="dependency"></select>
        </div>
        <div class="menu-row">
          <label for="line-link">File links</label>
          <select id="line-link" data-kind="link"></select>
        </div>
        <div class="menu-row">
          <label for="line-detected">Detected</label>
          <select id="line-detected" data-kind="detected"></select>
        </div>
        <label class="menu-check"><input id="snap-grid" type="checkbox"> Snap nodes to the grid</label>
      </div>
    </div>
    <button id="refresh" class="ghost compact" type="button">Refresh</button>
    <button id="details-toggle" class="ghost compact" type="button" aria-controls="inspector" aria-pressed="true" title="Hide details (D)">Details</button>
    <div class="legend" aria-label="Legend">
      <span><i class="dep"></i>depends on</span>
      <span><i class="link"></i>file links</span>
      <span><i class="detected"></i>detected imports</span>
      <span><i class="live"></i>agent reading</span>
      <span><i class="live editing"></i>agent editing</span>
    </div>
    <span class="spacer"></span>
    <p id="status" class="hint" role="status" aria-live="polite"></p>
  </header>

  <div class="workspace">
    <div id="viewport" tabindex="-1" aria-label="Repository canvas">
      <div class="canvas-controls" aria-label="View controls">
        <button id="zoom-out" class="ghost compact" type="button" title="Zoom out (−)" aria-label="Zoom out">−</button>
        <button id="zoom-reset" class="ghost compact" type="button" title="Reset to 100% (0)">100%</button>
        <button id="zoom-in" class="ghost compact" type="button" title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button id="zoom-fit" class="ghost compact" type="button" title="Fit every repository in view (F)">Fit</button>
      </div>
      <p class="canvas-hint hint">Ctrl + wheel to zoom · drag empty space or hold Space to pan</p>
      <div id="board">
        <svg id="edges" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
            </marker>
          </defs>
          <g id="edge-paths"></g>
        </svg>
        <div id="edge-labels"></div>
        <div id="nodes"></div>
        <div id="empty-board" class="empty-board" hidden>
          <div>
            <p>No repositories yet.</p>
            <p class="hint">Use + to add one.</p>
          </div>
        </div>
      </div>
    </div>

    <aside id="inspector" aria-label="Details">
      <div id="inspector-empty">
        <div class="inspector-head">
          <h2>Map your workspace</h2>
          <button id="details-collapse" class="ghost compact" type="button" title="Hide details (D)" aria-label="Hide details">»</button>
        </div>
        <p class="hint">Drag a node to arrange it. Drag a node's ● port onto another node to record a dependency. Click a connection to see its file links.</p>
      </div>
      <div id="inspector-body" hidden></div>
      <form id="link-form" class="form" hidden novalidate>
        <h2>Add file link</h2>
        <p class="hint">Pin a contract imports cannot reveal, such as an API route and the code that calls it.</p>
        <label for="link-from-path">From</label>
        <div class="end-row">
          <select id="link-from-repo" aria-label="From repository"></select>
          <input id="link-from-path" type="text" placeholder="src/api/upload.ts" autocomplete="off">
          <button id="link-from-pick" class="ghost compact" type="button">Pick…</button>
        </div>
        <label for="link-to-path">To</label>
        <div class="end-row">
          <select id="link-to-repo" aria-label="To repository"></select>
          <input id="link-to-path" type="text" placeholder="routes/api.php" autocomplete="off">
          <button id="link-to-pick" class="ghost compact" type="button">Pick…</button>
        </div>
        <label for="link-kind">Kind</label>
        <select id="link-kind">
          <option value="api">API</option>
          <option value="type">Shared type</option>
          <option value="event">Event</option>
          <option value="schema">Schema</option>
          <option value="config">Config</option>
          <option value="other">Other</option>
        </select>
        <label for="link-note">Note <span class="hint">optional</span></label>
        <input id="link-note" type="text" maxlength="200" placeholder="POST /users/{id}/avatar" autocomplete="off">
        <p id="link-error" class="hint error" role="alert"></p>
        <div class="actions">
          <button id="link-save" type="submit">Save Link</button>
          <button id="link-cancel" class="ghost" type="button">Cancel</button>
        </div>
      </form>
    </aside>
  </div>

  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const SVG = 'http' + '://www.w3.org/2000/svg';
      const NODE_WIDTH = 230;
      const NODE_HEIGHT = 92;
      const viewport = document.getElementById('viewport');
      const board = document.getElementById('board');
      const edgePaths = document.getElementById('edge-paths');
      const edgeLabels = document.getElementById('edge-labels');
      const nodesLayer = document.getElementById('nodes');
      const emptyBoard = document.getElementById('empty-board');
      const statusLine = document.getElementById('status');
      const addButton = document.getElementById('add-button');
      const addMenu = document.getElementById('add-menu');
      const inspectorEmpty = document.getElementById('inspector-empty');
      const inspectorBody = document.getElementById('inspector-body');
      const linkForm = document.getElementById('link-form');
      const linkFromRepo = document.getElementById('link-from-repo');
      const linkFromPath = document.getElementById('link-from-path');
      const linkToRepo = document.getElementById('link-to-repo');
      const linkToPath = document.getElementById('link-to-path');
      const linkKind = document.getElementById('link-kind');
      const linkNote = document.getElementById('link-note');
      const linkError = document.getElementById('link-error');
      const workspace = document.querySelector('.workspace');
      const detailsToggle = document.getElementById('details-toggle');

      let graph = null;
      let positions = {};
      let grantHours = 4;
      let selection = null;
      // Agent activity per repository name, from the host's audit log poll.
      let activity = {};
      let activityKey = '';
      let requestId = 0;
      const pending = new Map();
      let saveTimer;

      // View: the board is scaled by zoom and moved by pan, in viewport pixels.
      const MIN_ZOOM = 0.25;
      const MAX_ZOOM = 2;
      const GRID = 16;
      const DASHES = { solid: '', dashed: '8 6', dotted: '0.5 6', longdash: '16 7' };
      const STYLE_LABELS = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted', longdash: 'Long dash' };
      let zoom = 1;
      let pan = { x: 0, y: 0 };
      let settings = { shape: 'curved', styles: { dependency: 'solid', link: 'dashed', detected: 'dotted' }, snap: false };
      let spaceHeld = false;
      const restored = vscode.getState();
      let viewRestored = Boolean(restored && restored.view);
      if (viewRestored) {
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(restored.view.zoom) || 1));
        pan = { x: Number(restored.view.x) || 0, y: Number(restored.view.y) || 0 };
      }
      let detailsOpen = !(restored && restored.detailsOpen === false);
      const saveState = () => vscode.setState({ view: { zoom, x: pan.x, y: pan.y }, detailsOpen });
      const zoomLabel = document.getElementById('zoom-reset');

      const applyView = () => {
        board.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
        // The dot grid scales and moves with the board, so it reads as the board's surface.
        viewport.style.backgroundSize = (GRID * zoom) + 'px ' + (GRID * zoom) + 'px';
        viewport.style.backgroundPosition = pan.x + 'px ' + pan.y + 'px';
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
        saveState();
      };

      // Details: the inspector collapses to give the canvas its width. Selecting something opens it again.
      const setDetailsOpen = (open) => {
        detailsOpen = open;
        workspace.classList.toggle('details-collapsed', !open);
        detailsToggle.setAttribute('aria-pressed', String(open));
        detailsToggle.title = open ? 'Hide details (D)' : 'Show details (D)';
        saveState();
      };
      setDetailsOpen(detailsOpen);
      detailsToggle.addEventListener('click', () => setDetailsOpen(!detailsOpen));
      document.getElementById('details-collapse').addEventListener('click', () => setDetailsOpen(false));

      // A pointer position in board coordinates.
      const toBoard = (clientX, clientY) => {
        const rect = viewport.getBoundingClientRect();
        return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
      };

      // Zoom toward a point on screen, keeping that point still. Without one, zoom toward the center.
      const zoomTo = (next, clientX, clientY) => {
        const rect = viewport.getBoundingClientRect();
        const anchorX = (clientX === undefined ? rect.left + rect.width / 2 : clientX) - rect.left;
        const anchorY = (clientY === undefined ? rect.top + rect.height / 2 : clientY) - rect.top;
        const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        pan = { x: anchorX - (anchorX - pan.x) * (target / zoom), y: anchorY - (anchorY - pan.y) * (target / zoom) };
        zoom = target;
        applyView();
      };

      const fitView = () => {
        const names = Object.keys(positions);
        if (names.length === 0) return;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        names.forEach((name) => {
          const box = center(name);
          left = Math.min(left, box.x - box.width / 2);
          top = Math.min(top, box.y - box.height / 2);
          right = Math.max(right, box.x + box.width / 2);
          bottom = Math.max(bottom, box.y + box.height / 2);
        });
        const margin = 60;
        const width = right - left + margin * 2;
        const height = bottom - top + margin * 2;
        zoom = Math.min(1.25, Math.max(MIN_ZOOM, Math.min(viewport.clientWidth / width, viewport.clientHeight / height)));
        pan = {
          x: (viewport.clientWidth - (right - left) * zoom) / 2 - left * zoom,
          y: (viewport.clientHeight - (bottom - top) * zoom) / 2 - top * zoom
        };
        applyView();
      };

      const snapped = (value) => (settings.snap ? Math.round(value / GRID) * GRID : Math.round(value));

      // Capture keeps a drag alive when the pointer leaves the element. Some inputs cannot be
      // captured; the drag still works then, as long as the pointer stays over the element.
      const capture = (target, pointerId) => {
        try {
          target.setPointerCapture(pointerId);
        } catch (error) {
          // Not capturable; carry on uncaptured.
        }
      };

      const request = (action, params, onResult) => {
        requestId += 1;
        pending.set(requestId, onResult || (() => {}));
        vscode.postMessage(Object.assign({ type: 'repos', requestId, action }, params || {}));
      };
      const setStatus = (text) => { statusLine.textContent = text || ''; };
      const element = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const initials = (name) => {
        const parts = name.split(/[-_.\\s]+/).filter(Boolean);
        return ((parts[0] || '?').charAt(0) + (parts[1] || parts[0] || '').charAt(parts[1] ? 0 : 1)).toUpperCase();
      };
      const repoOf = (end) => end.slice(0, end.indexOf(':'));
      const pathOf = (end) => end.slice(end.indexOf(':') + 1);
      const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

      const loadGraph = () => {
        setStatus('Reading the workspace…');
        request('graph', {}, (message) => {
          if (!message.graph) {
            setStatus(message.message || 'Could not read tokio.repos.json.');
            return;
          }
          graph = message.graph;
          positions = Object.assign(autoLayout(graph, {}), graph.layout || {});
          settings = graph.settings || settings;
          applySettings();
          setStatus('');
          render();
          // The first time the map opens, frame every repository.
          if (!viewRestored) {
            viewRestored = true;
            fitView();
          }
        });
      };

      // Default layout: the write target first, then what it depends on, then the rest, in rows.
      const autoLayout = (data, keep) => {
        const root = data.repos.find((repo) => repo.name === data.defaultRepo);
        const deps = root ? root.dependsOn : [];
        const ordered = data.repos.slice().sort((left, right) => {
          const rank = (repo) => (repo.name === data.defaultRepo ? 0 : deps.includes(repo.name) ? 1 : 2);
          return rank(left) - rank(right);
        });
        const result = {};
        // Gaps wide enough for a connector label between neighbours.
        const columnStep = NODE_WIDTH + 150;
        const rowStep = NODE_HEIGHT + 120;
        const perRow = Math.max(1, Math.floor((viewport.clientWidth - 60) / columnStep));
        ordered.forEach((repo, index) => {
          if (keep[repo.name]) {
            result[repo.name] = keep[repo.name];
            return;
          }
          const slot = index === 0 ? 0 : index - 1;
          const row = index === 0 ? 0 : 1 + Math.floor(slot / perRow);
          const column = index === 0 ? 0 : slot % perRow;
          result[repo.name] = { x: 40 + column * columnStep, y: 40 + row * rowStep };
        });
        return result;
      };

      // Connections per repository pair, combining dependsOn, declared links, and detected imports.
      const connections = () => {
        const byPair = new Map();
        const entry = (a, b) => {
          const key = pairKey(a, b);
          if (!byPair.has(key)) {
            byPair.set(key, { key, a: a < b ? a : b, b: a < b ? b : a, dependency: null, links: [], detected: [] });
          }
          return byPair.get(key);
        };
        graph.repos.forEach((repo) => repo.dependsOn.forEach((target) => {
          entry(repo.name, target).dependency = { from: repo.name, to: target };
        }));
        graph.links.forEach((link) => entry(repoOf(link.from), repoOf(link.to)).links.push(link));
        graph.detected.forEach((link) => entry(repoOf(link.from), repoOf(link.to)).detected.push(link));
        return Array.from(byPair.values());
      };

      const center = (name) => {
        const position = positions[name] || { x: 0, y: 0 };
        const node = nodesLayer.querySelector('[data-name="' + CSS.escape(name) + '"]');
        const height = node ? node.offsetHeight : NODE_HEIGHT;
        return { x: position.x + NODE_WIDTH / 2, y: position.y + height / 2, width: NODE_WIDTH, height };
      };

      // Where the line from one node's center toward another leaves the node's box.
      const boxExit = (from, to) => {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
        const scale = Math.min(Math.abs((from.width / 2 + 6) / (dx || 1e-9)), Math.abs((from.height / 2 + 6) / (dy || 1e-9)));
        return { x: from.x + dx * scale, y: from.y + dy * scale };
      };

      // The side of a node a connector leaves from, facing the other node, with the direction it leaves in.
      const sideAnchor = (box, toward) => {
        const dx = toward.x - box.x;
        const dy = toward.y - box.y;
        if (Math.abs(dx) * box.height >= Math.abs(dy) * box.width) {
          const sign = dx >= 0 ? 1 : -1;
          return { x: box.x + sign * (box.width / 2 + 6), y: box.y, dx: sign, dy: 0 };
        }
        const sign = dy >= 0 ? 1 : -1;
        return { x: box.x, y: box.y + sign * (box.height / 2 + 6), dx: 0, dy: sign };
      };

      // A connector between two boxes in the chosen shape, with the point where its label sits.
      const routeEdge = (from, to) => {
        if (settings.shape === 'straight') {
          const start = boxExit(from, to);
          const end = boxExit(to, from);
          return { d: 'M ' + start.x + ' ' + start.y + ' L ' + end.x + ' ' + end.y, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
        }
        const start = sideAnchor(from, to);
        const end = sideAnchor(to, from);
        if (settings.shape === 'step') {
          if (start.dx !== 0) {
            const middleX = (start.x + end.x) / 2;
            return { d: 'M ' + start.x + ' ' + start.y + ' H ' + middleX + ' V ' + end.y + ' H ' + end.x, mid: { x: middleX, y: (start.y + end.y) / 2 } };
          }
          const middleY = (start.y + end.y) / 2;
          return { d: 'M ' + start.x + ' ' + start.y + ' V ' + middleY + ' H ' + end.x + ' V ' + end.y, mid: { x: (start.x + end.x) / 2, y: middleY } };
        }
        // Curved: a cubic bezier that leaves and enters each node straight out of its side.
        const reach = Math.max(40, Math.hypot(end.x - start.x, end.y - start.y) / 2.4);
        const c1 = { x: start.x + start.dx * reach, y: start.y + start.dy * reach };
        const c2 = { x: end.x + end.dx * reach, y: end.y + end.dy * reach };
        const at = (a, b, c, d) => 0.125 * a + 0.375 * b + 0.375 * c + 0.125 * d;
        return {
          d: 'M ' + start.x + ' ' + start.y + ' C ' + c1.x + ' ' + c1.y + ', ' + c2.x + ' ' + c2.y + ', ' + end.x + ' ' + end.y,
          mid: { x: at(start.x, c1.x, c2.x, end.x), y: at(start.y, c1.y, c2.y, end.y) }
        };
      };

      const drawEdges = () => {
        edgePaths.replaceChildren();
        edgeLabels.replaceChildren();
        if (!graph) return;
        const missing = new Set(graph.repos.filter((repo) => repo.missing).map((repo) => repo.name));
        const live = (name) => activity[name] && activity[name].state !== 'recent';
        connections().forEach((connection) => {
          const fromName = connection.dependency ? connection.dependency.from : connection.a;
          const toName = connection.dependency ? connection.dependency.to : connection.b;
          const route = routeEdge(center(fromName), center(toName));
          const kind = connection.links.length > 0 ? 'link' : connection.dependency ? 'dep' : 'detected';
          const style = settings.styles[kind === 'dep' ? 'dependency' : kind];
          const broken = missing.has(fromName) || missing.has(toName);
          const flowing = !broken && (live(fromName) || live(toName));
          const classes = [kind];
          if (selection && selection.type === 'edge' && selection.key === connection.key) classes.push('selected');
          if (broken) classes.push('missing');
          if (flowing) classes.push('live');
          const path = document.createElementNS(SVG, 'path');
          path.setAttribute('d', route.d);
          path.setAttribute('class', classes.join(' '));
          // A missing end overrides the chosen style: the line is broken, whatever its kind.
          const dashes = broken ? DASHES.dashed : DASHES[style];
          if (dashes) {
            path.setAttribute('stroke-dasharray', dashes);
          }
          if (connection.dependency) {
            path.setAttribute('marker-end', 'url(#arrow)');
          }
          edgePaths.appendChild(path);
          if (flowing) {
            // Dots run along the line, from the depending repository toward the one it depends on.
            const flow = document.createElementNS(SVG, 'path');
            flow.setAttribute('d', route.d);
            const ends = [fromName, toName].map((name) => activity[name]).filter(Boolean);
            const blocked = ends.some((entry) => entry.state === 'blocked');
            const editing = ends.some((entry) => entry.state === 'working' && entry.action === 'editing');
            flow.setAttribute('class', 'flow' + (blocked ? ' blocked' : editing ? ' editing' : ''));
            if (editing && !blocked) path.classList.add('editing');
            edgePaths.appendChild(flow);
          }
          const start = route.mid;
          const end = route.mid;

          const parts = [];
          if (connection.dependency) parts.push('depends on');
          if (connection.links.length > 0) parts.push(connection.links.length + (connection.links.length === 1 ? ' link' : ' links'));
          if (connection.detected.length > 0) parts.push(connection.detected.length + ' detected');
          const label = element('button', 'edge-label', parts.join(' · '));
          label.type = 'button';
          label.dataset.kind = kind;
          label.style.left = (start.x + end.x) / 2 + 'px';
          label.style.top = (start.y + end.y) / 2 + 'px';
          label.title = connection.a + ' ↔ ' + connection.b;
          label.setAttribute('aria-pressed', String(Boolean(selection && selection.type === 'edge' && selection.key === connection.key)));
          label.addEventListener('click', () => select({ type: 'edge', key: connection.key }));
          edgeLabels.appendChild(label);
        });
      };

      const sizeBoard = () => {
        let width = 0;
        let height = 0;
        Object.values(positions).forEach((position) => {
          width = Math.max(width, position.x + NODE_WIDTH + 200);
          height = Math.max(height, position.y + NODE_HEIGHT + 200);
        });
        board.style.width = Math.max(width, viewport.clientWidth) + 'px';
        board.style.height = Math.max(height, viewport.clientHeight) + 'px';
      };

      const renderNodes = () => {
        nodesLayer.replaceChildren();
        emptyBoard.hidden = graph.repos.length > 0;
        graph.repos.forEach((repo) => {
          const state = repo.missing ? 'missing' : repo.access;
          const node = element('div', 'node');
          node.dataset.name = repo.name;
          node.dataset.access = state;
          node.tabIndex = 0;
          node.setAttribute('role', 'button');
          node.setAttribute('aria-selected', String(Boolean(selection && selection.type === 'node' && selection.name === repo.name)));
          const position = positions[repo.name] || { x: 40, y: 40 };
          node.style.left = position.x + 'px';
          node.style.top = position.y + 'px';

          const head = element('div', 'node-head');
          const tile = element('span', 'tile', initials(repo.name));
          const copy = element('div', 'node-copy');
          copy.append(element('strong', '', repo.name), element('span', '', repo.path));
          copy.title = repo.path + (repo.purpose ? ' · ' + repo.purpose : '');
          head.append(tile, copy, element('span', 'dot'));
          const chip = element('span', 'chip', state === 'write' ? 'write target' : state === 'granted' ? 'edits allowed' : state === 'missing' ? 'missing' : 'read-only');
          const port = element('span', 'port');
          port.title = 'Drag onto another repository: ' + repo.name + ' depends on it';
          node.append(head, chip, element('span', 'activity'), port);
          setNodeActivity(node, repo, state);

          head.addEventListener('pointerdown', (event) => startDrag(event, node, repo.name));
          port.addEventListener('pointerdown', (event) => startLink(event, repo.name));
          node.addEventListener('click', (event) => {
            if (!node.dataset.moved) select({ type: 'node', name: repo.name });
            delete node.dataset.moved;
            event.stopPropagation();
          });
          node.addEventListener('keydown', (event) => nudge(event, repo.name));
          nodesLayer.appendChild(node);
        });
      };

      const activityText = (entry) => {
        const what = entry.file ? entry.tool + ' ' + entry.file : entry.tool;
        if (entry.state === 'working') return 'Agent ' + (entry.action || 'working') + ' · ' + what;
        if (entry.state === 'blocked') return 'Blocked · ' + what;
        const minutes = Math.floor(entry.ageMs / 60000);
        return 'Used ' + (minutes < 1 ? 'under a minute' : minutes + ' min') + ' ago';
      };

      // Activity changes the card in place, so a drag in progress keeps its node.
      function setNodeActivity(node, repo, state) {
        const entry = activity[repo.name];
        const line = node.querySelector('.activity');
        line.hidden = !entry;
        line.textContent = entry ? activityText(entry) : '';
        if (entry) {
          node.dataset.activity = entry.state;
          node.dataset.action = entry.action || 'reading';
        } else {
          delete node.dataset.activity;
          delete node.dataset.action;
        }
        node.setAttribute('aria-label', repo.name + ', ' + (state === 'write' ? 'write target' : state) + (entry ? ', ' + activityText(entry) : ''));
      }

      const applyActivity = (repos) => {
        const next = {};
        (Array.isArray(repos) ? repos : []).forEach((entry) => { next[entry.repo] = entry; });
        // Redraw only on a visible change; redrawing restarts the line and glow animations.
        const key = JSON.stringify(Object.keys(next).sort().map((name) => [name, activityText(next[name]), next[name].state]));
        if (key === activityKey) return;
        activityKey = key;
        activity = next;
        if (!graph) return;
        graph.repos.forEach((repo) => {
          const node = nodesLayer.querySelector('[data-name="' + CSS.escape(repo.name) + '"]');
          if (node) setNodeActivity(node, repo, repo.missing ? 'missing' : repo.access);
        });
        drawEdges();
      };

      const render = () => {
        if (!graph) return;
        sizeBoard();
        renderNodes();
        drawEdges();
        renderInspector();
      };

      const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => request('saveLayout', { positions, settings }), 300);
      };

      // Drag a node by its header. A short press is a click, so it selects instead.
      const startDrag = (event, node, name) => {
        // With Space held, the canvas pans instead.
        if (event.button !== 0 || spaceHeld) return;
        event.preventDefault();
        const origin = { x: event.clientX, y: event.clientY };
        const start = Object.assign({}, positions[name]);
        let moved = false;
        capture(node, event.pointerId);
        const move = (moveEvent) => {
          // Screen pixels to board pixels, so a node follows the pointer at any zoom.
          const dx = (moveEvent.clientX - origin.x) / zoom;
          const dy = (moveEvent.clientY - origin.y) / zoom;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 4 / zoom) return;
          moved = true;
          node.classList.add('dragging');
          positions[name] = { x: Math.max(0, snapped(start.x + dx)), y: Math.max(0, snapped(start.y + dy)) };
          node.style.left = positions[name].x + 'px';
          node.style.top = positions[name].y + 'px';
          drawEdges();
        };
        const up = () => {
          node.removeEventListener('pointermove', move);
          node.removeEventListener('pointerup', up);
          node.classList.remove('dragging');
          if (moved) {
            node.dataset.moved = 'true';
            sizeBoard();
            scheduleSave();
          }
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
      };

      const nudge = (event, name) => {
        const unit = settings.snap ? GRID : 10;
        const steps = { ArrowLeft: [-unit, 0], ArrowRight: [unit, 0], ArrowUp: [0, -unit], ArrowDown: [0, unit] };
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select({ type: 'node', name });
          return;
        }
        const step = steps[event.key];
        if (!step) return;
        event.preventDefault();
        const position = positions[name];
        positions[name] = { x: Math.max(0, position.x + step[0]), y: Math.max(0, position.y + step[1]) };
        render();
        const node = nodesLayer.querySelector('[data-name="' + CSS.escape(name) + '"]');
        if (node) node.focus();
        scheduleSave();
      };

      // Drag from a port onto another node to record "from depends on to".
      const startLink = (event, from) => {
        if (event.button !== 0 || spaceHeld) return;
        event.preventDefault();
        event.stopPropagation();
        const draft = document.createElementNS(SVG, 'path');
        draft.setAttribute('class', 'draft');
        edgePaths.appendChild(draft);
        const origin = center(from);
        let target = null;
        const boardPoint = (pointer) => toBoard(pointer.clientX, pointer.clientY);
        const move = (moveEvent) => {
          const point = boardPoint(moveEvent);
          draft.setAttribute('d', 'M ' + (origin.x + NODE_WIDTH / 2) + ' ' + origin.y + ' L ' + point.x + ' ' + point.y);
          const hit = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
          const over = hit && hit.closest ? hit.closest('.node') : null;
          if (target && target !== over) target.classList.remove('drop-target');
          target = over && over.dataset.name !== from ? over : null;
          if (target) target.classList.add('drop-target');
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          draft.remove();
          if (!target) return;
          target.classList.remove('drop-target');
          const to = target.dataset.name;
          request('addDependency', { from, to }, (message) => {
            setStatus(message.message);
            if (message.success) loadGraph();
          });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      };

      const select = (next) => {
        selection = next;
        if (next && !detailsOpen) setDetailsOpen(true);
        linkForm.hidden = true;
        render();
      };

      const listItem = (code, meta, button) => {
        const item = element('li');
        item.append(element('code', '', code));
        if (meta) item.append(element('span', 'meta', meta));
        if (button) item.append(button);
        return item;
      };
      const smallButton = (label, className, onClick) => {
        const button = element('button', className + ' compact', label);
        button.type = 'button';
        button.addEventListener('click', onClick);
        return button;
      };
      const mutate = (action, params) => request(action, params, (message) => {
        setStatus(message.message);
        if (message.success || message.view) loadGraph();
      });

      const renderInspector = () => {
        inspectorBody.replaceChildren();
        if (!selection || !graph) {
          inspectorEmpty.hidden = false;
          inspectorBody.hidden = true;
          return;
        }
        inspectorEmpty.hidden = true;
        inspectorBody.hidden = false;
        const head = element('div', 'inspector-head');
        const close = smallButton('×', 'ghost', () => select(null));
        close.setAttribute('aria-label', 'Close details');

        if (selection.type === 'node') {
          const repo = graph.repos.find((candidate) => candidate.name === selection.name);
          if (!repo) { select(null); return; }
          head.append(element('h2', '', repo.name), close);
          inspectorBody.append(head, element('p', 'hint', repo.path + (repo.purpose ? ' · ' + repo.purpose : '')));
          const actions = element('div', 'actions');
          if (repo.access !== 'write') {
            if (!repo.missing) {
              if (repo.access === 'granted') {
                actions.append(smallButton('Revoke Edits', 'secondary', () => mutate('revoke', { name: repo.name })));
              } else {
                // Same choices as the sidebar's picker; the last one is remembered while the map is open.
                const hours = element('select', 'hours-select');
                hours.setAttribute('aria-label', 'Allow edits for');
                [1, 2, 4, 8, 24].forEach((value) => {
                  const option = element('option', '', value + (value === 1 ? ' hour' : ' hours'));
                  option.value = String(value);
                  option.selected = value === grantHours;
                  hours.append(option);
                });
                hours.addEventListener('change', () => { grantHours = Number(hours.value); });
                actions.append(hours, smallButton('Allow Edits', 'secondary', () => mutate('grant', { name: repo.name, hours: grantHours })));
              }
            }
            actions.append(
              smallButton('Make Write Target', 'ghost', () => mutate('setDefault', { name: repo.name })),
              smallButton('Remove', 'ghost', () => mutate('remove', { name: repo.name }))
            );
          } else {
            actions.append(element('span', 'hint', 'Write target: the agent edits here.'));
          }
          actions.append(smallButton('+ File Link', 'ghost', () => openLinkForm(repo.name, null)));
          inspectorBody.append(actions);

          const mine = graph.links.filter((link) => repoOf(link.from) === repo.name || repoOf(link.to) === repo.name);
          inspectorBody.append(element('h3', '', 'File links (' + mine.length + ')'));
          const list = element('ul', 'pair-list');
          mine.forEach((link) => list.append(listItem(link.from + '  →  ' + link.to, link.kind + (link.note ? ' · ' + link.note : ''),
            smallButton('Remove', 'ghost', () => mutate('removeLink', { from: link.from, to: link.to })))));
          if (mine.length === 0) list.append(element('p', 'hint', 'None yet. Use + File Link.'));
          inspectorBody.append(list);
          return;
        }

        const connection = connections().find((candidate) => candidate.key === selection.key);
        if (!connection) { select(null); return; }
        head.append(element('h2', '', connection.a + ' ↔ ' + connection.b), close);
        inspectorBody.append(head);

        inspectorBody.append(element('h3', '', 'Dependency'));
        if (connection.dependency) {
          const dependency = connection.dependency;
          const list = element('ul', 'pair-list');
          list.append(listItem(dependency.from + ' depends on ' + dependency.to, 'merge ' + dependency.to + ' first',
            smallButton('Remove', 'ghost', () => mutate('removeDependency', dependency))));
          inspectorBody.append(list);
        } else {
          inspectorBody.append(element('p', 'hint', 'None. Drag one node\\'s port onto the other to add it.'));
        }

        inspectorBody.append(element('h3', '', 'File links (' + connection.links.length + ')'));
        const links = element('ul', 'pair-list');
        connection.links.forEach((link) => links.append(listItem(link.from + '  →  ' + link.to, link.kind + (link.note ? ' · ' + link.note : ''),
          smallButton('Remove', 'ghost', () => mutate('removeLink', { from: link.from, to: link.to })))));
        inspectorBody.append(links);
        inspectorBody.append(smallButton('+ File Link', 'secondary', () => openLinkForm(connection.a, connection.b)));

        inspectorBody.append(element('h3', '', 'Detected imports (' + connection.detected.length + ')'));
        const detected = element('ul', 'pair-list');
        connection.detected.slice(0, 50).forEach((link) => {
          const pin = smallButton('Pin', 'ghost', () => mutate('addLink', { from: link.from, to: link.to, kind: 'type' }));
          pin.title = 'Save as a file link, so it survives changes to imports';
          detected.append(listItem(link.from + '  →  ' + link.to, 'found from a package import', pin));
        });
        if (connection.detected.length === 0) detected.append(element('p', 'hint', 'None found from imports.'));
        if (connection.detected.length > 50) detected.append(element('p', 'hint', (connection.detected.length - 50) + ' more not shown.'));
        inspectorBody.append(detected);
      };

      const fillRepoSelect = (select, chosen) => {
        select.replaceChildren(...graph.repos.map((repo) => {
          const option = element('option', '', repo.name);
          option.value = repo.name;
          option.selected = repo.name === chosen;
          return option;
        }));
      };

      const openLinkForm = (from, to) => {
        if (!graph || graph.repos.length < 2) {
          setStatus('Add a second repository before linking files.');
          return;
        }
        const fromName = from || graph.defaultRepo;
        const other = graph.repos.find((repo) => repo.name !== fromName);
        fillRepoSelect(linkFromRepo, fromName);
        fillRepoSelect(linkToRepo, to && to !== fromName ? to : (other ? other.name : ''));
        linkFromPath.value = '';
        linkToPath.value = '';
        linkNote.value = '';
        linkKind.value = 'api';
        linkError.textContent = '';
        linkForm.hidden = false;
        inspectorEmpty.hidden = true;
        if (!detailsOpen) setDetailsOpen(true);
        linkFromPath.focus();
      };

      const pickInto = (select, input) => request('pickFile', { name: select.value }, (message) => {
        if (message.success && message.value) input.value = message.value;
        else if (message.message && message.message !== 'No file chosen.') linkError.textContent = message.message;
      });

      document.getElementById('link-from-pick').addEventListener('click', () => pickInto(linkFromRepo, linkFromPath));
      document.getElementById('link-to-pick').addEventListener('click', () => pickInto(linkToRepo, linkToPath));
      document.getElementById('link-cancel').addEventListener('click', () => {
        linkForm.hidden = true;
        renderInspector();
      });
      linkForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!linkFromPath.value.trim() || !linkToPath.value.trim()) {
          linkError.textContent = 'Enter a file on both ends.';
          return;
        }
        const params = {
          from: linkFromRepo.value + ':' + linkFromPath.value.trim(),
          to: linkToRepo.value + ':' + linkToPath.value.trim(),
          kind: linkKind.value,
          note: linkNote.value.trim() || undefined
        };
        request('addLink', params, (message) => {
          if (!message.success) {
            linkError.textContent = message.message;
            return;
          }
          setStatus(message.message);
          linkForm.hidden = true;
          selection = { type: 'edge', key: pairKey(linkFromRepo.value, linkToRepo.value) };
          loadGraph();
        });
      });

      addButton.addEventListener('click', (event) => {
        event.stopPropagation();
        addMenu.hidden = !addMenu.hidden;
        addButton.setAttribute('aria-expanded', String(!addMenu.hidden));
      });
      document.addEventListener('click', (event) => {
        if (!addMenu.hidden && !addMenu.contains(event.target)) {
          addMenu.hidden = true;
          addButton.setAttribute('aria-expanded', 'false');
        }
      });
      document.getElementById('add-repo').addEventListener('click', () => {
        addMenu.hidden = true;
        mutate('add', {});
      });
      // A selected connection or node pre-fills the link's ends.
      document.getElementById('add-link').addEventListener('click', () => {
        addMenu.hidden = true;
        const connection = selection && selection.type === 'edge' && graph
          ? connections().find((candidate) => candidate.key === selection.key)
          : null;
        if (connection) {
          openLinkForm(connection.a, connection.b);
        } else {
          openLinkForm(selection && selection.type === 'node' ? selection.name : null, null);
        }
      });
      document.getElementById('auto-layout').addEventListener('click', () => {
        if (!graph) return;
        positions = autoLayout(graph, {});
        render();
        scheduleSave();
        setStatus('Arranged automatically.');
      });
      document.getElementById('refresh').addEventListener('click', loadGraph);
      // Pan: drag empty space, drag with the middle button, or hold Space and drag anywhere.
      // A press on empty space that does not move clears the selection.
      viewport.addEventListener('pointerdown', (event) => {
        const onEmpty = !event.target.closest('.node, .edge-label, .canvas-controls');
        if (!(event.button === 1 || (event.button === 0 && (spaceHeld || onEmpty)))) return;
        event.preventDefault();
        capture(viewport, event.pointerId);
        const origin = { x: event.clientX, y: event.clientY };
        const startPan = Object.assign({}, pan);
        let moved = false;
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - origin.x;
          const dy = moveEvent.clientY - origin.y;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          moved = true;
          viewport.classList.add('panning');
          pan = { x: startPan.x + dx, y: startPan.y + dy };
          applyView();
        };
        const up = () => {
          viewport.removeEventListener('pointermove', move);
          viewport.removeEventListener('pointerup', up);
          viewport.classList.remove('panning');
          if (!moved && onEmpty && event.button === 0 && !spaceHeld) select(null);
        };
        viewport.addEventListener('pointermove', move);
        viewport.addEventListener('pointerup', up);
      });

      // Wheel pans; Ctrl or Cmd with the wheel zooms toward the pointer. Trackpad pinch arrives as Ctrl + wheel.
      viewport.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
          zoomTo(zoom * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
          return;
        }
        pan = { x: pan.x - (event.shiftKey ? event.deltaY : event.deltaX), y: pan.y - (event.shiftKey ? 0 : event.deltaY) };
        applyView();
      }, { passive: false });

      document.getElementById('zoom-in').addEventListener('click', () => zoomTo(zoom * 1.2));
      document.getElementById('zoom-out').addEventListener('click', () => zoomTo(zoom / 1.2));
      zoomLabel.addEventListener('click', () => zoomTo(1));
      document.getElementById('zoom-fit').addEventListener('click', fitView);

      const typing = (target) => target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
      document.addEventListener('keydown', (event) => {
        if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === ' ' && !event.target.closest('.node, button')) {
          spaceHeld = true;
          viewport.style.cursor = 'grab';
          event.preventDefault();
          return;
        }
        if (event.target.closest('.node')) return;
        if (event.key === '+' || event.key === '=') zoomTo(zoom * 1.2);
        else if (event.key === '-' || event.key === '_') zoomTo(zoom / 1.2);
        else if (event.key === '0') zoomTo(1);
        else if (event.key === 'f' || event.key === 'F') fitView();
        else if (event.key === 'd' || event.key === 'D') setDetailsOpen(!detailsOpen);
        else if (event.key === 'Escape') {
          addMenu.hidden = true;
          linesPanel.hidden = true;
          select(null);
        } else return;
        event.preventDefault();
      });
      document.addEventListener('keyup', (event) => {
        if (event.key === ' ') {
          spaceHeld = false;
          viewport.style.cursor = '';
        }
      });

      // Lines: connector shape, a dash style per kind, and grid snapping. Saved with the layout.
      const linesButton = document.getElementById('lines-button');
      const linesPanel = document.getElementById('lines-panel');
      const lineShape = document.getElementById('line-shape');
      const styleSelects = Array.from(linesPanel.querySelectorAll('select[data-kind]'));
      const snapGrid = document.getElementById('snap-grid');
      styleSelects.forEach((select) => {
        select.replaceChildren(...Object.keys(DASHES).map((value) => {
          const option = element('option', '', STYLE_LABELS[value]);
          option.value = value;
          return option;
        }));
      });
      const legendStyle = { solid: 'solid', dashed: 'dashed', dotted: 'dotted', longdash: 'dashed' };
      function applySettings() {
        lineShape.value = settings.shape;
        styleSelects.forEach((select) => { select.value = settings.styles[select.dataset.kind]; });
        snapGrid.checked = settings.snap;
        document.querySelector('.legend i.dep').style.borderTopStyle = legendStyle[settings.styles.dependency];
        document.querySelector('.legend i.link').style.borderTopStyle = legendStyle[settings.styles.link];
        document.querySelector('.legend i.detected').style.borderTopStyle = legendStyle[settings.styles.detected];
      }
      const changeSettings = () => {
        settings = {
          shape: lineShape.value,
          styles: {
            dependency: styleSelects[0].value,
            link: styleSelects[1].value,
            detected: styleSelects[2].value
          },
          snap: snapGrid.checked
        };
        applySettings();
        drawEdges();
        scheduleSave();
      };
      lineShape.addEventListener('change', changeSettings);
      styleSelects.forEach((select) => select.addEventListener('change', changeSettings));
      snapGrid.addEventListener('change', changeSettings);
      linesButton.addEventListener('click', (event) => {
        event.stopPropagation();
        linesPanel.hidden = !linesPanel.hidden;
        linesButton.setAttribute('aria-expanded', String(!linesPanel.hidden));
      });
      document.addEventListener('click', (event) => {
        if (!linesPanel.hidden && !linesPanel.contains(event.target) && event.target !== linesButton) {
          linesPanel.hidden = true;
          linesButton.setAttribute('aria-expanded', 'false');
        }
      });

      window.addEventListener('resize', () => { if (graph) sizeBoard(); });
      applyView();
      applySettings();

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) return;
        if (message.type === 'reposChanged') {
          loadGraph();
          return;
        }
        if (message.type === 'activity') {
          applyActivity(message.repos);
          return;
        }
        if (message.type !== 'reposResult') return;
        const handler = pending.get(message.requestId);
        if (!handler) return;
        pending.delete(message.requestId);
        handler(message);
      });

      loadGraph();
    })();
  </script>
</body>
</html>`;
}

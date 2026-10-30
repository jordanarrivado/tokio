import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { buildMascots, buildRobots } from './mascot';
import { handleWebviewRequest } from './messages';
import type { RepoCatalogService } from './repos';

/**
 * The repository map: an editor tab where repositories are nodes on a board. Drag a node to arrange it,
 * drag from its port onto another node to record a dependency, and pin file links between repositories.
 * Positions are saved per user; dependencies and links go to tokio.repos.json, where the router uses them.
 */

const MUTATING_ACTIONS = new Set([
  'grant', 'revoke', 'clearGrants', 'setDefault', 'add', 'remove',
  'addDependency', 'removeDependency', 'addLink', 'removeLink', 'connect', 'disconnect'
]);

/** How often the open map rereads the audit log to show which repository an agent is working in. */
const ACTIVITY_POLL_MS = 2_000;
/** lottie-web's light SVG player, copied from node_modules at build time. It plays the activity icons. */
const VENDOR_DIRECTORY = ['out', 'vendor'];
const LOTTIE_FILE = 'lottie_light.min.js';

export class RepositoryMapPanel {
  private static current: RepositoryMapPanel | undefined;
  private polling = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly service: RepoCatalogService,
    private readonly onChanged: () => void,
    vendorRoot: vscode.Uri
  ) {
    const lottieUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(vendorRoot, LOTTIE_FILE)).toString();
    panel.webview.html = getMapHtml(panel.webview.cspSource, lottieUri);
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

  public static show(service: RepoCatalogService, onChanged: () => void, extensionUri: vscode.Uri): void {
    if (RepositoryMapPanel.current) {
      RepositoryMapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const vendorRoot = vscode.Uri.joinPath(extensionUri, ...VENDOR_DIRECTORY);
    const panel = vscode.window.createWebviewPanel('tokio.repositoryMap', 'Tokio: Repository Map', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vendorRoot]
    });
    RepositoryMapPanel.current = new RepositoryMapPanel(panel, service, onChanged, vendorRoot);
  }

  /** Tells an open map that the catalog changed elsewhere, such as in the sidebar. */
  public static notifyChanged(): void {
    void RepositoryMapPanel.current?.panel.webview.postMessage({ type: 'reposChanged' });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (isMapCommand(message)) {
      await this.panel.webview.postMessage(await this.runCommand(message));
      return;
    }
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

  /** Copy a repository's path, or show its folder in the OS file explorer. The path comes from the catalog, not the page. */
  private async runCommand(message: MapCommand): Promise<MapCommandResult> {
    const reply = (success: boolean, text: string): MapCommandResult => ({ type: 'mapResult', requestId: message.requestId, success, message: text });
    try {
      const repo = (await this.service.list()).repos.find((candidate) => candidate.name === message.name);
      if (!repo) {
        return reply(false, `${message.name} is not in the catalog.`);
      }
      if (message.command === 'copyPath') {
        await vscode.env.clipboard.writeText(repo.path);
        return reply(true, `Copied the path of ${repo.name}.`);
      }
      if (repo.missing) {
        return reply(false, `The folder for ${repo.name} is missing.`);
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repo.path));
      return reply(true, `Opened ${repo.name} in the file explorer.`);
    } catch (error: unknown) {
      return reply(false, error instanceof Error ? error.message : 'Could not run that command.');
    }
  }
}

interface MapCommand {
  type: 'map';
  requestId: number;
  command: 'copyPath' | 'openFolder';
  name: string;
}

interface MapCommandResult {
  type: 'mapResult';
  requestId: number;
  success: boolean;
  message: string;
}

function isMapCommand(message: unknown): message is MapCommand {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const value = message as Record<string, unknown>;
  return value.type === 'map'
    && Number.isSafeInteger(value.requestId)
    && (value.command === 'copyPath' || value.command === 'openFolder')
    && typeof value.name === 'string'
    && value.name.length > 0
    && value.name.length <= 64;
}

function getMapHtml(cspSource: string, lottieUri: string): string {
  const nonce = randomBytes(16).toString('hex');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Repository Map</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background, #0f1117);
      --surface: var(--vscode-sideBar-background, var(--vscode-editorWidget-background, #14161c));
      --card: var(--vscode-editorWidget-background, #181b22);
      --field: var(--vscode-input-background, #1d2028);
      --field-fg: var(--vscode-input-foreground, var(--text));
      --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.22)));
      --border-strong: color-mix(in srgb, var(--text) 16%, transparent);
      --text: var(--vscode-foreground, #e6e8ee);
      --muted: var(--vscode-descriptionForeground, #8b90a0);
      --accent: #4f6bff;
      --accent-fg: #ffffff;
      --accent-hover: #3f5af0;
      --accent-text: #8197ff;
      --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
      --link: var(--vscode-charts-blue, #3ba8ff);
      --secondary: var(--vscode-button-secondaryBackground, #3a3d41);
      --secondary-fg: var(--vscode-button-secondaryForeground, var(--text));
      --secondary-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
      --hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
      --focus: var(--vscode-focusBorder, #4f6bff);
      --ok: #22c55e;
      --ok-soft: color-mix(in srgb, var(--ok) 15%, transparent);
      --warn: var(--vscode-editorWarning-foreground, #e0a91b);
      --danger: var(--vscode-errorForeground, #f2555a);
      --active: var(--vscode-charts-orange, #d18616);
      --edit: #a2e61b;
      --mono: var(--vscode-editor-font-family, monospace);
      --radius: 12px;
      --node-width: 250px;
      --shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
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
      gap: 7px;
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 4px 12px;
      color: var(--accent-fg);
      background: var(--accent);
      font: inherit;
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    button.secondary { color: var(--secondary-fg); background: var(--secondary); }
    button.secondary:hover:not(:disabled) { background: var(--secondary-hover); }
    button.ghost { border-color: var(--border-strong); color: var(--text); background: color-mix(in srgb, var(--text) 3%, transparent); }
    button.ghost:hover:not(:disabled) { background: var(--hover); }
    button.plain { border-color: transparent; color: var(--muted); background: transparent; }
    button.plain:hover:not(:disabled) { color: var(--text); background: var(--hover); }
    button.danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    button.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 16%, transparent); }
    button.icon-only { width: 32px; padding: 0; }
    button.compact { min-height: 26px; padding: 2px 9px; font-size: 0.86em; }
    button.block { width: 100%; }
    button:focus-visible, .node:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    input, select {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 5px 8px;
      color: var(--field-fg);
      background: var(--field);
      font: inherit;
    }
    input:focus, select:focus { outline: 1px solid var(--focus); outline-offset: -1px; }
    label { font-weight: 600; font-size: 0.9em; }
    kbd {
      padding: 1px 6px;
      border: 1px solid var(--border-strong);
      border-radius: 5px;
      color: var(--muted);
      background: color-mix(in srgb, var(--text) 5%, transparent);
      font-family: var(--mono);
      font-size: 0.76em;
      white-space: nowrap;
    }
    .icon { flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .hint { margin: 0; color: var(--muted); font-size: 0.86em; }
    .eyebrow { color: var(--muted); font-size: 0.72em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    [hidden] { display: none !important; }

    /* Toolbar */
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; color: var(--accent-text); background: var(--accent-soft); }
    .toolbar h1 { margin: 0; font-size: 1.05rem; font-weight: 700; white-space: nowrap; }
    .count { padding: 1px 9px; border: 1px solid var(--border-strong); border-radius: 999px; color: var(--muted); font-size: 0.8em; white-space: nowrap; }
    .spacer { flex: 1; }
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      width: min(300px, 100%);
      height: 32px;
      padding: 0 6px 0 10px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      color: var(--muted);
      background: var(--field);
      font-weight: 400;
    }
    .search:focus-within { border-color: var(--focus); }
    .search input { flex: 1; padding: 0; border: 0; background: transparent; }
    .search input:focus { outline: none; }
    #details-toggle[aria-pressed="true"] { border-color: color-mix(in srgb, var(--accent) 70%, transparent); color: var(--accent-text); background: var(--accent-soft); }
    .add-menu, .lines-menu { position: relative; }
    .split { display: flex; }
    .split > button:first-child { border-radius: 8px 0 0 8px; }
    .split .caret { width: 28px; padding: 0; border-left-color: color-mix(in srgb, #000000 25%, transparent); border-radius: 0 8px 8px 0; }
    .menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 40;
      display: grid;
      gap: 4px;
      min-width: 190px;
      padding: 6px;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .menu button { justify-content: flex-start; }
    .lines-menu .menu { min-width: 230px; gap: 8px; padding: 10px; }
    .menu-row { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; gap: 8px; font-size: 0.88em; }
    .menu-row label { font-weight: 500; }
    .menu-check { display: flex; align-items: center; gap: 8px; font-size: 0.88em; }
    .menu-check input { width: auto; }

    /* Board */
    .workspace { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 0; }
    /* The viewport clips; the board moves inside it with one transform, so pan and zoom stay cheap. */
    #viewport {
      position: relative;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      background-color: var(--bg);
      background-image: radial-gradient(color-mix(in srgb, var(--muted) 28%, transparent) 1px, transparent 1px);
      background-size: 16px 16px;
    }
    #viewport.panning { cursor: grabbing; }
    #board { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
    /* Panels float over the canvas: the legend, the hint, the minimap with zoom, and the status toast. */
    .panel {
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface) 94%, transparent);
      box-shadow: var(--shadow);
      cursor: default;
    }
    .toast { position: absolute; top: 14px; left: 50%; z-index: 16; max-width: 70%; margin: 0; padding: 6px 14px; transform: translateX(-50%); font-size: 0.86em; }
    .toast:empty { display: none; }
    .legend { position: absolute; left: 16px; bottom: 16px; z-index: 15; display: grid; width: 216px; padding: 10px 6px 6px; }
    .legend-head { display: flex; align-items: baseline; justify-content: space-between; padding: 0 8px 6px; }
    .legend-head .hint { font-size: 0.78em; }
    button.legend-row {
      justify-content: flex-start;
      gap: 10px;
      min-height: 30px;
      padding: 4px 8px;
      border: 0;
      border-radius: 6px;
      color: var(--text);
      background: transparent;
      font-size: 0.88em;
      font-weight: 500;
    }
    button.legend-row:hover:not(:disabled) { background: var(--hover); }
    .legend-row .label { flex: 1; text-align: left; }
    .legend-row .icon { color: var(--muted); }
    .legend-row[aria-pressed="false"] { color: var(--muted); }
    .legend-row[aria-pressed="false"] .swatch { opacity: 0.3; }
    .legend-row[aria-pressed="false"] .icon { visibility: hidden; }
    .swatch { width: 26px; flex: 0 0 26px; border-top: 2px solid var(--muted); }
    .swatch.dep { border-top-color: var(--accent-text); }
    .swatch.link { border-top-color: var(--link); }
    .swatch.detected { border-top-color: color-mix(in srgb, var(--muted) 80%, transparent); }
    .swatch.reading { border-top: 2px dashed var(--active); }
    .swatch.editing { border-top: 2px dashed var(--edit); }
    .canvas-hint {
      position: absolute;
      left: 50%;
      bottom: 16px;
      z-index: 14;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0;
      padding: 5px 12px;
      transform: translateX(-50%);
      border-radius: 999px;
      color: var(--muted);
      font-size: 0.8em;
      white-space: nowrap;
      pointer-events: none;
    }
    .view-dock { position: absolute; right: 16px; bottom: 16px; z-index: 15; display: grid; justify-items: end; gap: 8px; }
    .minimap { position: relative; width: 184px; height: 112px; overflow: hidden; cursor: pointer; }
    .mini-node { position: absolute; border-radius: 3px; background: color-mix(in srgb, var(--text) 22%, transparent); }
    .mini-node.write { background: color-mix(in srgb, var(--accent) 80%, transparent); }
    .mini-node.selected { outline: 1.5px solid var(--accent-text); }
    #mini-view { position: absolute; border: 1.5px solid var(--accent); border-radius: 4px; background: color-mix(in srgb, var(--accent) 8%, transparent); pointer-events: none; }
    .zoom { display: flex; align-items: center; gap: 2px; padding: 3px; }
    .zoom button { width: 32px; min-height: 30px; padding: 0; border: 0; color: var(--text); background: transparent; font-weight: 500; }
    .zoom button:hover:not(:disabled) { background: var(--hover); }
    #zoom-reset { width: 58px; font-variant-numeric: tabular-nums; }
    .zoom .sep { width: 1px; height: 18px; margin: 0 3px; background: var(--border-strong); }
    /* Markers take their color from the svg, not the line, so the arrowheads follow this color. */
    #edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; color: var(--accent-text); }
    #edge-paths path { fill: none; stroke-width: 1.6; stroke-linecap: round; }
    #arrow path { fill: currentColor; stroke: none; }
    /* A lit line's arrowhead matches its flow. */
    #arrow-live path { fill: var(--active); stroke: none; }
    #arrow-editing path { fill: var(--edit); stroke: none; }
    #arrow-blocked path { fill: var(--danger); stroke: none; }
    #edges .dep { stroke: var(--accent-text); }
    #edges .link { stroke: var(--link); }
    /* Dash patterns come from the Lines settings, per connection kind. */
    #edges .detected { stroke: color-mix(in srgb, var(--muted) 80%, transparent); }
    #edges .draft { stroke: var(--accent-text); stroke-dasharray: 6 4; }
    #edges .selected { stroke-width: 3; }
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
    button.edge-label {
      position: absolute;
      z-index: 2;
      min-height: 20px;
      padding: 1px 9px;
      transform: translate(-50%, -50%);
      border: 1px solid color-mix(in srgb, var(--accent-text) 55%, transparent);
      border-radius: 999px;
      color: color-mix(in srgb, var(--accent-text) 55%, var(--text));
      background: color-mix(in srgb, var(--accent) 14%, var(--bg));
      font-size: 0.72em;
      font-weight: 600;
    }
    button.edge-label:hover:not(:disabled) { border-color: var(--accent-text); background: color-mix(in srgb, var(--accent) 26%, var(--bg)); }
    .edge-label[data-kind="link"] { border-color: color-mix(in srgb, var(--link) 55%, transparent); color: color-mix(in srgb, var(--link) 60%, var(--text)); background: color-mix(in srgb, var(--link) 12%, var(--bg)); }
    .edge-label[data-kind="detected"] { border-color: var(--border-strong); color: var(--muted); background: var(--bg); }
    button.edge-label[aria-pressed="true"] { border-color: var(--accent); color: var(--accent-fg); background: var(--accent); }

    .node {
      --tint: var(--accent-text);
      position: absolute;
      z-index: 3;
      width: var(--node-width);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--card);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
      user-select: none;
      touch-action: none;
      transition: border-color 120ms ease, opacity 120ms ease;
    }
    .node:hover { border-color: color-mix(in srgb, var(--text) 30%, transparent); }
    .node[data-access="missing"] { border-style: dashed; border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
    .node.dimmed { opacity: 0.35; }
    /* Agent activity, from the audit log. Working and blocked glow; recent keeps a soft border. */
    .node[data-activity="working"] { --glow: var(--active); border-color: var(--active); animation: node-glow 1.6s ease-in-out infinite; }
    .node[data-activity="blocked"] { --glow: var(--danger); border-color: var(--danger); animation: node-glow 1.6s ease-in-out infinite; }
    .node[data-activity="recent"] { border-color: color-mix(in srgb, var(--active) 45%, var(--border-strong)); }
    @keyframes node-glow {
      0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--glow) 35%, transparent), 0 0 10px color-mix(in srgb, var(--glow) 25%, transparent); }
      50% { box-shadow: 0 0 0 2px color-mix(in srgb, var(--glow) 60%, transparent), 0 0 26px color-mix(in srgb, var(--glow) 55%, transparent); }
    }
    .node[aria-selected="true"] {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 0 0 5px color-mix(in srgb, var(--accent) 22%, transparent), 0 10px 26px rgba(0, 0, 0, 0.4);
    }
    .activity { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -4px; padding: 0 12px 8px; color: var(--muted); font-size: 0.78em; }
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
    .node.dragging { cursor: grabbing; opacity: 0.92; z-index: 10; }
    .node.drop-target { outline: 2px dashed var(--accent-text); outline-offset: 3px; }
    .node-head { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px 12px 10px; cursor: grab; }
    .tile {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      flex: 0 0 34px;
      border: 1px solid color-mix(in srgb, var(--tint) 28%, transparent);
      border-radius: 8px;
      color: var(--tint);
      background: color-mix(in srgb, var(--tint) 16%, var(--card));
      font-size: 0.76em;
      font-weight: 800;
    }
    /* The activity icon replaces the initials. Its shapes are one color, painted with the card's glow. */
    .tile[data-pose] {
      padding: 4px;
      color: var(--glow, var(--active));
      background: color-mix(in srgb, var(--glow, var(--active)) 14%, var(--field));
    }
    .node[data-activity="recent"] .tile[data-pose] { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, var(--field)); }
    .tile[data-pose] svg, .robot svg { display: block; }
    .tile[data-pose] path, .robot path { fill: currentColor; }
    .tile[data-pose] path[stroke-width], .robot path[stroke-width] { stroke: currentColor; }
    /* The robot acts out the same activity beside the name while an agent works here. */
    .robot { width: 34px; height: 34px; flex: 0 0 34px; margin: -2px 0; color: var(--glow, var(--active)); }
    .node[data-activity="recent"] .robot { color: var(--ok); }
    .node-copy { display: grid; min-width: 0; flex: 1; }
    .node-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
    .node-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: var(--mono); font-size: 0.78em; }
    /* The dot: green for the write target, blue when an agent may work here, hollow when it may not. */
    .dot { width: 8px; height: 8px; flex: 0 0 8px; align-self: flex-start; margin-top: 4px; border: 1.5px solid var(--muted); border-radius: 50%; }
    .node[data-agent="on"] .dot { border-color: var(--accent-text); background: var(--accent-text); box-shadow: 0 0 0 3px var(--accent-soft); }
    .node[data-access="write"] .dot { border-color: var(--ok); background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
    .node[data-access="granted"] .dot { border-color: var(--warn); background: var(--warn); }
    .node[data-access="missing"] .dot { border-color: var(--danger); background: var(--danger); }
    .node-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border: 1px solid var(--border-strong);
      border-radius: 6px;
      color: var(--muted);
      background: color-mix(in srgb, var(--text) 5%, transparent);
      font-size: 0.76em;
      font-weight: 600;
    }
    .node[data-access="write"] .pill { border-color: color-mix(in srgb, var(--ok) 35%, transparent); color: var(--ok); background: var(--ok-soft); }
    .node[data-access="granted"] .pill { border-color: color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn); }
    .node[data-access="missing"] .pill { border-color: color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); }
    .agent-note { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 0.76em; }
    button.switch { gap: 8px; min-height: 0; padding: 0; border: 0; color: var(--muted); background: transparent; font-size: 0.76em; font-weight: 500; }
    button.switch:hover:not(:disabled) { color: var(--text); background: transparent; }
    .switch .track {
      position: relative;
      width: 30px;
      height: 17px;
      flex: 0 0 30px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--text) 20%, transparent);
      transition: background 120ms ease;
    }
    .switch .track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      transition: transform 120ms ease;
    }
    .switch[aria-checked="true"] .track { background: var(--accent); }
    .switch[aria-checked="true"] .track::after { transform: translateX(13px); }
    .switch.lg .track { width: 38px; height: 22px; flex-basis: 38px; }
    .switch.lg .track::after { width: 18px; height: 18px; }
    .switch.lg[aria-checked="true"] .track::after { transform: translateX(16px); }
    button.switch:disabled { opacity: 0.6; cursor: default; }
    /* Ports: drag the right one onto another node to record that this one depends on that one. The left one is where lines arrive. */
    .port {
      position: absolute;
      top: 50%;
      z-index: 4;
      width: 11px;
      height: 11px;
      margin-top: -5.5px;
      border: 1.5px solid color-mix(in srgb, var(--text) 45%, transparent);
      border-radius: 50%;
      background: var(--bg);
      transition: transform 120ms ease, background 120ms ease;
    }
    .port.in { left: -6px; pointer-events: none; }
    .port.out { right: -6px; cursor: crosshair; }
    .node:hover .port, .node[aria-selected="true"] .port { border-color: var(--accent-text); }
    .port.out:hover { background: var(--accent-text); transform: scale(1.3); }

    .empty-board { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; color: var(--muted); }

    /* Inspector */
    #inspector {
      display: flex;
      flex-direction: column;
      width: 340px;
      min-height: 0;
      max-height: 100%;
      overflow: auto;
      border-left: 1px solid var(--border);
      background: var(--surface);
    }
    /* Collapsed, the canvas takes the inspector's column. */
    .workspace.details-collapsed #inspector { display: none; }
    #inspector-empty, #inspector-body { display: flex; flex-direction: column; flex: 1; }
    .insp-head { display: flex; align-items: center; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .insp-head .tile { width: 40px; height: 40px; flex-basis: 40px; border-radius: 10px; font-size: 0.85em; }
    .insp-title { flex: 1; min-width: 0; }
    .insp-title h2 { margin: 0; font-size: 1.05rem; font-weight: 700; overflow-wrap: anywhere; }
    .insp-status { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; color: var(--muted); font-size: 0.85em; }
    .insp-status::before { content: ''; width: 7px; height: 7px; flex: 0 0 7px; border-radius: 50%; background: var(--status, var(--muted)); }
    .section { display: grid; gap: 12px; padding: 18px 20px; border-bottom: 1px solid var(--border); }
    .section h3 { display: flex; justify-content: space-between; margin: 0; color: var(--muted); font-size: 0.74em; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .section h3 .count-num { font-weight: 500; letter-spacing: 0; }
    .segmented { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; padding: 4px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg); }
    .segmented button { min-height: 34px; border: 0; color: var(--muted); background: transparent; }
    .segmented button:hover:not(:disabled) { color: var(--text); background: var(--hover); }
    .segmented button[aria-checked="true"] { color: var(--text); background: color-mix(in srgb, var(--text) 9%, transparent); cursor: default; }
    .segmented button.write[aria-checked="true"] { color: var(--ok); background: var(--ok-soft); }
    .segmented button:disabled { opacity: 1; }
    .segmented button:disabled:not([aria-checked="true"]) { opacity: 0.5; }
    .grant-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--muted); font-size: 0.86em; }
    .grant-row select { width: auto; min-height: 26px; padding: 2px 6px; }
    .setting-card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 12px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--card); }
    .badge-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; color: var(--accent-text); background: var(--accent-soft); }
    .setting-card strong { display: block; font-size: 0.92em; }
    .setting-card p { margin: 2px 0 0; color: var(--muted); font-size: 0.84em; }
    .path-field { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 4px 0 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg); }
    .path-field code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 0.85em; }
    .path-field button { min-height: 28px; padding: 0 8px; border: 0; color: var(--muted); background: transparent; font-weight: 500; }
    .path-field button:hover:not(:disabled) { color: var(--text); background: var(--hover); }
    .repo-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
    button.repo-row {
      justify-content: flex-start;
      gap: 12px;
      width: 100%;
      min-height: 52px;
      padding: 9px 12px;
      border: 1px solid var(--border-strong);
      border-radius: 10px;
      color: var(--text);
      background: var(--card);
      font-weight: 500;
      text-align: left;
      white-space: normal;
    }
    button.repo-row:hover:not(:disabled) { background: var(--hover); }
    .repo-row .tile { width: 30px; height: 30px; flex-basis: 30px; font-size: 0.7em; }
    .repo-row .copy { display: grid; flex: 1; min-width: 0; }
    .repo-row .copy strong, .repo-row .copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .repo-row .copy span { color: var(--muted); font-size: 0.82em; font-weight: 400; }
    .repo-row > .icon { color: var(--muted); }
    .insp-foot { margin-top: auto; padding: 16px 20px; border-top: 1px solid var(--border); }
    .pair-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .pair-list li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
      align-items: center;
      padding: 8px 10px;
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: var(--card);
      font-size: 0.86em;
    }
    .pair-list code { grid-column: 1; overflow-wrap: anywhere; font-family: var(--mono); font-size: 0.95em; }
    .pair-list .meta { grid-column: 1; color: var(--muted); }
    .pair-list button { grid-column: 2; grid-row: 1 / span 3; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .form { display: grid; gap: 8px; margin: 16px 20px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--card); }
    .form h2 { margin: 0; font-size: 1rem; }
    .end-row { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 6px; }
    .error { color: var(--danger); }

    @media (max-width: 900px) {
      .canvas-hint { display: none; }
    }
    /* Narrow: icon-only buttons, search on its own row, and the inspector over the canvas. */
    @media (max-width: 760px) {
      .toolbar { padding: 8px 12px; }
      .count, .search kbd, .btn-label { display: none; }
      .search { order: 10; width: 100%; }
      #auto-layout, #details-toggle, #add-repo { width: 32px; padding: 0; }
      .workspace { grid-template-columns: minmax(0, 1fr); }
      #inspector { position: absolute; top: 0; right: 0; bottom: 0; z-index: 30; width: min(340px, 100%); box-shadow: var(--shadow); }
      .minimap { display: none; }
    }
    @media (max-width: 480px) {
      .legend { display: none; }
    }
  </style>
</head>
<body>
  <header class="toolbar">
    <div class="brand">
      <span class="brand-icon" data-icon="share" data-icon-size="17"></span>
      <h1>Repository Map</h1>
      <span id="repo-count" class="count"></span>
    </div>
    <span class="spacer"></span>
    <label class="search" data-icon="search">
      <input id="search" type="search" placeholder="Search repositories" aria-label="Search repositories" autocomplete="off" spellcheck="false">
      <kbd id="search-key">Ctrl K</kbd>
    </label>
    <button id="auto-layout" class="ghost" type="button" title="Arrange nodes automatically" aria-label="Auto layout" data-icon="grid"><span class="btn-label">Auto layout</span></button>
    <div class="lines-menu">
      <button id="lines-button" class="ghost icon-only" type="button" aria-haspopup="true" aria-expanded="false" title="Connector shape and line styles" aria-label="Line styles" data-icon="spline"></button>
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
    <button id="refresh" class="ghost icon-only" type="button" title="Refresh" aria-label="Refresh" data-icon="refresh"></button>
    <button id="details-toggle" class="ghost" type="button" aria-controls="inspector" aria-pressed="true" aria-label="Details" title="Hide details (D)" data-icon="panel"><span class="btn-label">Details</span></button>
    <div class="add-menu split">
      <button id="add-repo" type="button" title="Add a repository folder" aria-label="Add repository" data-icon="plus"><span class="btn-label">Add repository</span></button>
      <button id="add-button" class="caret" type="button" title="More to add" aria-label="More to add" aria-haspopup="true" aria-expanded="false" data-icon="chevronDown" data-icon-size="14"></button>
      <div id="add-menu" class="menu" role="menu" hidden>
        <button id="add-link" class="ghost compact" type="button" role="menuitem" data-icon="link">Add file link…</button>
      </div>
    </div>
  </header>

  <div class="workspace">
    <div id="viewport" tabindex="-1" aria-label="Repository canvas">
      <p id="status" class="panel toast" role="status" aria-live="polite"></p>
      <div class="panel legend" role="group" aria-label="Connections">
        <div class="legend-head"><span class="eyebrow">Connections</span><span class="hint">Click to filter</span></div>
        <button class="legend-row" type="button" data-filter="dep"><i class="swatch dep"></i><span class="label">Depends on</span></button>
        <button class="legend-row" type="button" data-filter="link"><i class="swatch link"></i><span class="label">File links</span></button>
        <button class="legend-row" type="button" data-filter="detected"><i class="swatch detected"></i><span class="label">Detected imports</span></button>
        <button class="legend-row" type="button" data-filter="reading"><i class="swatch reading"></i><span class="label">Agent reading</span></button>
        <button class="legend-row" type="button" data-filter="editing"><i class="swatch editing"></i><span class="label">Agent editing</span></button>
      </div>
      <p class="panel canvas-hint"><kbd>Ctrl</kbd> + scroll to zoom · <kbd>Space</kbd> + drag to pan</p>
      <div class="view-dock">
        <div id="minimap" class="panel minimap" title="Click or drag to move the view" aria-hidden="true" hidden>
          <div id="mini-nodes"></div>
          <div id="mini-view"></div>
        </div>
        <div class="panel zoom" role="group" aria-label="View controls">
          <button id="zoom-out" type="button" title="Zoom out (−)" aria-label="Zoom out" data-icon="minus"></button>
          <button id="zoom-reset" type="button" title="Reset to 100% (0)">100%</button>
          <button id="zoom-in" type="button" title="Zoom in (+)" aria-label="Zoom in" data-icon="plus"></button>
          <span class="sep"></span>
          <button id="zoom-fit" type="button" title="Fit every repository in view (F)" aria-label="Fit to view" data-icon="fit"></button>
        </div>
      </div>
      <div id="board">
        <svg id="edges" aria-hidden="true">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
            </marker>
            <marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
            <marker id="arrow-editing" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
            <marker id="arrow-blocked" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z"></path>
            </marker>
          </defs>
          <g id="edge-paths"></g>
        </svg>
        <div id="edge-labels"></div>
        <div id="nodes"></div>
        <div id="empty-board" class="empty-board" hidden>
          <div>
            <p>No repositories yet.</p>
            <p class="hint">Use Add repository to put one on the map.</p>
          </div>
        </div>
      </div>
    </div>

    <aside id="inspector" aria-label="Details">
      <div id="inspector-empty">
        <div class="insp-head">
          <div class="insp-title">
            <h2>Map your workspace</h2>
          </div>
          <button id="details-collapse" class="plain icon-only" type="button" title="Hide details (D)" aria-label="Hide details" data-icon="close"></button>
        </div>
        <div class="section">
          <p class="hint">Drag a card to arrange it. Drag the port on a card's right edge onto another card to record a dependency. Click a connection to see its file links.</p>
          <button id="empty-add-link" class="ghost" type="button" data-icon="link">Add file link</button>
        </div>
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

  <script nonce="${nonce}" src="${lottieUri}"></script>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const MASCOTS = ${JSON.stringify(buildMascots())};
      const ROBOTS = ${JSON.stringify(buildRobots())};
      const SVG = 'http' + '://www.w3.org/2000/svg';
      const NODE_WIDTH = 250;
      const NODE_HEIGHT = 100;
      // Stroke icons on a 24-unit square, drawn in the text color.
      const ICONS = {
        share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
        search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
        grid: 'M4 4h6v6H4zM14 4h6v6h-6zM14 14h6v6h-6zM4 14h6v6H4z',
        spline: 'M3 17c4 0 4-10 9-10s5 10 9 10',
        refresh: 'M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5',
        panel: 'M4 4h16v16H4zM15 4v16',
        plus: 'M12 5v14M5 12h14',
        minus: 'M5 12h14',
        fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
        chevronDown: 'M6 9l6 6 6-6',
        chevron: 'M9 6l6 6-6 6',
        check: 'M5 12l5 5L20 7',
        close: 'M6 6l12 12M18 6L6 18',
        link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
        lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
        pencil: 'M16 4l4 4L8 20H4v-4zM13 7l4 4',
        clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
        alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
        bot: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M2 12v4M22 12v4',
        copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
        folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6'
      };
      const icon = (name, size) => {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('class', 'icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size || 16));
        svg.setAttribute('height', String(size || 16));
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.append(path);
        return svg;
      };
      document.querySelectorAll('[data-icon]').forEach((host) => host.prepend(icon(host.dataset.icon, Number(host.dataset.iconSize) || 16)));
      if (/Mac/.test(navigator.platform)) document.getElementById('search-key').textContent = '⌘ K';
      // Each repository keeps one avatar color, picked from its name. The write target is green, a missing one red.
      const TINTS = ['#6f8bff', '#a879ff', '#f0a33a', '#2fb8a6', '#ec6f9e', '#3ba8ff'];
      const tintOf = (repo) => {
        if (!repo) return 'var(--muted)';
        if (repo.missing) return 'var(--danger)';
        if (repo.access === 'write') return 'var(--ok)';
        let hash = 0;
        for (const char of repo.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        return TINTS[hash % TINTS.length];
      };
      const ACCESS_LABELS = { write: 'Write target', granted: 'Edits allowed', read: 'Read-only', missing: 'Missing' };
      const ACCESS_ICONS = { write: 'pencil', granted: 'clock', read: 'lock', missing: 'alert' };
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
      const repoCount = document.getElementById('repo-count');
      const searchInput = document.getElementById('search');
      const minimap = document.getElementById('minimap');
      const miniNodes = document.getElementById('mini-nodes');
      const miniView = document.getElementById('mini-view');

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
      // Legend rows filter the canvas by connection kind; the choice is kept with the view.
      const shown = Object.assign({ dep: true, link: true, detected: true, reading: true, editing: true }, restored && restored.shown);
      const saveState = () => vscode.setState({ view: { zoom, x: pan.x, y: pan.y }, detailsOpen, shown });
      const zoomLabel = document.getElementById('zoom-reset');

      // The minimap frames every repository and the visible area. While it is dragged, its frame holds still.
      let miniFrame = null;
      let miniHeld = null;
      const drawMinimap = () => {
        minimap.hidden = !graph || graph.repos.length === 0;
        if (minimap.hidden) return;
        const view = { x: -pan.x / zoom, y: -pan.y / zoom, width: viewport.clientWidth / zoom, height: viewport.clientHeight / zoom };
        let frame = miniHeld;
        if (!frame) {
          let left = view.x;
          let top = view.y;
          let right = view.x + view.width;
          let bottom = view.y + view.height;
          Object.values(positions).forEach((position) => {
            left = Math.min(left, position.x);
            top = Math.min(top, position.y);
            right = Math.max(right, position.x + NODE_WIDTH);
            bottom = Math.max(bottom, position.y + NODE_HEIGHT);
          });
          if (!minimap.clientWidth || !(right > left) || !(bottom > top)) return;
          const scale = Math.min(minimap.clientWidth / (right - left), minimap.clientHeight / (bottom - top));
          frame = {
            left,
            top,
            scale,
            x: (minimap.clientWidth - (right - left) * scale) / 2,
            y: (minimap.clientHeight - (bottom - top) * scale) / 2
          };
        }
        miniFrame = frame;
        const place = (target, x, y, width, height) => {
          target.style.left = frame.x + (x - frame.left) * frame.scale + 'px';
          target.style.top = frame.y + (y - frame.top) * frame.scale + 'px';
          target.style.width = width * frame.scale + 'px';
          target.style.height = height * frame.scale + 'px';
        };
        miniNodes.replaceChildren(...graph.repos.filter((repo) => positions[repo.name]).map((repo) => {
          const box = element('span', 'mini-node');
          box.classList.toggle('write', repo.access === 'write');
          box.classList.toggle('selected', Boolean(selection && selection.type === 'node' && selection.name === repo.name));
          place(box, positions[repo.name].x, positions[repo.name].y, NODE_WIDTH, NODE_HEIGHT);
          return box;
        }));
        place(miniView, view.x, view.y, view.width, view.height);
      };

      const applyView = () => {
        board.style.transform = 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')';
        // The dot grid scales and moves with the board, so it reads as the board's surface.
        viewport.style.backgroundSize = (GRID * zoom) + 'px ' + (GRID * zoom) + 'px';
        viewport.style.backgroundPosition = pan.x + 'px ' + pan.y + 'px';
        zoomLabel.textContent = Math.round(zoom * 100) + '%';
        drawMinimap();
        saveState();
      };

      const centerOn = (name) => {
        const box = center(name);
        pan = { x: viewport.clientWidth / 2 - box.x * zoom, y: viewport.clientHeight / 2 - box.y * zoom };
        applyView();
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
      // Messages show as a toast over the canvas and clear on their own. Sticky ones stay until the next message.
      let statusTimer;
      const setStatus = (text, sticky) => {
        clearTimeout(statusTimer);
        statusLine.textContent = text || '';
        if (text && !sticky) statusTimer = setTimeout(() => { statusLine.textContent = ''; }, 5000);
      };
      // Commands the map panel runs itself, outside the catalog.
      const command = (name, repoName) => {
        requestId += 1;
        pending.set(requestId, (message) => setStatus(message.message));
        vscode.postMessage({ type: 'map', requestId, command: name, name: repoName });
      };
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
        setStatus('Reading the workspace…', true);
        request('graph', {}, (message) => {
          if (!message.graph) {
            setStatus(message.message || 'Could not read tokio.repos.json.', true);
            return;
          }
          graph = message.graph;
          repoCount.textContent = graph.repos.length + (graph.repos.length === 1 ? ' repository' : ' repositories');
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
      // Lines use the side ports unless the other node sits mostly above or below this one.
      const sideAnchor = (box, toward) => {
        const dx = toward.x - box.x;
        const dy = toward.y - box.y;
        if (Math.abs(dx) >= box.width * 0.75) {
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
          const showDep = Boolean(connection.dependency) && shown.dep;
          const showLinks = connection.links.length > 0 && shown.link;
          const showDetected = connection.detected.length > 0 && shown.detected;
          // A filtered-out kind drops out of the line and its label; a line with nothing left is not drawn.
          if (!showDep && !showLinks && !showDetected) return;
          const fromName = connection.dependency ? connection.dependency.from : connection.a;
          const toName = connection.dependency ? connection.dependency.to : connection.b;
          const route = routeEdge(center(fromName), center(toName));
          const kind = showLinks ? 'link' : showDep ? 'dep' : 'detected';
          const style = settings.styles[kind === 'dep' ? 'dependency' : kind];
          const broken = missing.has(fromName) || missing.has(toName);
          // Work in the write target alone only lights its card; a line flows when the agent reaches the other end.
          // Color by what the agent does at the far end; an edit in the write target says nothing about this line.
          const ends = broken ? [] : [fromName, toName].filter((name) => name !== graph.defaultRepo && live(name)).map((name) => activity[name]);
          const blocked = ends.some((entry) => entry.state === 'blocked');
          const editing = ends.some((entry) => entry.state === 'working' && entry.action === 'editing');
          // The legend filters agent lines by what the agent does there. A blocked line always shows.
          const flowing = ends.length > 0 && (blocked || (editing ? shown.editing : shown.reading));
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
          if (showDep) {
            path.setAttribute('marker-end', 'url(#arrow)');
          }
          edgePaths.appendChild(path);
          if (flowing) {
            // Dots run along the line, from the depending repository toward the one it depends on.
            const flow = document.createElementNS(SVG, 'path');
            flow.setAttribute('d', route.d);
            flow.setAttribute('class', 'flow' + (blocked ? ' blocked' : editing ? ' editing' : ''));
            if (editing && !blocked) path.classList.add('editing');
            if (showDep) {
              path.setAttribute('marker-end', 'url(#arrow-' + (blocked ? 'blocked' : editing ? 'editing' : 'live') + ')');
            }
            edgePaths.appendChild(flow);
          }
          const start = route.mid;
          const end = route.mid;

          const parts = [];
          if (showDep) parts.push('depends on');
          if (showLinks) parts.push(connection.links.length + (connection.links.length === 1 ? ' link' : ' links'));
          if (showDetected) parts.push(connection.detected.length + ' detected');
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
        players.forEach((player) => player.anim.destroy());
        players.clear();
        nodesLayer.replaceChildren();
        emptyBoard.hidden = graph.repos.length > 0;
        graph.repos.forEach((repo) => {
          const state = repo.missing ? 'missing' : repo.access;
          const node = element('div', 'node');
          node.dataset.name = repo.name;
          node.dataset.access = state;
          node.dataset.agent = repo.access === 'write' || repo.messaging ? 'on' : 'off';
          node.style.setProperty('--tint', tintOf(repo));
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
          const robot = element('span', 'robot');
          robot.setAttribute('aria-hidden', 'true');
          head.append(tile, copy, robot, element('span', 'dot'));
          const foot = element('div', 'node-foot');
          foot.append(accessPill(state));
          if (state === 'write') {
            const note = element('span', 'agent-note');
            note.append(icon('bot', 13), element('span', '', 'Agent can edit'));
            foot.append(note);
          } else if (typeof repo.messaging === 'boolean' && !repo.missing) {
            foot.append(agentSwitch(repo, true));
          }
          const portIn = element('span', 'port in');
          const portOut = element('span', 'port out');
          portOut.title = 'Drag onto another repository: ' + repo.name + ' depends on it';
          node.append(head, element('span', 'activity'), foot, portIn, portOut);
          setNodeActivity(node, repo, state);

          head.addEventListener('pointerdown', (event) => startDrag(event, node, repo.name));
          portOut.addEventListener('pointerdown', (event) => startLink(event, repo.name));
          node.addEventListener('click', (event) => {
            if (!node.dataset.moved) select({ type: 'node', name: repo.name });
            delete node.dataset.moved;
            event.stopPropagation();
          });
          node.addEventListener('keydown', (event) => nudge(event, repo.name));
          nodesLayer.appendChild(node);
        });
      };

      const accessPill = (state) => {
        const pill = element('span', 'pill');
        pill.append(icon(ACCESS_ICONS[state], 12), element('span', '', ACCESS_LABELS[state]));
        return pill;
      };

      // The write target has no switch: the switch for each other repository says whether its agent and ours may message.
      const agentSwitch = (repo, withLabel) => {
        const toggle = element('button', withLabel ? 'switch' : 'switch lg');
        toggle.type = 'button';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(repo.messaging));
        toggle.setAttribute('aria-label', 'Messaging with ' + repo.name);
        toggle.title = repo.messaging
          ? 'Agents here and in ' + repo.name + ' may message each other. Click to turn off.'
          : 'Click to let agents here and in ' + repo.name + ' message each other.';
        if (withLabel) toggle.append(element('span', '', repo.messaging ? 'Agent on' : 'Agent off'));
        toggle.append(element('span', 'track'));
        toggle.addEventListener('pointerdown', (event) => event.stopPropagation());
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          mutate(repo.messaging ? 'disconnect' : 'connect', { name: repo.name });
        });
        return toggle;
      };

      const activityText = (entry) => {
        const what = entry.file ? entry.tool + ' ' + entry.file : entry.tool;
        if (entry.state === 'working') return 'Agent ' + (entry.action || 'working') + ' · ' + what;
        if (entry.state === 'blocked') return 'Blocked · ' + what;
        const minutes = Math.floor(entry.ageMs / 60000);
        return 'Used ' + (minutes < 1 ? 'under a minute' : minutes + ' min') + ' ago';
      };

      // The tile's activity icon follows the tool: searching and messaging read nothing worth naming as a file.
      const SEARCH_TOOLS = /^(Grep|Glob|WebSearch|WebFetch)$|(repo_map|find_symbol|search_output)$/;
      const MESSAGE_TOOLS = /^SendMessage$|ask_repo$/;
      const poseFor = (entry) => {
        if (!entry) return '';
        if (entry.state === 'blocked') return 'blocked';
        if (entry.state === 'recent') return 'done';
        if (MESSAGE_TOOLS.test(entry.tool)) return 'messaging';
        if (entry.action === 'reading' && SEARCH_TOOLS.test(entry.tool)) return 'searching';
        return MASCOTS[entry.action] ? entry.action : 'reading';
      };

      // One player per tile and robot, kept while its pose holds, so each poll does not restart it.
      const players = new Map();
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      // Returns false when nothing plays: no pose, or no player script.
      function play(key, box, pose, data) {
        const current = players.get(key);
        if (current && current.pose === pose && current.box === box) return true;
        if (current) {
          current.anim.destroy();
          players.delete(key);
        }
        if (!pose || !data || !window.lottie) return false;
        box.replaceChildren();
        box.dataset.pose = pose;
        const anim = window.lottie.loadAnimation({
          container: box,
          renderer: 'svg',
          loop: data.loop,
          autoplay: !reducedMotion.matches,
          // The player marks the data it loads, so each card gets its own copy.
          animationData: structuredClone(data),
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet', focusable: false }
        });
        if (reducedMotion.matches) anim.goToAndStop(data.still, true);
        const svg = box.querySelector('svg');
        if (svg) svg.setAttribute('aria-hidden', 'true');
        players.set(key, { pose, anim, box });
        return true;
      }

      function setMascot(node, name, pose, missing) {
        const tile = node.querySelector('.tile');
        // Without a pose or the player, the tile keeps its initials.
        if (!play('tile:' + name, tile, pose, MASCOTS[pose])) {
          delete tile.dataset.pose;
          tile.textContent = initials(name);
        }
        const robot = node.querySelector('.robot');
        // The robot shows only while an agent works here, so idle cards stay quiet.
        const robotPose = missing ? '' : pose;
        robot.hidden = !play('robot:' + name, robot, robotPose, ROBOTS[robotPose]);
      }

      // Activity changes the card in place, so a drag in progress keeps its node.
      function setNodeActivity(node, repo, state) {
        const entry = activity[repo.name];
        const line = node.querySelector('.activity');
        line.hidden = !entry;
        line.textContent = entry ? activityText(entry) : '';
        setMascot(node, repo.name, repo.missing ? '' : poseFor(entry), repo.missing);
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
        updateInspectorStatus();
      };

      // Search dims the cards that do not match; Enter selects the first match and brings it into view.
      let query = '';
      const matches = (repo) => !query || repo.name.toLowerCase().includes(query) || repo.path.toLowerCase().includes(query);
      const applySearch = () => {
        if (!graph) return;
        graph.repos.forEach((repo) => {
          const node = nodesLayer.querySelector('[data-name="' + CSS.escape(repo.name) + '"]');
          if (node) node.classList.toggle('dimmed', !matches(repo));
        });
      };
      searchInput.addEventListener('input', () => {
        query = searchInput.value.trim().toLowerCase();
        applySearch();
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          const found = query && graph ? graph.repos.find(matches) : null;
          if (!found) return;
          select({ type: 'node', name: found.name });
          centerOn(found.name);
        } else if (event.key === 'Escape') {
          searchInput.value = '';
          query = '';
          applySearch();
          searchInput.blur();
        }
      });

      const render = () => {
        if (!graph) return;
        sizeBoard();
        renderNodes();
        applySearch();
        drawEdges();
        drawMinimap();
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
          drawMinimap();
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

      const iconButton = (name, label, className, onClick) => {
        const button = element('button', className);
        button.type = 'button';
        button.append(icon(name, 16));
        if (label) button.append(element('span', '', label));
        button.addEventListener('click', onClick);
        return button;
      };
      const section = (title, count) => {
        const box = element('section', 'section');
        const heading = element('h3', '', title);
        if (count !== undefined) heading.append(element('span', 'count-num', String(count)));
        box.append(heading);
        return box;
      };
      const avatar = (repo, name) => {
        const tile = element('span', 'tile', initials(name));
        tile.style.setProperty('--tint', tintOf(repo));
        return tile;
      };
      const describeRepo = (repo) => {
        if (!repo) return 'Not in the catalog';
        if (repo.missing) return 'Missing';
        const agent = repo.access === 'write' ? 'agent can edit' : repo.messaging ? 'agent on' : 'agent off';
        return ACCESS_LABELS[repo.access] + ' · ' + agent;
      };

      // The status line under the inspector's title follows the activity poll without a full redraw.
      const statusOf = (repo) => {
        const entry = activity[repo.name];
        if (repo.missing) return { text: 'Folder missing', color: 'var(--danger)' };
        if (entry) {
          const color = entry.state === 'blocked' ? 'var(--danger)'
            : entry.state === 'recent' ? 'var(--muted)'
              : entry.action === 'editing' ? 'var(--edit)' : 'var(--active)';
          return { text: activityText(entry).split(' · ')[0], color };
        }
        if (repo.access === 'granted') return { text: 'Edits allowed', color: 'var(--warn)' };
        return { text: 'Idle', color: repo.access === 'write' ? 'var(--ok)' : 'var(--muted)' };
      };
      const updateInspectorStatus = () => {
        const line = inspectorBody.querySelector('.insp-status[data-repo]');
        const repo = line && graph ? graph.repos.find((candidate) => candidate.name === line.dataset.repo) : null;
        if (!repo) return;
        const status = statusOf(repo);
        line.textContent = status.text;
        line.style.setProperty('--status', status.color);
      };

      const segment = (iconName, label, checked, className, onClick) => {
        const button = iconButton(iconName, label, className, () => { if (!checked) onClick(); });
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(checked));
        return button;
      };

      const agentCard = (repo, state) => {
        const card = element('div', 'setting-card');
        const badge = element('span', 'badge-icon');
        badge.append(icon('bot', 16));
        const copy = element('div');
        let text;
        let toggle = null;
        if (state === 'write') {
          text = 'Always on for the write target. The agent can read and edit files here.';
          toggle = element('button', 'switch lg');
          toggle.type = 'button';
          toggle.disabled = true;
          toggle.setAttribute('role', 'switch');
          toggle.setAttribute('aria-checked', 'true');
          toggle.setAttribute('aria-label', 'Agent access');
          toggle.append(element('span', 'track'));
        } else if (state === 'missing') {
          text = 'The folder is missing, so no agent can work here.';
        } else if (typeof repo.messaging === 'boolean') {
          text = repo.messaging
            ? 'On. Agents here and in the write target may message each other.'
            : 'Off. Agents here and in the write target cannot message each other.';
          toggle = agentSwitch(repo, false);
        } else {
          text = 'Read-only for the agent.';
        }
        copy.append(element('strong', '', 'Agent access'), element('p', '', text));
        card.append(badge, copy);
        if (toggle) card.append(toggle);
        return card;
      };

      const linkList = (links) => {
        const list = element('ul', 'pair-list');
        links.forEach((link) => list.append(listItem(link.from + '  →  ' + link.to, link.kind + (link.note ? ' · ' + link.note : ''),
          smallButton('Remove', 'ghost', () => mutate('removeLink', { from: link.from, to: link.to })))));
        return list;
      };

      const renderInspector = () => {
        inspectorBody.replaceChildren();
        if (!selection || !graph) {
          inspectorEmpty.hidden = false;
          inspectorBody.hidden = true;
          return;
        }
        inspectorEmpty.hidden = true;
        inspectorBody.hidden = false;
        const head = element('div', 'insp-head');
        const title = element('div', 'insp-title');
        const close = iconButton('close', '', 'plain icon-only', () => select(null));
        close.setAttribute('aria-label', 'Close details');
        close.title = 'Close details';

        if (selection.type === 'node') {
          const repo = graph.repos.find((candidate) => candidate.name === selection.name);
          if (!repo) { select(null); return; }
          const state = repo.missing ? 'missing' : repo.access;
          const status = element('p', 'insp-status');
          status.dataset.repo = repo.name;
          title.append(element('h2', '', repo.name), status);
          head.append(avatar(repo, repo.name), title, close);
          inspectorBody.append(head);
          updateInspectorStatus();

          // Access: the write target, or read-only with an optional grant for a few hours.
          const access = section('Access');
          const choice = element('div', 'segmented');
          choice.setAttribute('role', 'radiogroup');
          choice.setAttribute('aria-label', 'Access');
          const writeOption = segment('pencil', 'Write target', state === 'write', 'write', () => mutate('setDefault', { name: repo.name }));
          writeOption.disabled = repo.missing;
          const readOption = segment('lock', 'Read-only', state === 'read' || state === 'missing', '', () => mutate('revoke', { name: repo.name }));
          if (state === 'write') {
            readOption.disabled = true;
            readOption.title = 'Make another repository the write target to make this one read-only.';
          }
          choice.append(writeOption, readOption);
          access.append(choice);
          if (state === 'granted') {
            const until = repo.grantedUntil ? new Date(repo.grantedUntil) : null;
            const row = element('div', 'grant-row', 'Edits allowed' + (until && !isNaN(until.getTime())
              ? ' until ' + until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') + '.');
            row.append(smallButton('Revoke', 'ghost', () => mutate('revoke', { name: repo.name })));
            access.append(row);
          } else if (state === 'read') {
            // Same choices as the sidebar's picker; the last one is remembered while the map is open.
            const row = element('div', 'grant-row', 'Allow edits for');
            const hours = element('select');
            hours.setAttribute('aria-label', 'Allow edits for');
            [1, 2, 4, 8, 24].forEach((value) => {
              const option = element('option', '', value + (value === 1 ? ' hour' : ' hours'));
              option.value = String(value);
              option.selected = value === grantHours;
              hours.append(option);
            });
            hours.addEventListener('change', () => { grantHours = Number(hours.value); });
            row.append(hours, smallButton('Allow', 'ghost', () => mutate('grant', { name: repo.name, hours: grantHours })));
            access.append(row);
          }
          access.append(agentCard(repo, state));
          inspectorBody.append(access);

          const location = section('Location');
          const field = element('div', 'path-field');
          const path = element('code', '', repo.path);
          path.title = repo.path;
          const copyPath = iconButton('copy', 'Copy', '', () => command('copyPath', repo.name));
          copyPath.title = 'Copy the path';
          field.append(path, copyPath);
          const open = iconButton('folder', 'Open folder', 'ghost block', () => command('openFolder', repo.name));
          open.title = 'Show the folder in the file explorer';
          open.disabled = repo.missing;
          location.append(field, open);
          if (repo.purpose) location.append(element('p', 'hint', repo.purpose));
          inspectorBody.append(location);

          const dependencies = section('Depends on', repo.dependsOn.length);
          const list = element('ul', 'repo-list');
          repo.dependsOn.forEach((target) => {
            const other = graph.repos.find((candidate) => candidate.name === target);
            const row = element('button', 'repo-row');
            row.type = 'button';
            const copy = element('span', 'copy');
            copy.append(element('strong', '', target), element('span', '', describeRepo(other)));
            row.append(avatar(other, target), copy, icon('chevron', 16));
            row.disabled = !other;
            row.addEventListener('click', () => select({ type: 'node', name: target }));
            const item = element('li');
            item.append(row);
            list.append(item);
          });
          if (repo.dependsOn.length === 0) list.append(element('p', 'hint', 'None. Drag the port on this card onto another repository.'));
          dependencies.append(list);
          inspectorBody.append(dependencies);

          const mine = graph.links.filter((link) => repoOf(link.from) === repo.name || repoOf(link.to) === repo.name);
          const files = section('File links', mine.length);
          if (mine.length > 0) files.append(linkList(mine));
          files.append(iconButton('link', 'Add file link', 'ghost compact', () => openLinkForm(repo.name, null)));
          inspectorBody.append(files);

          const foot = element('div', 'insp-foot');
          const remove = iconButton('trash', 'Remove from map', 'danger block', () => mutate('remove', { name: repo.name }));
          remove.title = state === 'write'
            ? 'The write target stays on the map. Make another repository the write target first.'
            : 'Removes it from tokio.repos.json. Its files are not touched.';
          remove.disabled = state === 'write';
          foot.append(remove);
          inspectorBody.append(foot);
          return;
        }

        const connection = connections().find((candidate) => candidate.key === selection.key);
        if (!connection) { select(null); return; }
        const badge = element('span', 'tile');
        badge.style.setProperty('--tint', 'var(--accent-text)');
        badge.append(icon('link', 18));
        const status = element('p', 'insp-status', 'Connection');
        status.style.setProperty('--status', 'var(--accent-text)');
        title.append(element('h2', '', connection.a + ' ↔ ' + connection.b), status);
        head.append(badge, title, close);
        inspectorBody.append(head);

        const dependencySection = section('Dependency');
        if (connection.dependency) {
          const dependency = connection.dependency;
          const list = element('ul', 'pair-list');
          list.append(listItem(dependency.from + ' depends on ' + dependency.to, 'merge ' + dependency.to + ' first',
            smallButton('Remove', 'ghost', () => mutate('removeDependency', dependency))));
          dependencySection.append(list);
        } else {
          dependencySection.append(element('p', 'hint', 'None. Drag the port on one card onto the other to add it.'));
        }
        inspectorBody.append(dependencySection);

        const files = section('File links', connection.links.length);
        if (connection.links.length > 0) files.append(linkList(connection.links));
        files.append(iconButton('link', 'Add file link', 'ghost compact', () => openLinkForm(connection.a, connection.b)));
        inspectorBody.append(files);

        const detectedSection = section('Detected imports', connection.detected.length);
        const detected = element('ul', 'pair-list');
        connection.detected.slice(0, 50).forEach((link) => {
          const pin = smallButton('Pin', 'ghost', () => mutate('addLink', { from: link.from, to: link.to, kind: 'type' }));
          pin.title = 'Save as a file link, so it survives changes to imports';
          detected.append(listItem(link.from + '  →  ' + link.to, 'found from a package import', pin));
        });
        if (connection.detected.length === 0) detected.append(element('p', 'hint', 'None found from imports.'));
        if (connection.detected.length > 50) detected.append(element('p', 'hint', (connection.detected.length - 50) + ' more not shown.'));
        detectedSection.append(detected);
        inspectorBody.append(detectedSection);
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
      document.getElementById('add-repo').addEventListener('click', () => mutate('add', {}));
      // A selected connection or node pre-fills the link's ends.
      const addLink = () => {
        addMenu.hidden = true;
        addButton.setAttribute('aria-expanded', 'false');
        const connection = selection && selection.type === 'edge' && graph
          ? connections().find((candidate) => candidate.key === selection.key)
          : null;
        if (connection) {
          openLinkForm(connection.a, connection.b);
        } else {
          openLinkForm(selection && selection.type === 'node' ? selection.name : null, null);
        }
      };
      document.getElementById('add-link').addEventListener('click', addLink);
      document.getElementById('empty-add-link').addEventListener('click', addLink);
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
        const onEmpty = !event.target.closest('.node, .edge-label, .panel');
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

      // Click or drag on the minimap to center the view there.
      const panToMinimap = (event) => {
        const rect = minimap.getBoundingClientRect();
        const x = (event.clientX - rect.left - miniFrame.x) / miniFrame.scale + miniFrame.left;
        const y = (event.clientY - rect.top - miniFrame.y) / miniFrame.scale + miniFrame.top;
        pan = { x: viewport.clientWidth / 2 - x * zoom, y: viewport.clientHeight / 2 - y * zoom };
        applyView();
      };
      minimap.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !miniFrame) return;
        event.preventDefault();
        miniHeld = miniFrame;
        capture(minimap, event.pointerId);
        panToMinimap(event);
        const up = () => {
          minimap.removeEventListener('pointermove', panToMinimap);
          minimap.removeEventListener('pointerup', up);
          miniHeld = null;
          drawMinimap();
        };
        minimap.addEventListener('pointermove', panToMinimap);
        minimap.addEventListener('pointerup', up);
      });

      document.querySelectorAll('.legend-row').forEach((row) => {
        const kind = row.dataset.filter;
        row.append(icon('check', 14));
        row.setAttribute('aria-pressed', String(shown[kind] !== false));
        row.addEventListener('click', () => {
          shown[kind] = !shown[kind];
          row.setAttribute('aria-pressed', String(shown[kind]));
          saveState();
          drawEdges();
        });
      });

      const typing = (target) => target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
      document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          searchInput.focus();
          searchInput.select();
          return;
        }
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
        else if (event.key === '/') searchInput.focus();
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

      window.addEventListener('resize', () => {
        if (!graph) return;
        sizeBoard();
        drawMinimap();
      });
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
        if (message.type !== 'reposResult' && message.type !== 'mapResult') return;
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

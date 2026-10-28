import { analyzePrompt, type PromptAnalysis } from '../core/analysis';
import { classifyWorkCategory, type CategoryClassification } from '../core/category';
import { refinePrompt } from '../core/refine';
import type { LinkKind } from '../broker/catalog';
import { LINE_SHAPES, LINE_STYLES, type MapPosition, type MapSettings, type RepoCatalogService, type RepoCatalogView, type RepoGraph } from './repos';
import type {
  ContextPreview,
  Mode,
  OutputStyle,
  PromptTarget,
  RepositoryContext,
  WorkCategory
} from '../core/types';

export interface ClipboardWriter {
  writeText(text: string): PromiseLike<void>;
}

export interface ContextScanner {
  scan(input: {
    rawPrompt: string;
    targetPath: string;
    scope: 'targeted' | 'architecture';
  }): Promise<ContextPreview>;
  /** Routes the task through the workspace's architecture map. Undefined when there is no usable map. */
  routeMap?(input: { rawPrompt: string }): Promise<MapContext | undefined>;
  /** Checks the whole architecture map for the status line. */
  mapStatus?(): Promise<MapStatus>;
}

export interface MapStatus {
  path: string;
  exists: boolean;
  areas: number;
  routes: number;
  stale: string[];
  error?: string;
}

export interface MapContext {
  /** Matched area names, best first. Empty when nothing in the map matched the task. */
  areas: string[];
  routes: string[];
  stale: string[];
}

export interface EditorTools {
  getActiveFilePath(): string | undefined;
  getSelectedText(): string | undefined;
  getDiagnosticsText?(): string | undefined;
  /** Opens the architecture map, creating it from a template when missing. Returns its workspace-relative path. */
  openArchitectureMap?(): PromiseLike<string>;
  /** Asks the user's agent to write or rewrite the architecture map. Returns what happened, for the status line. */
  generateArchitectureMap?(): PromiseLike<string>;
  openText(text: string): PromiseLike<void>;
}

interface RefineRequest {
  type: 'refine';
  requestId: number;
  rawPrompt: string;
  targetPath: string;
  mode: Mode;
  category?: WorkCategory;
  outputStyle?: OutputStyle;
  target?: PromptTarget;
  acceptanceCriteria?: string;
  repositoryContext?: RepositoryContext;
}

interface CopyRequest {
  type: 'copy';
  requestId: number;
  text: string;
}

interface ScanContextRequest {
  type: 'scanContext';
  requestId: number;
  rawPrompt: string;
  targetPath: string;
  scope: 'targeted' | 'architecture';
}

type ToolName = 'activeFile' | 'editorSelection' | 'diagnostics' | 'architectureMap' | 'generateMap' | 'openInEditor';

interface ToolRequest {
  type: 'tool';
  requestId: number;
  tool: ToolName;
  text?: string;
}

interface MapStatusRequest {
  type: 'mapStatus';
  requestId: number;
}

interface ClassifyRequest {
  type: 'classify';
  requestId: number;
  rawPrompt: string;
  category?: WorkCategory;
}

type RepoAction =
  | 'list' | 'grant' | 'revoke' | 'clearGrants' | 'setDefault' | 'add' | 'remove'
  | 'graph' | 'addDependency' | 'removeDependency' | 'addLink' | 'removeLink' | 'saveLayout' | 'pickFile' | 'openMap'
  | 'connect' | 'disconnect';
const REPO_ACTIONS: readonly RepoAction[] = [
  'list', 'grant', 'revoke', 'clearGrants', 'setDefault', 'add', 'remove',
  'graph', 'addDependency', 'removeDependency', 'addLink', 'removeLink', 'saveLayout', 'pickFile', 'openMap',
  'connect', 'disconnect'
];
/** Actions that name one repository. */
const NAMED_REPO_ACTIONS: readonly RepoAction[] = ['grant', 'revoke', 'setDefault', 'remove', 'pickFile', 'connect', 'disconnect'];
/** Actions between two repositories or two `repo:path` file ends. */
const PAIR_REPO_ACTIONS: readonly RepoAction[] = ['addDependency', 'removeDependency', 'addLink', 'removeLink'];
const LINK_KIND_VALUES: readonly string[] = ['api', 'type', 'event', 'schema', 'config', 'other'];
const MAX_LINK_END = 600;
const MAX_LAYOUT_NODES = 200;

interface ReposRequest {
  type: 'repos';
  requestId: number;
  action: RepoAction;
  name?: string;
  hours?: number;
  from?: string;
  to?: string;
  kind?: LinkKind;
  note?: string;
  positions?: Record<string, MapPosition>;
  settings?: MapSettings;
}

export type WebviewResponse =
  | {
      type: 'refineResult';
      requestId: number;
      refinedPrompt: string;
      mode: Mode;
      category: WorkCategory;
      /** Present only for Auto detect: what was found when Refine was pressed. */
      classification?: CategoryClassification;
    }
  | {
      type: 'refineError';
      requestId: number;
      message: string;
    }
  | {
      type: 'copyResult';
      requestId: number;
      success: boolean;
      message: string;
    }
  | {
      type: 'contextResult';
      requestId: number;
      context: ContextPreview;
    }
  | {
      type: 'contextError';
      requestId: number;
      message: string;
    }
  | {
      type: 'toolResult';
      requestId: number;
      tool: ToolName;
      success: boolean;
      value?: string;
      message: string;
    }
  | {
      type: 'mapStatusResult';
      requestId: number;
      status: MapStatus;
    }
  | {
      type: 'classificationResult';
      requestId: number;
      classification: CategoryClassification;
      analysis: PromptAnalysis;
    }
  | {
      type: 'reposResult';
      requestId: number;
      success: boolean;
      message: string;
      /** The catalog after the action. Absent when it could not be read. */
      view?: RepoCatalogView;
      /** The full map data, for the graph action. */
      graph?: RepoGraph;
      /** A picked file path, for the pickFile action. */
      value?: string;
    };

export async function handleWebviewRequest(
  message: unknown,
  clipboard: ClipboardWriter,
  contextScanner?: ContextScanner,
  editorTools?: EditorTools,
  repoCatalog?: RepoCatalogService
): Promise<WebviewResponse | undefined> {
  if (isReposRequest(message)) {
    return useRepoCatalog(message, repoCatalog);
  }

  if (isRecord(message) && message.type === 'mapStatus' && Number.isSafeInteger(message.requestId)) {
    const request = message as unknown as MapStatusRequest;
    const status = contextScanner?.mapStatus
      ? await contextScanner.mapStatus()
      : { path: '.tokio/map.md', exists: false, areas: 0, routes: 0, stale: [], error: 'Architecture maps are unavailable here.' };
    return { type: 'mapStatusResult', requestId: request.requestId, status };
  }

  if (isClassifyRequest(message)) {
    const classification = classifyWorkCategory(message.rawPrompt);
    return {
      type: 'classificationResult',
      requestId: message.requestId,
      classification,
      analysis: analyzePrompt(message.rawPrompt, message.category ?? classification.category)
    };
  }

  if (isToolRequest(message)) {
    return useEditorTool(message, editorTools);
  }

  if (isScanContextRequest(message)) {
    if (!contextScanner) {
      return {
        type: 'contextError',
        requestId: message.requestId,
        message: 'Repository context scanning is unavailable.'
      };
    }

    try {
      return {
        type: 'contextResult',
        requestId: message.requestId,
        context: await contextScanner.scan(message)
      };
    } catch (error: unknown) {
      return {
        type: 'contextError',
        requestId: message.requestId,
        message: error instanceof Error ? error.message : 'Unable to scan repository context.'
      };
    }
  }

  if (isCopyRequest(message)) {
    return copyToClipboard(message, clipboard);
  }

  if (!isRefineRequest(message)) {
    return undefined;
  }

  try {
    const classification = classifyWorkCategory(message.rawPrompt);
    const category = message.category ?? classification.category;
    const repositoryContext = await withMapRoutes(message, contextScanner);
    const result = refinePrompt({
      rawPrompt: message.rawPrompt,
      targetPath: message.targetPath,
      mode: message.mode,
      category,
      additionalCategories: message.category ? undefined : classification.additional,
      outputStyle: message.outputStyle,
      target: message.target,
      acceptanceCriteria: message.acceptanceCriteria,
      repositoryContext
    });
    return {
      type: 'refineResult',
      requestId: message.requestId,
      refinedPrompt: result.refinedPrompt,
      mode: result.mode,
      category: result.category,
      ...(message.category ? {} : { classification })
    };
  } catch (error: unknown) {
    return {
      type: 'refineError',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Unable to refine this prompt.'
    };
  }
}

/**
 * Adds the workspace architecture map's routes to the repository context. Without a map, or when no area
 * matches, the context is returned as sent. A map that cannot be read never blocks a refine; the status line reports it.
 */
async function withMapRoutes(
  message: RefineRequest,
  contextScanner: ContextScanner | undefined
): Promise<RepositoryContext | undefined> {
  const routed = await contextScanner?.routeMap?.({ rawPrompt: message.rawPrompt }).catch(() => undefined);
  if (!routed || routed.areas.length === 0) {
    return message.repositoryContext;
  }
  return {
    ...(message.repositoryContext ?? { scope: 'targeted', files: [] }),
    mapRoutes: routed.routes,
    mapStale: routed.stale
  };
}

async function useRepoCatalog(
  message: ReposRequest,
  repoCatalog: RepoCatalogService | undefined
): Promise<WebviewResponse> {
  const result = (success: boolean, text: string, view?: RepoCatalogView, extra: { graph?: RepoGraph; value?: string } = {}): WebviewResponse => ({
    type: 'reposResult',
    requestId: message.requestId,
    success,
    message: text,
    ...(view ? { view } : {}),
    ...(extra.graph ? { graph: extra.graph } : {}),
    ...(extra.value !== undefined ? { value: extra.value } : {})
  });
  if (!repoCatalog) {
    return result(false, 'Repository settings are unavailable.');
  }

  const name = message.name ?? '';
  try {
    switch (message.action) {
      case 'list':
        return result(true, '', await repoCatalog.list());
      case 'grant': {
        const hours = message.hours ?? 4;
        return result(true, `${name} accepts edits for ${hours} hour${hours === 1 ? '' : 's'}.`, await repoCatalog.grant(name, hours));
      }
      case 'revoke':
        return result(true, `${name} is read-only again.`, await repoCatalog.revoke(name));
      case 'clearGrants':
        return result(true, 'Only the write target accepts edits.', await repoCatalog.clearGrants());
      case 'connect':
        return result(true, `Messaging with ${name} is on.`, await repoCatalog.setMessaging(name, true));
      case 'disconnect':
        return result(true, `Messaging with ${name} is off.`, await repoCatalog.setMessaging(name, false));
      case 'setDefault':
        return result(true, `${name} is now the write target.`, await repoCatalog.setDefault(name));
      case 'add': {
        const view = await repoCatalog.add();
        return view ? result(true, `Added ${view.repos.at(-1)?.name ?? 'the repository'}.`, view) : result(false, 'No folder chosen.');
      }
      case 'remove': {
        const view = await repoCatalog.remove(name);
        return view ? result(true, `Removed ${name} from the catalog.`, view) : result(false, 'Kept the repository.');
      }
      case 'graph':
        return result(true, '', undefined, { graph: await repoCatalog.graph() });
      case 'addDependency':
        return result(true, `${message.from} now depends on ${message.to}.`, await repoCatalog.addDependency(message.from ?? '', message.to ?? ''));
      case 'removeDependency':
        return result(true, `${message.from} no longer depends on ${message.to}.`, await repoCatalog.removeDependency(message.from ?? '', message.to ?? ''));
      case 'addLink':
        return result(true, `Linked ${message.from} to ${message.to}.`, await repoCatalog.addLink({
          from: message.from ?? '',
          to: message.to ?? '',
          kind: message.kind ?? 'other',
          ...(message.note ? { note: message.note } : {})
        }));
      case 'removeLink':
        return result(true, `Removed the link between ${message.from} and ${message.to}.`, await repoCatalog.removeLink(message.from ?? '', message.to ?? ''));
      case 'saveLayout':
        await repoCatalog.saveLayout(message.positions ?? {}, message.settings);
        return result(true, 'Layout saved.');
      case 'pickFile': {
        const picked = await repoCatalog.pickFile(name);
        return picked === undefined ? result(false, 'No file chosen.') : result(true, '', undefined, { value: picked });
      }
      case 'openMap':
        repoCatalog.openMap();
        return result(true, 'Opened the repository map.');
    }
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : 'Unable to update the repositories.';
    // Show the catalog as it is now, when it can still be read.
    const view = await repoCatalog.list().catch(() => undefined);
    return result(false, text, view);
  }
}

async function useEditorTool(
  message: ToolRequest,
  editorTools: EditorTools | undefined
): Promise<WebviewResponse> {
  if (!editorTools) {
    return toolResult(message, false, 'Editor tools are unavailable.');
  }

  if (message.tool === 'activeFile') {
    const path = editorTools.getActiveFilePath();
    return path
      ? toolResult(message, true, 'Using the active workspace file.', path)
      : toolResult(message, false, 'Open a file inside the current workspace first.');
  }

  if (message.tool === 'editorSelection') {
    const selection = editorTools.getSelectedText();
    return selection
      ? toolResult(message, true, 'Loaded the current editor selection.', selection)
      : toolResult(message, false, 'Select text in an editor first.');
  }

  if (message.tool === 'generateMap') {
    try {
      const sent = await editorTools.generateArchitectureMap?.();
      return sent
        ? toolResult(message, true, sent)
        : toolResult(message, false, 'Map generation is unavailable here.');
    } catch (error: unknown) {
      return toolResult(message, false, error instanceof Error ? error.message : 'Could not send the map request.');
    }
  }

  if (message.tool === 'architectureMap') {
    try {
      const path = await editorTools.openArchitectureMap?.();
      return path
        ? toolResult(message, true, `Opened ${path}. Saving it updates the map status.`, path)
        : toolResult(message, false, 'Architecture maps are unavailable here.');
    } catch (error: unknown) {
      return toolResult(message, false, error instanceof Error ? error.message : 'Could not open the architecture map.');
    }
  }

  if (message.tool === 'diagnostics') {
    const diagnostics = editorTools.getDiagnosticsText?.();
    return diagnostics
      ? toolResult(message, true, 'Added the current errors and warnings.', diagnostics)
      : toolResult(message, false, 'No errors or warnings in the active file.');
  }

  if (!message.text) {
    return toolResult(message, false, 'There is no refined prompt to open.');
  }

  try {
    await editorTools.openText(message.text);
    return toolResult(message, true, 'Opened the current refined prompt in an editor.');
  } catch {
    return toolResult(message, false, 'Could not open the refined prompt in an editor.');
  }
}

function toolResult(
  request: ToolRequest,
  success: boolean,
  message: string,
  value?: string
): WebviewResponse {
  return {
    type: 'toolResult',
    requestId: request.requestId,
    tool: request.tool,
    success,
    value,
    message
  };
}

async function copyToClipboard(
  message: CopyRequest,
  clipboard: ClipboardWriter
): Promise<WebviewResponse> {
  if (message.text.length === 0) {
    return {
      type: 'copyResult',
      requestId: message.requestId,
      success: false,
      message: 'Nothing to copy.'
    };
  }

  try {
    await clipboard.writeText(message.text);
    return {
      type: 'copyResult',
      requestId: message.requestId,
      success: true,
      message: 'Copied the current refined prompt.'
    };
  } catch {
    return {
      type: 'copyResult',
      requestId: message.requestId,
      success: false,
      message: 'Could not copy the refined prompt.'
    };
  }
}

function isRefineRequest(message: unknown): message is RefineRequest {
  if (!isRecord(message)) {
    return false;
  }

  return message.type === 'refine'
    && Number.isSafeInteger(message.requestId)
    && typeof message.rawPrompt === 'string'
    && typeof message.targetPath === 'string'
    && isMode(message.mode)
    && (message.category === undefined || isCategory(message.category))
    && (message.outputStyle === undefined || isOutputStyle(message.outputStyle))
    && (message.target === undefined || isPromptTarget(message.target))
    && (message.acceptanceCriteria === undefined
      || (typeof message.acceptanceCriteria === 'string' && message.acceptanceCriteria.length <= 5000))
    && isRepositoryContext(message.repositoryContext);
}

function isCopyRequest(message: unknown): message is CopyRequest {
  if (!isRecord(message)) {
    return false;
  }

  return message.type === 'copy'
    && Number.isSafeInteger(message.requestId)
    && typeof message.text === 'string';
}

function isScanContextRequest(message: unknown): message is ScanContextRequest {
  if (!isRecord(message)) {
    return false;
  }

  return message.type === 'scanContext'
    && Number.isSafeInteger(message.requestId)
    && typeof message.rawPrompt === 'string'
    && typeof message.targetPath === 'string'
    && (message.scope === 'targeted' || message.scope === 'architecture');
}

function isToolRequest(message: unknown): message is ToolRequest {
  if (!isRecord(message)) {
    return false;
  }

  const validTool = message.tool === 'activeFile'
    || message.tool === 'editorSelection'
    || message.tool === 'diagnostics'
    || message.tool === 'architectureMap'
    || message.tool === 'generateMap'
    || message.tool === 'openInEditor';
  return message.type === 'tool'
    && Number.isSafeInteger(message.requestId)
    && validTool
    && (message.text === undefined || (typeof message.text === 'string' && message.text.length <= 200_000));
}

function isReposRequest(message: unknown): message is ReposRequest {
  if (!isRecord(message) || message.type !== 'repos' || typeof message.requestId !== 'number') {
    return false;
  }
  const action = message.action as RepoAction;
  if (!REPO_ACTIONS.includes(action)) {
    return false;
  }
  if (NAMED_REPO_ACTIONS.includes(action) && (typeof message.name !== 'string' || message.name.length === 0 || message.name.length > 64)) {
    return false;
  }
  const isEnd = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= MAX_LINK_END;
  if (PAIR_REPO_ACTIONS.includes(action) && (!isEnd(message.from) || !isEnd(message.to))) {
    return false;
  }
  if (message.kind !== undefined && (typeof message.kind !== 'string' || !LINK_KIND_VALUES.includes(message.kind))) {
    return false;
  }
  if (message.note !== undefined && (typeof message.note !== 'string' || message.note.length > 200)) {
    return false;
  }
  if (action === 'saveLayout' && (!isLayout(message.positions) || (message.settings !== undefined && !isMapSettings(message.settings)))) {
    return false;
  }
  return message.hours === undefined
    || (typeof message.hours === 'number' && Number.isInteger(message.hours) && message.hours >= 1 && message.hours <= 24);
}

function isMapSettings(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.styles) || typeof value.snap !== 'boolean') {
    return false;
  }
  const styles = value.styles;
  return (LINE_SHAPES as readonly unknown[]).includes(value.shape)
    && ['dependency', 'link', 'detected'].every((key) => (LINE_STYLES as readonly unknown[]).includes(styles[key]));
}

function isLayout(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return entries.length <= MAX_LAYOUT_NODES && entries.every(([name, position]) => name.length <= 64
    && isRecord(position)
    && typeof position.x === 'number' && Number.isFinite(position.x)
    && typeof position.y === 'number' && Number.isFinite(position.y));
}

function isClassifyRequest(message: unknown): message is ClassifyRequest {
  return isRecord(message)
    && message.type === 'classify'
    && Number.isSafeInteger(message.requestId)
    && typeof message.rawPrompt === 'string'
    && message.rawPrompt.length <= 200_000
    && (message.category === undefined || isCategory(message.category));
}

function isRepositoryContext(value: unknown): value is RepositoryContext | undefined {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || (value.scope !== 'targeted' && value.scope !== 'architecture')) {
    return false;
  }
  if (!Array.isArray(value.files)
    || value.files.length > 5
    || !value.files.every((file) => typeof file === 'string' && file.length <= 1000)) {
    return false;
  }
  // Map routes are added by the extension after validation; the webview never sends them.
  if (value.mapRoutes !== undefined || value.mapStale !== undefined) {
    return false;
  }
  return (value.architectureNotes === undefined
    || (typeof value.architectureNotes === 'string' && value.architectureNotes.length <= 1200))
    && isShortStringList(value.relatedTests)
    && isShortStringList(value.conventionFiles)
    && isShortStringList(value.validationCommands);
}

function isShortStringList(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value)
      && value.length <= 5
      && value.every((item) => typeof item === 'string' && item.length <= 300));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMode(mode: unknown): mode is Mode {
  return mode === 'minimal' || mode === 'adaptive' || mode === 'strict';
}

function isCategory(category: unknown): category is WorkCategory {
  return category === 'general'
    || category === 'bug'
    || category === 'hotfix'
    || category === 'feature'
    || category === 'enhancement'
    || category === 'ui'
    || category === 'refactor'
    || category === 'performance'
    || category === 'tests'
    || category === 'documentation'
    || category === 'investigation'
    || category === 'decision'
    || category === 'planning'
    || category === 'workflow'
    || category === 'security'
    || category === 'migration'
    || category === 'dependency'
    || category === 'review'
    || category === 'other';
}

function isPromptTarget(value: unknown): value is PromptTarget {
  return value === 'generic' || value === 'claude' || value === 'codex';
}

function isOutputStyle(value: unknown): value is OutputStyle {
  return value === 'compact' || value === 'detailed';
}

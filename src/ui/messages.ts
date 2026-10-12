import { analyzePrompt, type PromptAnalysis } from '../core/analysis';
import { classifyWorkCategory, type CategoryClassification } from '../core/category';
import { refinePrompt } from '../core/refine';
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
}

export interface EditorTools {
  getActiveFilePath(): string | undefined;
  getSelectedText(): string | undefined;
  getDiagnosticsText?(): string | undefined;
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

type ToolName = 'activeFile' | 'editorSelection' | 'diagnostics' | 'openInEditor';

interface ToolRequest {
  type: 'tool';
  requestId: number;
  tool: ToolName;
  text?: string;
}

interface ClassifyRequest {
  type: 'classify';
  requestId: number;
  rawPrompt: string;
  category?: WorkCategory;
}

export type WebviewResponse =
  | {
      type: 'refineResult';
      requestId: number;
      refinedPrompt: string;
      mode: Mode;
      category: WorkCategory;
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
      type: 'classificationResult';
      requestId: number;
      classification: CategoryClassification;
      analysis: PromptAnalysis;
    };

export async function handleWebviewRequest(
  message: unknown,
  clipboard: ClipboardWriter,
  contextScanner?: ContextScanner,
  editorTools?: EditorTools
): Promise<WebviewResponse | undefined> {
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
    const result = refinePrompt({
      rawPrompt: message.rawPrompt,
      targetPath: message.targetPath,
      mode: message.mode,
      category,
      secondaryCategory: message.category ? undefined : classification.secondary,
      outputStyle: message.outputStyle,
      target: message.target,
      acceptanceCriteria: message.acceptanceCriteria,
      repositoryContext: message.repositoryContext
    });
    return {
      type: 'refineResult',
      requestId: message.requestId,
      refinedPrompt: result.refinedPrompt,
      mode: result.mode,
      category: result.category
    };
  } catch (error: unknown) {
    return {
      type: 'refineError',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Unable to refine this prompt.'
    };
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
    || message.tool === 'openInEditor';
  return message.type === 'tool'
    && Number.isSafeInteger(message.requestId)
    && validTool
    && (message.text === undefined || (typeof message.text === 'string' && message.text.length <= 200_000));
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
    || category === 'feature'
    || category === 'enhancement'
    || category === 'refactor'
    || category === 'performance'
    || category === 'tests'
    || category === 'documentation'
    || category === 'investigation'
    || category === 'other';
}

function isPromptTarget(value: unknown): value is PromptTarget {
  return value === 'generic' || value === 'claude' || value === 'codex';
}

function isOutputStyle(value: unknown): value is OutputStyle {
  return value === 'compact' || value === 'detailed';
}

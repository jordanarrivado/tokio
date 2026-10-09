export type Mode = 'minimal' | 'adaptive' | 'strict';
export type ContextScope = 'none' | 'targeted' | 'architecture';
export type OutputStyle = 'compact' | 'detailed';
export type WorkCategory =
  | 'general'
  | 'bug'
  | 'feature'
  | 'enhancement'
  | 'refactor'
  | 'performance'
  | 'tests'
  | 'documentation'
  | 'investigation'
  | 'other';

export interface RepositoryContext {
  scope: Exclude<ContextScope, 'none'>;
  files: string[];
  architectureNotes?: string;
}

export interface ContextPreview extends RepositoryContext {
  notices: string[];
  inspectedFiles: string[];
}

export interface RefineInput {
  rawPrompt: string;
  targetPath?: string;
  mode?: Mode;
  category?: WorkCategory;
  outputStyle?: OutputStyle;
  repositoryContext?: RepositoryContext;
}

export interface RefineOutput {
  refinedPrompt: string;
  mode: Mode;
  category: WorkCategory;
}

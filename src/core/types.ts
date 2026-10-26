export type Mode = 'minimal' | 'adaptive' | 'strict';
export type ContextScope = 'none' | 'targeted' | 'architecture';
export type OutputStyle = 'compact' | 'detailed';
export type PromptTarget = 'generic' | 'claude' | 'codex';
export type WorkCategory =
  | 'general'
  | 'bug'
  | 'hotfix'
  | 'feature'
  | 'enhancement'
  | 'ui'
  | 'refactor'
  | 'performance'
  | 'tests'
  | 'documentation'
  | 'investigation'
  | 'decision'
  | 'planning'
  | 'workflow'
  | 'security'
  | 'migration'
  | 'dependency'
  | 'review'
  | 'other';

export interface RepositoryContext {
  scope: Exclude<ContextScope, 'none'>;
  files: string[];
  architectureNotes?: string;
  /** Test files that sit next to the suggested source files. */
  relatedTests?: string[];
  /** Agent instruction files found at the repository root (CLAUDE.md, AGENTS.md, ...). */
  conventionFiles?: string[];
  /** Real validation commands detected from project manifests. */
  validationCommands?: string[];
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
  target?: PromptTarget;
  /** Other kinds of work in the same task; each adds one short guidance line. */
  additionalCategories?: WorkCategory[];
  acceptanceCriteria?: string;
  repositoryContext?: RepositoryContext;
}

export interface RefineOutput {
  refinedPrompt: string;
  mode: Mode;
  category: WorkCategory;
}

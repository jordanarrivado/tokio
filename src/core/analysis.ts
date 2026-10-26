import type { WorkCategory } from './types';

export type ClarityLevel = 'low' | 'medium' | 'high';

export interface PromptAnalysis {
  /** 0-100 specificity score; higher means fewer gaps were detected. */
  score: number;
  level: ClarityLevel;
  /** Short, actionable suggestions for information the prompt is missing. */
  hints: string[];
  splitSuggested: boolean;
}

const MAX_HINTS = 4;
const HINT_PENALTY = 20;

const FILE_OR_SYMBOL = /(?:[\w@-]+[\\/])+[\w.-]+|\b[\w-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|css|scss|html|vue|svelte|json|ya?ml|md|sql)\b|`[^`]+`|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b|\b\w+_\w+\b/;
const EXPECTED_BEHAVIOR = /\b(?:expected|should|instead|supposed|ought|want(?:ed)?\s+to|must)\b/i;
const REPRODUCTION = /\b(?:error|exception|stack\s*trace|traceback|steps?|repro(?:duce|duction)?|when|after|whenever|only\s+if)\b|```|\bat\s+\S+:\d+/i;
const ACCEPTANCE = /\b(?:should|must|so\s+that|acceptance|done\s+when|expected|when\s+the)\b/i;
const UNCHANGED = /\b(?:without\s+changing|unchanged|preserve|keep|same\s+behavio(?:u)?r|no\s+behavio(?:u)?r\s+change)\b/i;
const UI_STATES = /\b(?:mobile|tablet|desktop|width|px|responsive|empty|loading|error|disabled|state)\b/i;
const ROLLBACK = /\b(?:rollback|roll\s+back|revert|down\s+migration|downtime|keep\s+(?:the\s+)?data|existing\s+data)\b/i;
const VERSION = /\b(?:v?\d+(?:\.\d+)+|latest|next\s+major)\b/i;
const OPTIONS = /\b(?:options?|alternatives?|versus|vs\.?|or)\b/i;
const METRIC = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|%|mb|kb|gb|x)\b|\b(?:baseline|target|budget|under|below|at\s+most|p9[59])\b/i;

export function analyzePrompt(rawPrompt: string, category: WorkCategory): PromptAnalysis {
  const text = rawPrompt.trim();
  if (text.length === 0) {
    return { score: 0, level: 'low', hints: [], splitSuggested: false };
  }

  const hints: string[] = [];
  if (text.length < 40) {
    hints.push('Describe the change in more detail: what, where, and why.');
  }
  if (!FILE_OR_SYMBOL.test(text)) {
    hints.push('Name the file, component, or function involved, or set a Starting file.');
  }

  switch (category) {
    case 'ui':
      if (!UI_STATES.test(text)) {
        hints.push('Name the states and widths to cover, such as empty, loading, error, and mobile.');
      }
      break;
    case 'decision':
      if (!OPTIONS.test(text)) {
        hints.push('List the options you are weighing, or ask for them to be compared.');
      }
      break;
    case 'planning':
      if (!ACCEPTANCE.test(text)) {
        hints.push('Add the goal and what done looks like, so the plan has checks to aim at.');
      }
      break;
    case 'migration':
      if (!ROLLBACK.test(text)) {
        hints.push('Say whether existing data must be kept and how to roll back.');
      }
      break;
    case 'dependency':
      if (!VERSION.test(text)) {
        hints.push('Name the target version, such as 5.2.0 or latest.');
      }
      break;
    case 'bug':
    case 'hotfix':
      if (!EXPECTED_BEHAVIOR.test(text)) {
        hints.push('Add the expected behavior versus what actually happens.');
      }
      if (!REPRODUCTION.test(text)) {
        hints.push('Add reproduction steps or the exact error text.');
      }
      break;
    case 'feature':
    case 'enhancement':
      if (!ACCEPTANCE.test(text)) {
        hints.push('Add acceptance criteria: how will you know it is done?');
      }
      break;
    case 'refactor':
      if (!UNCHANGED.test(text)) {
        hints.push('State what behavior or public API must stay unchanged.');
      }
      break;
    case 'performance':
      if (!METRIC.test(text)) {
        hints.push('Add a baseline or target, such as a time, size, or percentage.');
      }
      break;
    default:
      break;
  }

  const splitSuggested = looksLikeSeveralTasks(text);
  if (splitSuggested) {
    hints.push('This looks like several tasks. Consider one prompt per task to keep the agent focused.');
  }

  const shown = hints.slice(0, MAX_HINTS);
  const score = Math.max(0, 100 - hints.length * HINT_PENALTY);
  const level: ClarityLevel = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low';
  return { score, level, hints: shown, splitSuggested };
}

function looksLikeSeveralTasks(text: string): boolean {
  const listItems = text.match(/^\s*(?:\d+[.)]|[-*•])\s+\S/gm)?.length ?? 0;
  const connectors = text.match(/\b(?:also|additionally|as\s+well\s+as|and\s+then|on\s+top\s+of\s+that)\b/gi)?.length ?? 0;
  return listItems >= 3 || connectors >= 2;
}

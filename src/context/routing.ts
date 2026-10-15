import type { ClassificationConfidence } from '../core/category';
import type { WorkCategory } from '../core/types';
import { countTermHits, extractSearchTerms } from './discovery';
import type { RepoFile } from './repomap';

/**
 * Deterministic, advisory routing. Nothing here calls a model. The tier and phase recommendations
 * come from file counts, module spread, risk terms, and task structure. The thresholds are first
 * guesses, to be tuned from experiment results.
 */

export type RouteTier = 'small' | 'medium' | 'large';
export type RouteConfidence = 'low' | 'medium' | 'high';
export type ModelTier = 'large' | 'mid' | 'none';

/** Model aliases live in one place, so renaming a model touches only this file. */
export const MODEL_ALIASES: Record<'large' | 'mid', string> = { large: 'opus', mid: 'sonnet' };

/** Substring-style on purpose: "auth" also matches authorize, authentication, and author. */
const RISK_PATTERN = /\b(?:migrat\w*|schema|auth\w*|security|payroll|concurren\w*|encrypt\w*|permission\w*|transaction\w*)\b/gi;
const MIN_CONTENT_TERM_HITS = 2;
const COMMON_TERM_FLOOR = 3;
const COMMON_TERM_SHARE = 0.25;
const MEDIUM_FILES = 3;
const LARGE_FILES = 8;
const MEDIUM_MODULES = 2;
const LARGE_MODULES = 3;
const MEDIUM_REQUIREMENTS = 3;
const LARGE_REQUIREMENTS = 6;

export interface RouteInput {
  task: string;
  relevantFiles: readonly string[];
  category: WorkCategory;
  categoryConfidence: ClassificationConfidence;
}

export interface RouteSignals {
  category: WorkCategory;
  categoryConfidence: ClassificationConfidence;
  relevantFiles: number;
  modules: number;
  riskTerms: string[];
  requirements: number;
  taskWords: number;
}

export interface PhaseRecommendation {
  phase: 'plan' | 'execute' | 'validate';
  model: ModelTier;
  note: string;
}

export interface RoutePlan {
  tier: RouteTier;
  confidence: RouteConfidence;
  signals: RouteSignals;
  reasons: string[];
  phases: PhaseRecommendation[];
}

/**
 * Files that match the task by a specific term in their path, or by at least two specific terms in
 * their content, plus the target. Terms that appear in too many files are ignored.
 */
export function findRelevantFiles(files: readonly RepoFile[], task: string, targetPath?: string): string[] {
  const target = targetPath?.replaceAll('\\', '/');
  const specific = specificTerms(files, extractSearchTerms(task));
  return files
    .filter((file) => {
      if (target !== undefined && file.path === target) {
        return true;
      }
      if (specific.length === 0) {
        return false;
      }
      return countTermHits(file.path.toLowerCase(), specific) > 0
        || countTermHits(file.content, specific) >= MIN_CONTENT_TERM_HITS;
    })
    .map((file) => file.path);
}

/** A term is common when it appears in more than max(3, 25%) of files. Common terms say little about relevance. */
function specificTerms(files: readonly RepoFile[], terms: readonly string[]): string[] {
  const limit = Math.max(COMMON_TERM_FLOOR, Math.ceil(files.length * COMMON_TERM_SHARE));
  const haystacks = files.map((file) => `${file.path}\n${file.content}`.toLowerCase());
  return terms.filter((term) => haystacks.filter((text) => text.includes(term)).length <= limit);
}

export function buildRouteSignals(input: RouteInput): RouteSignals {
  const riskTerms = [...new Set((input.task.match(RISK_PATTERN) ?? []).map((term) => term.toLowerCase()))];
  return {
    category: input.category,
    categoryConfidence: input.categoryConfidence,
    relevantFiles: input.relevantFiles.length,
    modules: new Set(input.relevantFiles.map(topLevelModule)).size,
    riskTerms,
    requirements: countRequirements(input.task),
    taskWords: input.task.trim().split(/\s+/).filter((word) => word.length > 0).length
  };
}

export function decideTier(signals: RouteSignals): { tier: RouteTier; reasons: string[] } {
  const largeReasons = matchedReasons([
    [signals.relevantFiles >= LARGE_FILES, `${signals.relevantFiles} relevant files`],
    [signals.modules >= LARGE_MODULES, `${signals.modules} modules`],
    [signals.riskTerms.length >= 2, `risk terms: ${signals.riskTerms.join(', ')}`],
    [signals.requirements >= LARGE_REQUIREMENTS, `${signals.requirements} requirements`]
  ]);
  if (largeReasons.length > 0) {
    return { tier: 'large', reasons: largeReasons };
  }

  const mediumReasons = matchedReasons([
    [signals.relevantFiles >= MEDIUM_FILES, `${signals.relevantFiles} relevant files`],
    [signals.modules >= MEDIUM_MODULES, `${signals.modules} modules`],
    [signals.riskTerms.length === 1, `risk term: ${signals.riskTerms[0]}`],
    [signals.requirements >= MEDIUM_REQUIREMENTS, `${signals.requirements} requirements`]
  ]);
  if (mediumReasons.length > 0) {
    return { tier: 'medium', reasons: mediumReasons };
  }
  return { tier: 'small', reasons: ['few relevant files, one module, no risk terms'] };
}

export function decideConfidence(signals: RouteSignals, tier: RouteTier): RouteConfidence {
  // No repository evidence, or a large tier driven by keywords alone, means the signals disagree.
  if (signals.relevantFiles === 0) {
    return 'low';
  }
  if (tier === 'large' && signals.relevantFiles < MEDIUM_FILES) {
    return 'low';
  }
  return signals.categoryConfidence === 'high' ? 'high' : 'medium';
}

export function planPhases(tier: RouteTier, confidence: RouteConfidence): PhaseRecommendation[] {
  const validate: PhaseRecommendation = { phase: 'validate', model: 'none', note: 'Run the validation command.' };

  if (tier === 'large' && confidence === 'low') {
    return [
      { phase: 'plan', model: 'mid', note: 'Signals disagree, so the large model is not recommended. Plan on the mid model.' },
      { phase: 'execute', model: 'mid', note: 'Follow the plan only.' },
      validate
    ];
  }
  if (tier === 'large') {
    return [
      { phase: 'plan', model: 'large', note: 'Write PLAN.md with steps and acceptance checks. Do not edit source files.' },
      { phase: 'execute', model: 'mid', note: 'Implement only PLAN.md, and report any deviation.' },
      { ...validate, note: 'Run the validation command. If it fails, escalate to the large model.' }
    ];
  }
  if (tier === 'medium') {
    return [
      { phase: 'plan', model: 'none', note: 'Planning is optional. Use it if the change touches shared behavior.' },
      { phase: 'execute', model: 'mid', note: 'Single model.' },
      validate
    ];
  }
  return [
    { phase: 'plan', model: 'none', note: 'Skip planning.' },
    { phase: 'execute', model: 'mid', note: 'Single model.' },
    validate
  ];
}

export function planRoute(input: RouteInput): RoutePlan {
  const signals = buildRouteSignals(input);
  const { tier, reasons } = decideTier(signals);
  const confidence = decideConfidence(signals, tier);
  return { tier, confidence, signals, reasons, phases: planPhases(tier, confidence) };
}

export function formatRoutePlan(plan: RoutePlan, validationCommands: readonly string[]): string {
  const { signals } = plan;
  return [
    'Route (advisory: nothing is switched automatically, and the tier is an estimate)',
    `Tier: ${plan.tier}   Confidence: ${plan.confidence}`,
    `Signals: ${signals.relevantFiles} relevant files, ${signals.modules} modules, `
      + `${signals.requirements} requirement(s), ${signals.taskWords} words; `
      + `category ${signals.category} (${signals.categoryConfidence}); `
      + `risk terms: ${signals.riskTerms.join(', ') || 'none'}`,
    `Why: ${plan.reasons.join('; ')}`,
    'Phases:',
    ...plan.phases.map((phase, index) => `  ${index + 1}. ${phase.phase}: ${modelLabel(phase.model)}. ${phase.note}`),
    validationCommands.length > 0
      ? `Validation: ${validationCommands.join(' ; ')}`
      : 'Validation: none detected',
    `Apply: /model ${MODEL_ALIASES.large} for planning, /model ${MODEL_ALIASES.mid} for execution `
      + '(or claude --model <alias>).'
  ].join('\n');
}

function modelLabel(model: ModelTier): string {
  if (model === 'none') {
    return 'no model change';
  }
  return `${MODEL_ALIASES[model]} (${model})`;
}

function matchedReasons(conditions: readonly (readonly [boolean, string])[]): string[] {
  return conditions.filter(([matched]) => matched).map(([, reason]) => reason);
}

function topLevelModule(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts[0] : '(root)';
}

function countRequirements(task: string): number {
  const bullets = task.split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line)).length;
  return Math.max(1, bullets);
}

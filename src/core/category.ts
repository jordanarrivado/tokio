import type { WorkCategory } from './types';

export type ClassificationConfidence = 'low' | 'medium' | 'high';

export interface CategoryClassification {
  category: WorkCategory;
  confidence: ClassificationConfidence;
  matchedSignals: string[];
  /**
   * Other kinds of work that are clearly present too, strongest first
   * (for example a bug fix that also needs tests and a security check).
   */
  additional?: WorkCategory[];
}

interface Signal {
  pattern: RegExp;
  label: string;
  weight: number;
}

const SIGNALS: Record<Exclude<WorkCategory, 'general' | 'other'>, readonly Signal[]> = {
  hotfix: [
    signal(/\bhot\s?-?fix(?:es)?\b/i, 'hotfix', 6),
    signal(/\b(?:urgent|outage|incident|asap|sev[- ]?[12])\b/i, 'urgent incident', 4),
    signal(/\b(?:in|on)\s+(?:production|prod|live)\b/i, 'production impact', 3)
  ],
  bug: [
    signal(/\b(?:bug|broken|crash(?:es|ed|ing)?|regression)\b/i, 'bug or failure', 5),
    signal(/\bnot\s+working\b/i, 'not working', 5),
    signal(/\b(?:incorrect|unexpected|wrong)\b/i, 'incorrect behavior', 4),
    signal(/\b(?:error|exception|failure|fails?|failed)\b/i, 'error or failure', 3)
  ],
  feature: [
    signal(/\bnew\s+feature\b/i, 'new feature', 6),
    signal(/\badd\s+(?:a|an|the|new)\b/i, 'add capability', 4),
    signal(/\bintroduce\b/i, 'introduce capability', 4),
    signal(/\b(?:implement|create|support)\b/i, 'implement capability', 2)
  ],
  enhancement: [
    signal(/\b(?:enhance|enhancement)\b/i, 'enhancement', 6),
    signal(/\b(?:improve|streamline|simplify)\b/i, 'workflow improvement', 4),
    signal(/\b(?:eliminate|remove)\s+the\s+need\b/i, 'remove unnecessary step', 5),
    signal(/\bmake\s+(?:it|this|the\s+\w+)\s+(?:easier|clearer|better)\b/i, 'usability improvement', 4)
  ],
  refactor: [
    signal(/\brefactor(?:ing)?\b/i, 'refactor', 6),
    signal(/\b(?:restructure|reorganize|cleanup|clean\s+up)\b/i, 'structural cleanup', 4),
    signal(/\bwithout\s+changing\s+(?:behavior|behaviour|functionality)\b/i, 'behavior-preserving change', 5)
  ],
  performance: [
    signal(/\b(?:performance|latency|throughput|benchmark)\b/i, 'performance measurement', 5),
    signal(/\b(?:slow|faster|optimi[sz]e|memory\s+usage)\b/i, 'performance improvement', 4)
  ],
  tests: [
    signal(/\b(?:unit|integration|end-to-end|e2e)\s+tests?\b/i, 'specific test work', 5),
    signal(/\b(?:test\s+coverage|add\s+tests?|write\s+tests?|testing)\b/i, 'test work', 4)
  ],
  documentation: [
    signal(/\b(?:documentation|document|readme|changelog)\b/i, 'documentation', 5),
    signal(/\b(?:docs|jsdoc|docstring)\b/i, 'code documentation', 4)
  ],
  investigation: [
    signal(/\b(?:investigate|diagnose|analy[sz]e|research)\b/i, 'investigation', 6),
    signal(/\b(?:find|determine|identify)\s+the\s+root\s+cause\b/i, 'root-cause investigation', 6),
    signal(/\bwhy\s+(?:does|is|are|did)\b/i, 'diagnostic question', 3)
  ],
  ui: [
    signal(/\b(?:ui|ux|user\s+interface)\b/i, 'user interface', 5),
    signal(/\b(?:redesign|mockup|wireframe|responsive|design\s+system|design\s+tokens?)\b/i, 'visual design', 5),
    signal(/\b(?:screen|layout|styling|css)\b/i, 'screen or layout', 2)
  ],
  decision: [
    signal(/\b(?:architecture|architectural|design\s+decision|trade-?offs?|adr)\b/i, 'architecture decision', 6),
    signal(/\b(?:should\s+we|which\s+(?:approach|option|library)|choose\s+between|compare\s+(?:the\s+)?options)\b/i, 'choice between options', 5),
    signal(/\b(?:new\s+module|hard\s+to\s+reverse)\b/i, 'hard-to-reverse change', 3)
  ],
  planning: [
    signal(/\b(?:plan(?:ning)?|roadmap|break\s+(?:it|this|the\s+\w+)\s+down|scope\s+out|estimate)\b/i, 'planning', 5),
    signal(/\b(?:spec|specification|requirements|user\s+stor(?:y|ies)|milestones?)\b/i, 'requirements', 3),
    signal(/\bbefore\s+(?:coding|implementing|writing\s+(?:any\s+)?code)\b/i, 'plan before code', 3)
  ],
  workflow: [
    signal(/\b(?:ci|ci\/cd|pipelines?|github\s+actions?|gitlab[-\s]ci|jenkins|workflow\s+files?|\.github\/workflows)\b/i, 'CI pipeline', 5),
    signal(/\b(?:automate|automation|cron\s+jobs?|scheduled\s+jobs?|pre-commit|git\s+hooks?)\b/i, 'automation', 4),
    signal(/\b(?:build\s+scripts?|npm\s+scripts?|makefile|dockerfile|docker|deploy(?:ment)?\s+scripts?)\b/i, 'build tooling', 4)
  ],
  security: [
    signal(/\b(?:security|vulnerab\w*|xss|csrf|sql\s+injection|injection|cve-\d+|exploit\w*)\b/i, 'security risk', 6),
    signal(/\b(?:authentication|authori[sz]ation|permissions?|access\s+control|secrets?|encrypt\w*|sanitiz\w*)\b/i, 'access or secrets', 3)
  ],
  migration: [
    signal(/\b(?:migrations?|migrate|schema\s+change|alter\s+table|backfill)\b/i, 'data migration', 6),
    signal(/\b(?:database|db|table|columns?|index(?:es)?)\b/i, 'database', 2)
  ],
  dependency: [
    signal(/\b(?:upgrade|bump|update)\s+(?:the\s+)?(?:[\w@\/.-]+\s+)?(?:dependency|dependencies|packages?|library|libraries|version|sdk|framework)\b/i, 'dependency upgrade', 6),
    signal(/\b(?:npm|yarn|pnpm|pip|composer|nuget)\s+(?:install|update|upgrade|audit)\b/i, 'package manager', 4),
    signal(/\b(?:deprecat\w*|breaking\s+changes?)\b/i, 'breaking change', 3)
  ],
  review: [
    signal(/\b(?:code\s+review|review\s+(?:the\s+|this\s+|my\s+)?(?:pr|pull\s+request|diff|changes?|code))\b/i, 'code review', 6),
    signal(/\b(?:pr|pull\s+request|diff)\b/i, 'pull request', 2)
  ]
};

/** Breaks score ties: the more urgent or risk-bearing work type wins. */
const PRIORITY: readonly WorkCategory[] = [
  'hotfix', 'security', 'bug', 'migration', 'performance', 'feature', 'enhancement', 'ui',
  'refactor', 'dependency', 'workflow', 'tests', 'documentation', 'review', 'investigation',
  'decision', 'planning'
];

const NEGATED_PHRASE = /\b(?:don'?t|do\s+not|never|avoid|no\s+need\s+to)\s+(?:\w+\s+){0,2}\w+/gi;
const MIN_PRIMARY_SCORE = 3;
const ADDITIONAL_MIN_SCORE = 4;
const MAX_ADDITIONAL = 3;

export function classifyWorkCategory(rawPrompt: string): CategoryClassification {
  // "Don't refactor" must not read as a refactor request.
  const text = rawPrompt.replace(NEGATED_PHRASE, ' ');
  const ranked = (Object.entries(SIGNALS) as [WorkCategory, readonly Signal[]][])
    .map(([category, signals]) => ({ category, ...scoreSignals(signals, text) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || priority(left.category) - priority(right.category));

  const best = ranked[0];
  if (!best || best.score < MIN_PRIMARY_SCORE) {
    return { category: 'general', confidence: 'low', matchedSignals: [] };
  }

  const additional = ranked.slice(1)
    .filter((entry) => entry.score >= ADDITIONAL_MIN_SCORE)
    .slice(0, MAX_ADDITIONAL)
    .map((entry) => entry.category);
  const margin = best.score - (ranked[1]?.score ?? 0);
  // Several strong signals are a mixed task, not an unclear one, so they stay medium.
  const confidence: ClassificationConfidence = best.score >= 5 && margin >= 3
    ? 'high'
    : 'medium';
  return {
    category: best.category,
    confidence,
    matchedSignals: best.signals,
    ...(additional.length > 0 ? { additional } : {})
  };
}

function priority(category: WorkCategory): number {
  const index = PRIORITY.indexOf(category);
  return index === -1 ? PRIORITY.length : index;
}

function scoreSignals(signals: readonly Signal[], text: string): { score: number; signals: string[] } {
  let score = 0;
  const matched: string[] = [];
  for (const candidate of signals) {
    if (candidate.pattern.test(text)) {
      score += candidate.weight;
      matched.push(candidate.label);
    }
  }
  return { score, signals: matched };
}

function signal(pattern: RegExp, label: string, weight: number): Signal {
  return { pattern, label, weight };
}

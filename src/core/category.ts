import type { WorkCategory } from './types';

export type ClassificationConfidence = 'low' | 'medium' | 'high';

export interface CategoryClassification {
  category: WorkCategory;
  confidence: ClassificationConfidence;
  matchedSignals: string[];
}

interface Signal {
  pattern: RegExp;
  label: string;
  weight: number;
}

const SIGNALS: Record<Exclude<WorkCategory, 'general' | 'other'>, readonly Signal[]> = {
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
  ]
};

export function classifyWorkCategory(rawPrompt: string): CategoryClassification {
  const scores = new Map<WorkCategory, { score: number; signals: string[] }>();

  for (const [category, signals] of Object.entries(SIGNALS) as [WorkCategory, readonly Signal[]][]) {
    let score = 0;
    const matchedSignals: string[] = [];
    for (const candidate of signals) {
      if (candidate.pattern.test(rawPrompt)) {
        score += candidate.weight;
        matchedSignals.push(candidate.label);
      }
    }
    scores.set(category, { score, signals: matchedSignals });
  }

  const ranked = [...scores.entries()].sort((left, right) => (
    right[1].score - left[1].score || left[0].localeCompare(right[0])
  ));
  const [bestCategory, best] = ranked[0];
  const runnerUpScore = ranked[1]?.[1].score ?? 0;
  const margin = best.score - runnerUpScore;

  if (best.score === 0 || margin < 2 || best.score < 3) {
    return { category: 'general', confidence: 'low', matchedSignals: [] };
  }

  const confidence: ClassificationConfidence = best.score >= 5 && margin >= 3
    ? 'high'
    : 'medium';
  return { category: bestCategory, confidence, matchedSignals: best.signals };
}

function signal(pattern: RegExp, label: string, weight: number): Signal {
  return { pattern, label, weight };
}

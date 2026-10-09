import type { Mode, OutputStyle, RefineInput, RefineOutput, WorkCategory } from './types';

const DEFAULT_MODE: Mode = 'adaptive';
const DEFAULT_CATEGORY: WorkCategory = 'general';
const DEFAULT_OUTPUT_STYLE: OutputStyle = 'compact';

const CATEGORY_LABELS: Record<WorkCategory, string> = {
  general: 'General',
  bug: 'Bug Fix',
  feature: 'Feature',
  enhancement: 'Enhancement',
  refactor: 'Refactor',
  performance: 'Performance',
  tests: 'Tests',
  documentation: 'Documentation',
  investigation: 'Investigation',
  other: 'Other'
};

const CATEGORY_INSTRUCTIONS: Record<WorkCategory, readonly string[]> = {
  general: [],
  bug: [
    'Confirm the root cause before changing behavior.',
    'Add focused regression coverage for the fix.'
  ],
  feature: [
    'Implement only the requested behavior and its observable outcome.'
  ],
  enhancement: [
    'Preserve existing behavior and compatibility outside the requested improvement.'
  ],
  refactor: [
    'Preserve observable behavior; do not introduce feature changes.',
    'Use focused tests to demonstrate behavior remains unchanged.'
  ],
  performance: [
    'Establish a relevant baseline before optimizing and measure the result.',
    'Do not claim an improvement without evidence.'
  ],
  tests: [
    'Prefer test-only changes unless a production defect must be fixed.',
    'Keep tests deterministic.'
  ],
  documentation: [
    'Verify commands, paths, and examples against the actual project.',
    'Do not change runtime behavior.'
  ],
  investigation: [
    'Report likely causes with supporting evidence and paths.',
    'Do not modify code unless implementation is explicitly requested.'
  ],
  other: []
};

const COMPACT_CATEGORY_GUIDANCE: Record<WorkCategory, string | undefined> = {
  general: undefined,
  bug: 'Confirm root cause; add regression coverage.',
  feature: 'Implement only the requested behavior.',
  enhancement: 'Preserve unrelated behavior.',
  refactor: 'Preserve observable behavior; do not add features.',
  performance: 'Measure before and after; make no unsupported claims.',
  tests: 'Prefer deterministic test-only changes unless production code must change.',
  documentation: 'Verify examples; do not change runtime behavior.',
  investigation: 'Report evidence and likely causes; do not modify code unless asked.',
  other: undefined
};

const MODE_INSTRUCTIONS: Record<Mode, readonly string[]> = {
  minimal: [
    'Make the smallest safe change needed to complete the task.',
    'Run focused validation for the changed behavior.',
    'Briefly report the files changed and validation results.'
  ],
  adaptive: [
    'Follow existing patterns and conventions.',
    'Inspect only the files necessary for this task and its direct dependencies.',
    'Avoid unrelated edits.',
    'Run focused validation, then briefly report changed files and results.'
  ],
  strict: [
    'Follow existing patterns and conventions.',
    'Inspect only the files necessary for this task and its direct dependencies.',
    'Avoid unrelated edits.',
    'Do not add new dependencies or make schema or architectural changes without explicit approval.',
    'Modify directly dependent code when required, but do not expand the scope beyond it.',
    'Run focused validation, then briefly report changed files and results.'
  ]
};

/**
 * Builds deterministic scope instructions around the user's original task.
 * This function does not interpret, summarize, or semantically rewrite the task.
 */
export function refinePrompt(input: RefineInput): RefineOutput {
  const task = input.rawPrompt.trim();

  if (task.length === 0) {
    throw new Error('Enter a task to refine.');
  }

  const mode = input.mode ?? DEFAULT_MODE;
  const category = input.category ?? DEFAULT_CATEGORY;
  const outputStyle = input.outputStyle ?? DEFAULT_OUTPUT_STYLE;
  const targetPath = input.targetPath?.trim();
  const sections = [`Task:\n${task}`];

  if (targetPath) {
    sections.push(`Start with: ${targetPath}`);
  }

  const repositoryContext = formatRepositoryContext(input.repositoryContext, targetPath, outputStyle);
  if (repositoryContext) {
    sections.push(repositoryContext);
  }

  const categorySection = formatCategory(category, outputStyle);
  if (categorySection) {
    sections.push(categorySection);
  }

  sections.push(formatInstructions(mode, outputStyle));

  return {
    refinedPrompt: sections.join('\n\n'),
    mode,
    category
  };
}

function formatCategory(category: WorkCategory, outputStyle: OutputStyle): string | undefined {
  const instructions = CATEGORY_INSTRUCTIONS[category];
  if (category === 'general') {
    return undefined;
  }
  if (instructions.length === 0) {
    return outputStyle === 'compact'
      ? `Type: ${CATEGORY_LABELS[category]}`
      : `Work type: ${CATEGORY_LABELS[category]}`;
  }
  if (outputStyle === 'compact') {
    return `Type: ${CATEGORY_LABELS[category]} — ${COMPACT_CATEGORY_GUIDANCE[category]}`;
  }
  return `Work type: ${CATEGORY_LABELS[category]}\nCategory guidance:\n${instructions
    .map((instruction) => `- ${instruction}`)
    .join('\n')}`;
}

function formatRepositoryContext(
  context: RefineInput['repositoryContext'],
  targetPath: string | undefined,
  outputStyle: OutputStyle
): string | undefined {
  if (!context) {
    return undefined;
  }

  const uniqueFiles = [...new Set(context.files.map((file) => file.trim()).filter(Boolean))]
    .filter((file) => file !== targetPath)
    .slice(0, 3);
  const architectureNotes = context.architectureNotes?.trim().slice(0, 1200);
  const parts = [outputStyle === 'compact'
    ? 'Related files (verify):'
    : 'Repository context (discovered locally; verify before editing):'];

  if (uniqueFiles.length > 0) {
    const heading = outputStyle === 'compact' ? '' : 'Suggested starting files:\n';
    parts.push(`${heading}${uniqueFiles.map((file) => `- ${file}`).join('\n')}`);
  }

  if (architectureNotes) {
    parts.push(`Architecture profile (user-maintained reference):\n${architectureNotes}`);
  }

  return parts.length > 1 ? parts.join('\n') : undefined;
}

function formatInstructions(mode: Mode, outputStyle: OutputStyle): string {
  if (outputStyle === 'detailed') {
    const instructions = MODE_INSTRUCTIONS[mode]
      .map((instruction) => `- ${instruction}`)
      .join('\n');
    return `Instructions:\n${instructions}`;
  }

  const compactInstructions: Record<Mode, readonly string[]> = {
    minimal: [
      'Make the smallest safe change.',
      'Validate and briefly report changed files and results.'
    ],
    adaptive: [
      'Follow existing patterns; inspect only necessary files and direct dependencies.',
      'Avoid unrelated edits; validate and report briefly.'
    ],
    strict: [
      'Follow existing patterns; change only necessary files and direct dependencies.',
      'No new dependencies, schema, or architecture changes without approval.',
      'Validate and report briefly.'
    ]
  };
  return `Constraints:\n${compactInstructions[mode].map((instruction) => `- ${instruction}`).join('\n')}`;
}

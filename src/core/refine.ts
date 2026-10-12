import type { Mode, OutputStyle, PromptTarget, RefineInput, RefineOutput, WorkCategory } from './types';

const DEFAULT_MODE: Mode = 'adaptive';
const DEFAULT_CATEGORY: WorkCategory = 'general';
const DEFAULT_OUTPUT_STYLE: OutputStyle = 'compact';
const DEFAULT_TARGET: PromptTarget = 'generic';
const MAX_VALIDATION_COMMANDS = 3;

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

interface Section {
  /** Rendering used by the generic target; identical to the original plain-text output. */
  generic: string;
  tag: string;
  title: string;
  body: string;
}

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
  const target = input.target ?? DEFAULT_TARGET;
  const targetPath = input.targetPath?.trim();
  const sections: Section[] = [{ generic: `Task:\n${task}`, tag: 'task', title: 'Task', body: task }];

  if (targetPath) {
    sections.push({ generic: `Start with: ${targetPath}`, tag: 'start_with', title: 'Start with', body: targetPath });
  }

  const repositoryContext = formatRepositoryContext(input.repositoryContext, targetPath, outputStyle);
  if (repositoryContext) {
    sections.push({ ...repositoryContext, tag: 'context', title: 'Context' });
  }

  const categorySection = formatCategory(category, outputStyle);
  if (categorySection) {
    sections.push({ generic: categorySection.text, tag: 'work_type', title: 'Work type', body: categorySection.body });
  }

  const secondary = formatSecondaryCategory(input.secondaryCategory, category);
  if (secondary) {
    sections.push({ generic: secondary, tag: 'also', title: 'Also', body: secondary.replace(/^Also: /, '') });
  }

  const acceptanceCriteria = input.acceptanceCriteria?.trim();
  if (acceptanceCriteria) {
    sections.push({
      generic: `Done when:\n${acceptanceCriteria}`,
      tag: 'done_when',
      title: 'Done when',
      body: acceptanceCriteria
    });
  }

  const instructions = formatInstructions(mode, outputStyle);
  sections.push({
    generic: instructions.text,
    tag: 'constraints',
    title: 'Constraints',
    body: instructions.body
  });

  const validation = formatValidation(input.repositoryContext?.validationCommands);
  if (validation) {
    sections.push({ generic: validation, tag: 'validate', title: 'Validate', body: validation.replace(/^Validate with: /, '') });
  }

  return {
    refinedPrompt: sections.map((section) => renderSection(section, target)).join('\n\n'),
    mode,
    category
  };
}

function renderSection(section: Section, target: PromptTarget): string {
  if (target === 'claude') {
    return `<${section.tag}>\n${section.body}\n</${section.tag}>`;
  }
  if (target === 'codex') {
    return `## ${section.title}\n${section.body}`;
  }
  return section.generic;
}

function formatCategory(
  category: WorkCategory,
  outputStyle: OutputStyle
): { text: string; body: string } | undefined {
  const instructions = CATEGORY_INSTRUCTIONS[category];
  if (category === 'general') {
    return undefined;
  }
  if (instructions.length === 0) {
    const label = outputStyle === 'compact'
      ? `Type: ${CATEGORY_LABELS[category]}`
      : `Work type: ${CATEGORY_LABELS[category]}`;
    return { text: label, body: CATEGORY_LABELS[category] };
  }
  if (outputStyle === 'compact') {
    const body = `${CATEGORY_LABELS[category]} — ${COMPACT_CATEGORY_GUIDANCE[category]}`;
    return { text: `Type: ${body}`, body };
  }
  const bullets = instructions.map((instruction) => `- ${instruction}`).join('\n');
  return {
    text: `Work type: ${CATEGORY_LABELS[category]}\nCategory guidance:\n${bullets}`,
    body: `${CATEGORY_LABELS[category]}\n${bullets}`
  };
}

function formatSecondaryCategory(
  secondary: WorkCategory | undefined,
  primary: WorkCategory
): string | undefined {
  if (!secondary || secondary === primary || secondary === 'general' || secondary === 'other') {
    return undefined;
  }
  const guidance = COMPACT_CATEGORY_GUIDANCE[secondary];
  return guidance
    ? `Also: ${CATEGORY_LABELS[secondary]} — ${guidance}`
    : `Also: ${CATEGORY_LABELS[secondary]}`;
}

function formatRepositoryContext(
  context: RefineInput['repositoryContext'],
  targetPath: string | undefined,
  outputStyle: OutputStyle
): { generic: string; body: string } | undefined {
  if (!context) {
    return undefined;
  }

  const uniqueFiles = [...new Set(context.files.map((file) => file.trim()).filter(Boolean))]
    .filter((file) => file !== targetPath)
    .slice(0, 3);
  const relatedTests = [...new Set((context.relatedTests ?? []).map((file) => file.trim()).filter(Boolean))]
    .filter((file) => file !== targetPath && !uniqueFiles.includes(file))
    .slice(0, 3);
  const conventionFiles = [...new Set((context.conventionFiles ?? []).map((file) => file.trim()).filter(Boolean))]
    .slice(0, 3);
  const architectureNotes = context.architectureNotes?.trim().slice(0, 1200);
  const heading = outputStyle === 'compact'
    ? 'Related files (verify):'
    : 'Repository context (discovered locally; verify before editing):';
  const lines: string[] = [];

  if (uniqueFiles.length > 0) {
    const filesHeading = outputStyle === 'compact' ? '' : 'Suggested starting files:\n';
    lines.push(`${filesHeading}${uniqueFiles.map((file) => `- ${file}`).join('\n')}`);
  }

  if (relatedTests.length > 0) {
    lines.push(`Related tests:\n${relatedTests.map((file) => `- ${file}`).join('\n')}`);
  }

  if (architectureNotes) {
    lines.push(`Architecture profile (user-maintained reference):\n${architectureNotes}`);
  }

  if (conventionFiles.length > 0) {
    lines.push(`Follow the conventions in: ${conventionFiles.join(', ')}.`);
  }

  return lines.length > 0
    ? { generic: [heading, ...lines].join('\n'), body: lines.join('\n') }
    : undefined;
}

function formatValidation(commands: readonly string[] | undefined): string | undefined {
  const unique = [...new Set((commands ?? []).map((command) => command.trim()).filter(Boolean))]
    .slice(0, MAX_VALIDATION_COMMANDS);
  return unique.length > 0
    ? `Validate with: ${unique.map((command) => `\`${command}\``).join(', ')}`
    : undefined;
}

function formatInstructions(mode: Mode, outputStyle: OutputStyle): { text: string; body: string } {
  if (outputStyle === 'detailed') {
    const instructions = MODE_INSTRUCTIONS[mode]
      .map((instruction) => `- ${instruction}`)
      .join('\n');
    return { text: `Instructions:\n${instructions}`, body: instructions };
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
  const bullets = compactInstructions[mode].map((instruction) => `- ${instruction}`).join('\n');
  return { text: `Constraints:\n${bullets}`, body: bullets };
}

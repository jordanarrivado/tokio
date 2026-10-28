import type { Mode, OutputStyle, PromptTarget, RefineInput, RefineOutput, WorkCategory } from './types';

const DEFAULT_MODE: Mode = 'adaptive';
const DEFAULT_CATEGORY: WorkCategory = 'general';
const DEFAULT_OUTPUT_STYLE: OutputStyle = 'compact';
const DEFAULT_TARGET: PromptTarget = 'generic';
const MAX_VALIDATION_COMMANDS = 3;
const MAX_MAP_ROUTES = 12;

const CATEGORY_LABELS: Record<WorkCategory, string> = {
  general: 'General',
  bug: 'Bug Fix',
  hotfix: 'Production Hotfix',
  feature: 'Feature',
  enhancement: 'Enhancement',
  ui: 'UI Work',
  refactor: 'Refactor',
  performance: 'Performance',
  tests: 'Tests',
  documentation: 'Documentation',
  investigation: 'Investigation',
  decision: 'Decision',
  planning: 'Planning',
  workflow: 'Workflow / Automation',
  security: 'Security',
  migration: 'Migration',
  dependency: 'Dependency Upgrade',
  review: 'Code Review',
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
  hotfix: [
    'Find the root cause with evidence (a log line, query, or code path) before changing anything; do not guess.',
    'Reproduce it with a failing test, then make the smallest change that passes it.',
    'Change nothing beyond the fix; list follow-up cleanup and review for after production is stable.'
  ],
  ui: [
    'Reuse the existing design tokens and components; add no new colors, spacing values, or UI libraries.',
    'Follow the layout and interaction patterns of an existing screen.',
    'Check the result at about 360, 768, and 1280 px wide, and keep labels, focus states, and keyboard access working.'
  ],
  decision: [
    'Do not write code. Read the affected code first and list every place the decision touches, with paths.',
    'Compare at least two options with their trade-offs and recommend one.',
    'Record the decision: what was chosen, what was rejected, and why.'
  ],
  planning: [
    'Read the relevant code first; do not guess about files you have not opened.',
    'List the steps, the files each step touches, and one check per acceptance criterion.',
    'Call out open questions and risks, each with a recommended answer.',
    'Stop after the plan and wait for approval before changing code.'
  ],
  workflow: [
    'Follow the existing pipeline, script, and job conventions; reuse current steps where possible.',
    'Keep secrets in the platform secret store; never hard-code or print them.',
    'Show how to run or dry-run the change locally, and say what still needs a real run to confirm.'
  ],
  security: [
    'Name the threat being prevented and check every entry point that reaches the affected code.',
    'Never log, print, or commit secrets or personal data.',
    'Add a test that shows unsafe input is rejected, not only that safe input works.'
  ],
  migration: [
    'Make the change reversible: include a rollback or down step.',
    'Keep existing data and the currently deployed code working while the change rolls out.',
    'Test on a copy with invented data, and report what the change locks and how long it may take.'
  ],
  dependency: [
    'Read the release notes for breaking changes between the current and target versions.',
    'Upgrade one package at a time and change only the code its breaking changes require.',
    'Run the full test suite and build, and report any deprecation warnings that remain.'
  ],
  review: [
    'Do not change code; report findings with file and line.',
    'Rank findings by severity; focus on correctness, security, and missing tests before style.',
    'Say what was not reviewed or could not be checked.'
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
  hotfix: 'Root cause with evidence first; failing test; smallest fix; defer cleanup.',
  ui: 'Reuse existing tokens and components; check 360/768/1280 px and keyboard access.',
  decision: 'No code; list affected paths; compare options; record chosen, rejected, and why.',
  planning: 'Read first; steps, files, and one check per criterion; stop for approval before code.',
  workflow: 'Follow existing pipeline conventions; no hard-coded secrets; show a local dry run.',
  security: 'Name the threat; cover every entry point; no secrets in logs; test unsafe input.',
  migration: 'Reversible with rollback; keep old code working; test on invented data.',
  dependency: 'Check breaking changes; one package at a time; full tests and build.',
  review: 'No edits; findings with file:line ranked by severity; correctness before style.',
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

  const additional = formatAdditionalCategories(input.additionalCategories, category);
  if (additional.length > 0) {
    sections.push({
      generic: additional.map((line) => `Also: ${line}`).join('\n'),
      tag: 'also',
      title: 'Also',
      body: additional.join('\n')
    });
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

function formatAdditionalCategories(
  additional: readonly WorkCategory[] | undefined,
  primary: WorkCategory
): string[] {
  const unique = [...new Set(additional ?? [])]
    .filter((category) => category !== primary && category !== 'general' && category !== 'other');
  return unique.map((category) => {
    const guidance = COMPACT_CATEGORY_GUIDANCE[category];
    return guidance ? `${CATEGORY_LABELS[category]} — ${guidance}` : CATEGORY_LABELS[category];
  });
}

function formatRepositoryContext(
  context: RefineInput['repositoryContext'],
  targetPath: string | undefined,
  outputStyle: OutputStyle
): { generic: string; body: string } | undefined {
  if (!context) {
    return undefined;
  }

  // Files a map route already names are not listed again.
  const routedFiles = new Set((context.mapRoutes ?? []).map((route) => route.split(/[\s:]/)[0]));
  const uniqueFiles = [...new Set(context.files.map((file) => file.trim()).filter(Boolean))]
    .filter((file) => file !== targetPath && !routedFiles.has(file))
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
  const mapRoutes = (context.mapRoutes ?? []).slice(0, MAX_MAP_ROUTES);
  const mapStale = (context.mapStale ?? []).slice(0, MAX_MAP_ROUTES);

  if (mapRoutes.length > 0) {
    lines.push(`Architecture map routes (start here; read only these lines):\n${mapRoutes.map((route) => `- ${route}`).join('\n')}`);
  }

  if (mapStale.length > 0) {
    lines.push(`Map entries not found (the map may be out of date): ${mapStale.join('; ')}.`);
  }

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

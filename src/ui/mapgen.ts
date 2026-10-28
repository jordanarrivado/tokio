/**
 * The request Tokio hands to the user's agent to write or rewrite the architecture map. The agent reads the
 * code; Tokio only describes the format and what makes a map easy to search. Pure, so it is tested without VS Code.
 */

export interface MapRequestInput {
  path: string;
  exists: boolean;
  /** Entries that no longer resolve, so a regenerate fixes them first. */
  stale: readonly string[];
}

const MAX_STALE_LISTED = 20;

export function buildMapRequest(input: MapRequestInput): string {
  const intro = input.exists
    ? `Regenerate the architecture map at \`${input.path}\` from the current code. Keep areas, keywords, and notes a person wrote that are still true; fix or remove entries that no longer exist; add what is missing.`
    : `Create an architecture map at \`${input.path}\` for this repository.`;
  const stale = input.stale.length > 0
    ? [
      '',
      'These entries no longer resolve. Fix or remove each one:',
      ...input.stale.slice(0, MAX_STALE_LISTED).map((entry) => `- ${entry}`),
      ...(input.stale.length > MAX_STALE_LISTED ? [`- and ${input.stale.length - MAX_STALE_LISTED} more`] : [])
    ]
    : [];

  return [
    intro,
    ...stale,
    '',
    'Tokio matches every future task against this map and sends the agent only the matched files and lines, so it must be easy to search:',
    '- One `## Area` heading per feature or domain, named the way people describe the work (for example "Payroll run", "Employee records", "Login and sessions").',
    '- A `Keywords:` line under each heading with the words and synonyms a task would use, including business terms, not only code names.',
    '- Route lines `- <label> -> <path>#<symbol>`: HTTP endpoints (`POST /api/payroll/run`), pages and UI routes, jobs, commands, and events. Use `Class.method` for methods.',
    '- Data structures as their own areas or routes: models, database tables and migrations, DTOs and resources, schemas.',
    '- `- Related: path, path` for files that change with the area, such as services, tests, and config.',
    '',
    'Rules:',
    '- Paths are relative to the repository root. Check that every path and symbol exists before writing it.',
    '- Use Tokio\'s repo_map and find_symbol to locate code instead of reading whole files.',
    '- Keep it to pointers: no code, no long prose. Aim for one area per feature and under 300 lines.',
    '- Write only the map file. Change no other file.'
  ].join('\n');
}

import { explainMissedArea, scoreMapAreas, type MapArea } from '../context/archmap';
import { decideMapContext } from './prompt-hook';

/**
 * Sample prompts for an architecture map, each with the areas it should match. `tokio map check` runs them
 * through the prompt hook's matching, so a Keywords edit that drops or adds an area shows up before agents see it.
 */

/** Where a repository keeps its sample prompts, next to the map they test. */
export const MAP_PROMPTS_PATH = '.tokio/map-prompts.json';

export interface MapPromptCase {
  prompt: string;
  /** Areas that must match. Empty means the prompt should match nothing. */
  areas: string[];
  /** Areas that may also match without failing the case. */
  allow: string[];
}

export interface MapPromptResult {
  prompt: string;
  matched: string[];
  missing: string[];
  extra: string[];
  /** Each matched area's score as a share of the best one, and the strong terms behind it. */
  details: { area: string; share: number; terms: string[] }[];
  /** Why each missing area did not match. */
  reasons: Record<string, string>;
}

/**
 * Parses a prompts file: a JSON array of `{ "prompt": string, "areas": string[], "allow"?: string[] }`.
 * Area names are checked against the map, so a renamed or removed area is reported instead of silently failing.
 */
export function parseMapPrompts(text: string, areas: readonly MapArea[]): MapPromptCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`Prompts file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Prompts file must be a JSON array of { "prompt", "areas", "allow"? } objects.');
  }
  const known = new Map(areas.map((area) => [area.name.toLowerCase(), area.name]));
  return parsed.map((entry: unknown, index) => {
    const label = `Prompt ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${label} is not an object.`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.prompt !== 'string' || record.prompt.trim() === '') {
      throw new Error(`${label} needs a non-empty "prompt".`);
    }
    const names = (field: 'areas' | 'allow'): string[] => {
      const value = record[field];
      if (value === undefined && field === 'allow') {
        return [];
      }
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(`${label} needs "${field}" as an array of area names.`);
      }
      return value.map((name: string) => {
        const area = known.get(name.trim().toLowerCase());
        if (!area) {
          throw new Error(`${label} names "${name}", which is not an area in the map.`);
        }
        return area;
      });
    };
    return { prompt: record.prompt, areas: names('areas'), allow: names('allow') };
  });
}

/** Runs each case through the hook's matching. Order of areas does not matter. */
export function runMapPrompts(areas: readonly MapArea[], cases: readonly MapPromptCase[]): MapPromptResult[] {
  return cases.map((testCase) => {
    const decision = decideMapContext(testCase.prompt, areas, new Set());
    const matched = decision.use ? decision.fresh.map((entry) => entry.area.name) : [];
    const missing = testCase.areas.filter((name) => !matched.includes(name));
    const scores = scoreMapAreas(areas, testCase.prompt);
    const best = decision.use ? Math.max(...decision.fresh.map((entry) => entry.score)) : 0;
    return {
      prompt: testCase.prompt,
      matched,
      missing,
      extra: matched.filter((name) => !testCase.areas.includes(name) && !testCase.allow.includes(name)),
      details: decision.use
        ? decision.fresh.map((entry) => ({
          area: entry.area.name,
          share: best > 0 ? entry.score / best : 0,
          terms: scores.find((score) => score.area === entry.area)?.strongTerms ?? []
        }))
        : [],
      reasons: Object.fromEntries(missing.map((name) => [
        name,
        decision.use ? explainMissedArea(scores, name) : 'the prompt hook skipped this prompt or no area matched'
      ]))
    };
  });
}

/** One line per failing prompt, then a summary. Passing prompts are counted, not listed. */
export function formatMapCheck(
  map: { path: string; areas: number; routes: number; stale: readonly string[]; areaNames?: readonly string[] },
  results: readonly MapPromptResult[] | undefined,
  options: { verbose?: boolean; cases?: readonly MapPromptCase[] } = {}
): { text: string; ok: boolean } {
  const matchedText = (result: MapPromptResult): string => result.details
    .map((detail) => `${detail.area} ${detail.share.toFixed(2)} (via ${detail.terms.join(', ') || 'route path'})`)
    .join(' | ') || '(nothing)';
  const lines = [`${map.path}: ${map.areas} areas, ${map.routes} routes, ${map.stale.length} stale.`];
  for (const stale of map.stale) {
    lines.push(`  stale: ${stale}`);
  }
  let failed = 0;
  if (results) {
    for (const result of results) {
      if (result.missing.length === 0 && result.extra.length === 0) {
        if (options.verbose) {
          lines.push(`ok   "${result.prompt}"`);
          lines.push(`  matched: ${matchedText(result)}`);
        }
        continue;
      }
      failed += 1;
      lines.push(`FAIL "${result.prompt}"`);
      lines.push(`  matched: ${matchedText(result)}`);
      for (const name of result.missing) {
        lines.push(`  missing: ${name}: ${result.reasons[name]}`);
      }
      for (const name of result.extra) {
        const terms = result.details.find((detail) => detail.area === name)?.terms ?? [];
        lines.push(`  extra:   ${name} (via ${terms.join(', ') || 'route path'})`);
      }
    }
    lines.push(`${results.length - failed} of ${results.length} prompts match their expected areas.`);
    if (map.areaNames && options.cases) {
      const covered = new Set(options.cases.flatMap((testCase) => testCase.areas));
      const uncovered = map.areaNames.filter((name) => !covered.has(name));
      if (uncovered.length > 0) {
        lines.push(`${uncovered.length} of ${map.areaNames.length} areas have no sample prompt: ${uncovered.join(', ')}.`);
      }
    }
  } else {
    lines.push(`No prompts file. Add ${MAP_PROMPTS_PATH} to test which areas sample prompts match.`);
  }
  return { text: lines.join('\n'), ok: failed === 0 && map.stale.length === 0 };
}

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard: shell v2 and the homes never compute a metric (ADR-1314, #4760).
 *
 * One sprint's slip read 27 / 20 / 22 / 26 points on four surfaces; one engineer's
 * load read 128/80, 24/80, 40% and "100% available"; health read Unknown / Unknown
 * / At risk on one page. Each surface computed or labeled its own number. ADR-1314
 * names one owning endpoint per metric, and the rule that follows is the one
 * `healthBand.conformance.test.ts` enforces for the band words: **surfaces format,
 * they never recompute.**
 *
 * So this scans every non-test source file under `features/shell2/` (and a homes
 * directory, once one exists) for the shapes a client-side recomputation takes:
 *
 * - deriving a health band from the counts (`criticalCount > 0`) — the server folds
 *   in the PM's manual report, which the counts cannot see (#3501);
 * - dividing hours by capacity — person load is `load_pct` on `/utilization/`;
 * - subtracting dates — slip and the P80-vs-commitment delta are measured in working
 *   time on the server, which a shown-day subtraction gets wrong across a weekend
 *   (#4197);
 * - sampling percentiles — P50/P80/P95 are the Monte Carlo result's;
 * - writing a metric's definition — the definition is the server's
 *   `definitions` sentence, rendered verbatim.
 *
 * Comments are stripped before matching, so a docstring may describe the rule (as
 * this one does) without tripping it. Formatting a server value — `fmtUtcShort`,
 * `formatRelative`, a `%` suffix — is not matched and is allowed.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/features/shell2
const FEATURES = resolve(here, '..');

/** Shell v2, plus the homes (#4755) wherever they land under `features/`. */
const SCANNED_DIRS = [
  here,
  ...readdirSync(FEATURES)
    .filter((d) => /^homes?$/i.test(d))
    .map((d) => join(FEATURES, d)),
].filter((d) => existsSync(d));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const FILES = SCANNED_DIRS.flatMap(sourceFiles);

/** Drop block and line comments so prose about the rule never matches the rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RECOMPUTE_PATTERNS: Record<string, RegExp> = {
  'health band derived from counts': /\b(critical|atRisk|at_risk)_?[Cc]ount\s*(>|>=|===|!==)\s*0/,
  'load computed from hours and capacity':
    /\b\w*(hours|booked|load)\w*\s*\/\s*\(?\s*\w*(capacity|max_?units|maxUnits|hoursPerDay|hours_per_day)/i,
  'date subtraction (slip or delta)':
    /\.getTime\(\)\s*-|differenceIn(Calendar|Business)?Days|86_?400_?000/,
  'percentile sampled client-side': /\b(quantile|percentile)\s*\(|\*\s*0\.(5|8|95)\b/,
  'client-written metric definition': /simulated schedules|\bthe date \d+% of\b/i,
};

function offenders(files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const [label, re] of Object.entries(RECOMPUTE_PATTERNS)) {
      if (re.test(code)) hits.push(`${f.slice(FEATURES.length + 1)}: ${label}`);
    }
  }
  return hits;
}

describe('shell v2 and the homes format server metrics and never recompute them', () => {
  it('no scanned file computes a health, forecast, load or slip figure', () => {
    expect(offenders(FILES)).toEqual([]);
  });

  it('scanned the shell (the scan itself cannot go vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES.some((f) => f.endsWith('features/shell2/ContextHeader2.tsx'))).toBe(true);
  });

  it.each([
    [
      'health band derived from counts',
      "const band = criticalCount > 0 ? 'critical' : 'on_track';",
    ],
    ['load computed from hours and capacity', 'const pct = bookedHours / capacityHours * 100;'],
    ['date subtraction (slip or delta)', 'const slip = (a.getTime() - b.getTime()) / 86400000;'],
    ['percentile sampled client-side', 'const p80 = sorted[Math.floor(sorted.length * 0.8)];'],
    [
      'client-written metric definition',
      "const DEF = 'the date 80% of the simulated schedules finish on';",
    ],
  ])('detects a reintroduced %s (proves the scan is not vacuous)', (label, snippet) => {
    expect(RECOMPUTE_PATTERNS[label]?.test(stripComments(snippet))).toBe(true);
  });

  it('ignores prose about the rule in comments', () => {
    const doc =
      '/** never write criticalCount > 0 here */\n// nor bookedHours / capacity\nconst x = 1;';
    const hit = Object.values(RECOMPUTE_PATTERNS).some((re) => re.test(stripComments(doc)));
    expect(hit).toBe(false);
  });
});

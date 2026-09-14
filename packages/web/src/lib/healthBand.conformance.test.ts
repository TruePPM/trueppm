import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard on the single health-vocabulary implementation (#3502).
 *
 * #3470 fixed the class at one surface — the shell health chip had invented a
 * fourth word ("On watch") for the three-value health vocabulary — and added
 * `HEALTH_BAND_LABEL` as the one place the words live. That fix reached three
 * surfaces. Seven more still carried the same three words in private literal
 * maps keyed on their own shapes (SCREAMING case, kebab case, the manual
 * override enum), because nothing checked for a *second* copy of the words —
 * each one passed its own tests, which is exactly how the first one shipped
 * wrong and went unnoticed.
 *
 * So the invariant is not "HEALTH_BAND_LABEL is correct" (that is
 * `healthBand.test.ts`'s job) — it is **"HEALTH_BAND_LABEL is the only one"**.
 * A local map that restates `'On track'` / `'At risk'` / `'Critical'` as its
 * own object-literal values fails here, at the moment it is written, rather
 * than waiting for the next manual sweep.
 *
 * Deliberately a source scan and not a lint rule: the thing being forbidden is
 * a *shape* (an object literal whose values are the band words) rather than a
 * syntactic construct, and a hand-maintained list of "sites that must be
 * checked" is precisely the enumeration that let this class reach seven
 * surfaces before anyone noticed (rule 300 — a sweep without a mechanism
 * comes back).
 *
 * The detector matches a colon immediately followed by one of the three exact
 * band words in quotes — `<key>: 'On track'` — rather than a bare substring
 * search for the words. A substring search also flags `HealthCluster.tsx`
 * (the correctly-wired shell chip), whose own docstring quotes "On track" and
 * "At risk" in prose describing the #3470 bug, and whose `DrillRows` passes
 * `label="At risk"` as a JSX attribute (`=`, not `:`) for an unrelated
 * critical-path drill-down section. Requiring the colon — the shape of an
 * object-literal value, which is how every real offender declared its map —
 * excludes both without hand-listing either file.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/lib
const SRC = resolve(here, '..');

/** The one module allowed to declare the band-label strings. */
const OWNER = resolve(SRC, 'lib/healthBand.ts');

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

const FILES = sourceFiles(SRC).filter((f) => f !== OWNER);

/** The tell of a private band-label map: `<key>: 'On track'` (or `"..."`). */
const BAND_VALUE_PATTERNS = [
  /:\s*(['"])On track\1/,
  /:\s*(['"])At risk\1/,
  /:\s*(['"])Critical\1/,
];

/** A file is an offender when it restates at least two of the three words — a
 *  single incidental match (e.g. an unrelated field that happens to be titled
 *  "Critical") is not enough to call it a private vocabulary. */
function bandLabelOffenders(files: string[]): string[] {
  return files
    .filter((f) => BAND_VALUE_PATTERNS.filter((p) => p.test(readFileSync(f, 'utf8'))).length >= 2)
    .map((f) => f.slice(SRC.length + 1));
}

describe('the health-band vocabulary has exactly one implementation', () => {
  it('declares the band words only in lib/healthBand.ts', () => {
    expect(bandLabelOffenders(FILES)).toEqual([]);
  });

  it('scanned a meaningful number of files (the scan itself cannot go vacuous)', () => {
    // Without this, a broken glob would make the assertion above pass by
    // finding nothing — the failure mode of every source-scanning test.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.endsWith('features/me/myWorkFocus.ts'))).toBe(true);
    expect(FILES.some((f) => f.endsWith('features/programs/ProgramCard.tsx'))).toBe(true);
    expect(
      FILES.some((f) => f.endsWith('features/shell/HealthCluster.tsx')),
    ).toBe(true);
  });

  it('does not flag the correctly-wired shell chip', () => {
    // HealthCluster.tsx reads HEALTH_BAND_LABEL and separately quotes "On
    // track"/"At risk" in prose comments and one unrelated `label="At risk"`
    // JSX attribute (a critical-path drill-down section, not a health word).
    // A bare substring scan would misflag it; this proves the colon-shaped
    // detector does not.
    const file = resolve(SRC, 'features/shell/HealthCluster.tsx');
    expect(FILES).toContain(file);
    expect(bandLabelOffenders([file])).toEqual([]);
  });

  it('fails when a private label map is reintroduced (proves the scan is not vacuous)', () => {
    // Reproduce the exact shape #3502 removed from myWorkFocus.ts: an object
    // literal restating the words instead of reading HEALTH_BAND_LABEL.
    const reintroduced = `
      const HEALTH_BAND: Record<string, { tone: string; label: string }> = {
        on_track: { tone: 'on-track', label: 'On track' },
        at_risk: { tone: 'at-risk', label: 'At risk' },
        critical: { tone: 'critical', label: 'Critical' },
      };
    `;
    const hits = BAND_VALUE_PATTERNS.filter((p) => p.test(reintroduced));
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

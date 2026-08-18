import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard on the single CSV-escaping implementation (#2892).
 *
 * The CSV/formula-injection class in #2762 was fixed at two sites, came back at a
 * third (`WorkspaceMembersPage`), and was sitting at a fourth (`WorkspaceRolesPage`)
 * the whole time — because each surface that needed a CSV cell wrote its own
 * quoting helper. Every one of those copies passed its own unit tests; what none
 * of them could see is that a *sibling* file had a weaker guard.
 *
 * So the invariant is not "escapeField is correct" (that is
 * `exportCsv.test.ts`'s job) — it is **"escapeField is the only one"**. A local
 * `csvCell`/`csvEscape` helper that does its own quoting fails here, at the moment
 * it is written, rather than being found by the next security audit.
 *
 * Deliberately a source scan and not a lint rule: the thing being forbidden is a
 * *shape* (a function that quotes CSV) rather than a syntactic construct, and a
 * hand-maintained list of "sites that must be checked" is precisely the
 * enumeration that let the class survive two rounds of fixes.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/utils
const SRC = resolve(here, '..');

/** The one module allowed to implement CSV escaping. */
const OWNER = resolve(SRC, 'utils/exportCsv.ts');

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

describe('CSV escaping has exactly one implementation', () => {
  it('defines the formula-prefix character set only in utils/exportCsv.ts', () => {
    const offenders = FILES.filter((f) => readFileSync(f, 'utf8').includes('FORMULA_PREFIX_CHARS'));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('leaves the RFC 4180 quoting expression only in utils/exportCsv.ts', () => {
    // The tell of a hand-rolled cell escaper: doubling embedded quotes.
    const offenders = FILES.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return source.includes(`replaceAll('"', '""')`) || source.includes(`replace(/"/g, '""')`);
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('routes every CSV download through the shared blob/anchor helper', () => {
    // A hand-rolled `new Blob([...], { type: 'text/csv' })` is where a hand-rolled
    // cell escaper lives: all three drifted exports carried the pair. Matching the
    // Blob *construction* rather than the MIME string alone keeps upload-side
    // allowlists (`lib/attachmentTypes.ts`) and import accept lists — which name
    // the type but produce no file — correctly out of scope.
    const offenders = FILES.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return /text\/csv/.test(source) && /new Blob\(/.test(source);
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('scanned a meaningful number of files (the scan itself cannot go vacuous)', () => {
    // Without this, a broken glob would make every assertion above pass by
    // finding nothing — the failure mode of every source-scanning test.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.some((f) => f.endsWith('features/risk/riskExport.ts'))).toBe(true);
    expect(
      FILES.some((f) => f.endsWith('features/settings/workspace/WorkspaceMembersPage.tsx')),
    ).toBe(true);
  });
});

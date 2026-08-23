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

/**
 * Rule 297 needs a mechanism, not a fourth manual sweep (#2943).
 *
 * A download is the one user-initiated action producing no in-page change, so without
 * a polite live region it is indistinguishable from a dead button for screen-reader
 * and low-vision users (WCAG 4.1.3). The rule's own text records that it was written
 * down *because* a second download button was added to a file that already had the
 * pattern — and three more sites then shipped without one, which makes it a rule 300
 * case: a rule that has needed a second manual sweep does not have a working
 * mechanism.
 *
 * The trigger set is **derived from the source**, not enumerated: `downloadCsv` plus
 * every exported function in a module that imports it and calls it. That matters
 * because the sites this issue found are not all direct callers —
 * `RiskRegisterHeader` reaches a download through `exportRisksToCSV`, one hop away,
 * and a check keyed on `import { downloadCsv }` would have declared it clean.
 *
 * A hand-maintained list of "components that download" is exactly the enumeration
 * rule 306 forbids, for the same reason: it is the thing that lets the class survive
 * a round of fixes.
 */
describe('every component that can trigger a download announces it (rule 297)', () => {
  /** Modules that reach the blob/anchor helper directly. */
  const DOWNLOADER_MODULES = FILES.filter((f) =>
    /\bdownloadCsv\b/.test(readFileSync(f, 'utf8')),
  );

  /**
   * `downloadCsv` plus the exported wrappers around it — derived by reading the
   * downloader modules, so a new wrapper joins the trigger set by existing.
   */
  const TRIGGERS = new Set<string>(['downloadCsv']);
  for (const file of DOWNLOADER_MODULES) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
      const body = source.slice(m.index ?? 0);
      const nextExport = body.slice(1).search(/\nexport\s/);
      const fnBody = nextExport === -1 ? body : body.slice(0, nextExport + 1);
      if (/\bdownloadCsv\s*\(/.test(fnBody)) TRIGGERS.add(m[1]);
    }
  }

  /** Components — a `.ts` helper renders nothing, so it cannot mount a region. */
  const COMPONENTS = FILES.filter((f) => f.endsWith('.tsx'));

  it('derived a trigger set that reaches past the direct callers', () => {
    // Non-vacuity, and the specific hop that #2943 turned on: without
    // exportRisksToCSV in the set, RiskRegisterHeader reads as clean.
    expect(TRIGGERS.has('downloadCsv')).toBe(true);
    expect(TRIGGERS.has('exportRisksToCSV')).toBe(true);
    expect(DOWNLOADER_MODULES.length).toBeGreaterThan(1);
    expect(COMPONENTS.length).toBeGreaterThan(100);
  });

  it('mounts a polite live region in every component that calls one', () => {
    // Either shape counts: the `useDownloadAnnouncer` hook (which owns the region and
    // is the mechanism this issue adds), or a hand-mounted `aria-live` span for a
    // component that already had one. The invariant is that the announcement EXISTS,
    // not which of the two produced it.
    const offenders = COMPONENTS.filter((f) => {
      const source = readFileSync(f, 'utf8');
      const triggers = [...TRIGGERS].some((t) => new RegExp(`\\b${t}\\s*\\(`).test(source));
      const announces =
        source.includes('useDownloadAnnouncer') || source.includes('aria-live');
      return triggers && !announces;
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });

  it('fails when a download-triggering component drops its announcement', () => {
    // Proves the guard above is not vacuous: strip the announcement from a real
    // offender's source and the same predicate must reject it.
    const wired = readFileSync(
      resolve(SRC, 'features/settings/workspace/WorkspaceRolesPage.tsx'),
      'utf8',
    );
    expect(/\bdownload\w*\s*\(/.test(wired)).toBe(true);

    const stripped = wired
      .replaceAll('useDownloadAnnouncer', 'somethingElse')
      .replaceAll('aria-live', 'data-x');
    const announces =
      stripped.includes('useDownloadAnnouncer') || stripped.includes('aria-live');
    expect(announces).toBe(false);
  });
});

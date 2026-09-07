import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard on the single "follow a DRF `next` link" implementation (#3467).
 *
 * DRF emits `next` as a fully-qualified URL whose path already contains
 * `/api/v1`, while `apiClient`'s baseURL is `/api/v1`. There are exactly two
 * ways to hand that value to axios and both are wrong:
 *
 *   - `new URL(next).pathname + search` → `/api/v1/api/v1/tasks/?page=2`, a 404
 *     on every project whose list spans more than one page (the #3467 bug);
 *   - the absolute URL untouched → axios skips its baseURL and requests
 *     whatever host the server wrote into the link.
 *
 * Both shipped. `useCalendarTasks` had the first and `useMyWork` the second, and
 * neither was visible to any test: a single-page fixture (`next: null`) exercises
 * no following at all, and every e2e mock in this tree returns exactly that. So
 * the invariant here is not "the transform is correct" — `pagination.test.ts`
 * owns that — it is **"the transform has one home"**.
 *
 * Deliberately a source scan rather than a lint rule: what is forbidden is a
 * *shape* (a request path derived from a paginated link), which no syntactic
 * rule expresses, and a hand-maintained list of hooks to check is exactly the
 * enumeration that let the second instance sit unnoticed beside the first.
 *
 * What this CANNOT see, stated plainly: a brand-new helper that re-derives the
 * path by some spelling none of these patterns match. The patterns cover the two
 * shapes that have actually shipped, not the space of all possible ones.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/api
const SRC = resolve(here, '..');

/** The one module allowed to normalize a DRF pagination link. */
const OWNER = resolve(SRC, 'api/pagination.ts');

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

/** Strips everything up to and including `/api/v1` — the owner's transform. */
const STRIP_PATTERN = /\/api\\?\/v1['"`/]?\s*,\s*['"`]['"`]\s*\)/;
/** A second copy of the strip, however it is spelled: any replace() naming /api/v1. */
const STRIP_LOOSE = /replace(All)?\s*\([^)]*api\\?\/v1/;
/**
 * A `new URL(...)` parse whose `pathname` is then recombined with its `search` —
 * the tell of a request path hand-built from a server-supplied link, and the
 * exact #3467 shape (`parsed.pathname + parsed.search`).
 *
 * All three terms are required, in one window, because each on its own is a
 * legitimate and common idiom in this tree: `new URL(x).pathname` reads a link's
 * path (`ExternalLinksSection` pulls an MR number out of one, `feedbackContext`
 * records a route), and `location.pathname + location.search` builds a
 * redirect target from the browser's OWN address (`RequireAuth`,
 * `SessionExpiredBanner`, `StartExploringCallout`). A pattern that fires on
 * those is the over-broad gate rule 300(b) says gets disabled, taking the real
 * protection with it.
 */
const URL_PATHNAME = /new URL\([^)]*\)[\s\S]{0,200}?\.pathname\s*\+[^;\n]{0,60}\.search/;
/** A `getNextPageParam` handing back a raw `.next` URL rather than a normalized one. */
const RAW_NEXT_PAGE_PARAM = /getNextPageParam:\s*\([^)]*\)\s*=>\s*[A-Za-z_$][\w$]*\.next\s*[,;)\n]/;

function rel(f: string): string {
  return f.slice(SRC.length + 1);
}

function offenders(pattern: RegExp): string[] {
  return FILES.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map(rel);
}

describe('DRF pagination links are normalized in exactly one place', () => {
  it('leaves the /api/v1 strip only in api/pagination.ts', () => {
    expect(offenders(STRIP_LOOSE)).toEqual([]);
  });

  it('never derives a request path from new URL(next).pathname', () => {
    // The #3467 shape: `parsed.pathname + parsed.search` handed to apiClient.
    expect(offenders(URL_PATHNAME)).toEqual([]);
  });

  it('never hands a raw absolute `next` back as an infinite-query page param', () => {
    // The useMyWork shape. A page NUMBER (`allPages.length + 1`) or an opaque
    // `next_cursor` is fine — neither reaches axios as a URL — so the pattern
    // matches only a bare `.next` passthrough.
    expect(offenders(RAW_NEXT_PAGE_PARAM)).toEqual([]);
  });

  it('is non-vacuous: every pattern still matches the shape it names', () => {
    // Rule 300(a): a pattern that has silently stopped matching reports zero
    // offenders and is indistinguishable from a clean tree. Plant each shape.
    expect(STRIP_LOOSE.test(`next.replace(/^.*\\/api\\/v1/, '')`)).toBe(true);
    expect(STRIP_PATTERN.test(`x.replace(/^.*\\/api\\/v1/, '')`)).toBe(true);
    expect(URL_PATHNAME.test('const p = new URL(nextUrl);\n p.pathname + p.search')).toBe(true);
    expect(
      URL_PATHNAME.test(
        'const parsed = new URL(nextUrl);\n await get(parsed.pathname + parsed.search);',
      ),
    ).toBe(true);
    expect(RAW_NEXT_PAGE_PARAM.test('getNextPageParam: (lastPage) => lastPage.next,')).toBe(true);

    // …and must NOT match the legitimate neighbours, or the gate misfires and
    // gets disabled (rule 300(b)).
    expect(URL_PATHNAME.test('new URL(window.location.href).pathname')).toBe(false);
    expect(URL_PATHNAME.test('u.pathname.match(/x/)')).toBe(false);
    expect(URL_PATHNAME.test('encodeURIComponent(location.pathname + location.search)')).toBe(
      false,
    );
    expect(
      RAW_NEXT_PAGE_PARAM.test(
        'getNextPageParam: (lastPage, allPages) => (lastPage.next ? allPages.length + 1 : undefined),',
      ),
    ).toBe(false);
    expect(
      RAW_NEXT_PAGE_PARAM.test('getNextPageParam: (last) => last.next_cursor ?? undefined,'),
    ).toBe(false);
  });

  it('scanned a meaningful number of files (the scan itself cannot go vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });
});

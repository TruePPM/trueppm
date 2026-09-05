import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-scan guard on the single pausable auto-dismiss implementation (#3356).
 *
 * The class: a surface that removes itself on a timer while holding a focusable
 * control, with no pause on hover or focus-within (WCAG 2.2.1 / 2.4.3, web rules
 * 356(d) and 377). It was fixed once in the global toast host (#2203), reasoned
 * about again in #3149 (D8), and was still live in three other surfaces the whole
 * time — because each one wrote its own `setTimeout`. Every one of those copies
 * passed its own tests; what a per-file test structurally cannot see is that a
 * *sibling* file dismisses its Undo out from under a keyboard user.
 *
 * So the invariant here is not "the pause is correct" — that is
 * `usePausableAutoDismiss.test.tsx`'s job — it is **"the pause is the only
 * implementation"**. A new hand-rolled `setTimeout(() => setToast(null), n)` fails
 * here at the moment it is written, rather than in the next accessibility audit.
 *
 * Deliberately a source scan rather than a lint rule: the thing being forbidden is
 * a *shape* (a timer that unmounts a transient surface), not a syntactic construct,
 * and a hand-maintained list of "surfaces to check" is exactly the enumeration that
 * let the class survive #2203 and #3149.
 *
 * **What this guard cannot decide, stated up front.** The defect needs the dismissed
 * surface to hold a *focusable control*, and no regex can see that — a first draft
 * that tried matched 30 files, almost all of them `setTimeout(() => setCopied(false))`
 * label swaps, which is precisely the over-broad check rule 300(b) warns gets disabled
 * and takes the real protection with it. So the pattern matches the narrower, textual
 * thing it *can* decide — a timer clearing something the author named a toast/notice —
 * and every surviving match is either fixed or carries an `ALLOWLIST` line saying why
 * it is not. The allowlist is the point, not a leak: it converts "nobody looked" into
 * "somebody wrote down what they decided".
 *
 * Both directions are asserted (rule 300(a)): each pattern has a self-test proving it
 * still matches the code it was written against, so a pattern that silently stops
 * matching cannot report a clean tree.
 */

const here = dirname(fileURLToPath(import.meta.url)); // packages/web/src/components/Toast
const SRC = resolve(here, '../..');

/** The one module allowed to own a pausable auto-dismiss timer. */
const OWNER = resolve(SRC, 'components/Toast/usePausableAutoDismiss.ts');

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
const rel = (f: string) => f.slice(SRC.length + 1);

/**
 * A timer whose callback clears the state gating a transient surface —
 * `setTimeout(() => setToast(null), …)` and its `setNotice`/`setBanner` siblings.
 * This is the exact shape all three #3356 surfaces carried. Scoped to names the
 * author chose for a *surface*, which is what keeps `setCopied(false)` out.
 */
const CLEARS_A_SURFACE =
  /setTimeout\(\s*\(\)\s*=>\s*set(?:Toast|Notice|Banner|Announcement|Reconcile\w*)\(\s*(?:null|false|undefined)\s*\)/;

/**
 * A timer that calls a dismiss/cancel/close callback directly. Separate pattern
 * because it reads nothing about the surface's own state, so `CLEARS_A_SURFACE`
 * is structurally blind to it — which is why it gets its own pattern rather than
 * being quietly out of scope.
 */
const CALLS_A_DISMISS = /setTimeout\(\s*on(?:Cancel|Dismiss|Close|Hide)\s*[,)]/;

/**
 * Surfaces knowingly left on a bare timer, each with the reason. An entry here is a
 * decision with a name, not an exemption: removing one must make the scan pass, never
 * be needed to keep it passing — which the last test in this file enforces.
 */
const ALLOWLIST: Record<string, string> = {
  // Focuses Confirm on mount, so a verbatim focus-within pause would turn
  // "auto-cancels in 5s" into "never auto-cancels" on a destructive-action guard.
  // The remedy is a design call — #3394.
  'features/grid/ConfirmDeleteStrip.tsx': 'needs a design call — #3394',
  // Implements its own hover/focus pause inline (`pausedRef` + onFocusCapture),
  // predating the hook. Correct today; converting it is cosmetic, not a fix.
  'features/schedule/RecalcPercentChip.tsx': 'has an equivalent inline pause',
  // Message-only toasts: no button, no link, nothing focusable inside, so there is
  // no control to remove out from under a keyboard user. Out of the class — but
  // recorded rather than silently unmatched, because adding an Undo to either one
  // puts it back in, and that edit should have to delete a line here.
  'features/settings/program/ProgramRollupPage.tsx': 'message-only toast, no control',
  'features/settings/workspace/WorkspaceDangerPage.tsx': 'message-only toast, no control',
};

describe('pausable auto-dismiss has exactly one implementation (#3356)', () => {
  it('scans a real, non-empty slice of the tree', () => {
    // A glob that silently matched nothing would make every assertion below pass.
    expect(FILES.length).toBeGreaterThan(500);
    const withTimers = FILES.filter((f) => readFileSync(f, 'utf8').includes('setTimeout'));
    expect(withTimers.length).toBeGreaterThan(20);
  });

  it('leaves no surface clearing itself on a bare timer', () => {
    const offenders = FILES.filter((f) => CLEARS_A_SURFACE.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !(f in ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it('leaves no surface calling its own dismiss on a bare timer', () => {
    const offenders = FILES.filter((f) => CALLS_A_DISMISS.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !(f in ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it('still matches the shape it was written against, and nothing else', () => {
    // Both-direction self-test (rule 300(a)): a pattern that stops matching reports a
    // clean tree, which is indistinguishable from a clean tree. These three are the
    // literal pre-fix lines from ScheduleView, RetroBoardSurface and ConfirmDeleteStrip.
    expect(
      CLEARS_A_SURFACE.test('const handle = window.setTimeout(() => setToast(null), duration);'),
    ).toBe(true);
    expect(CLEARS_A_SURFACE.test('const t = setTimeout(() => setToast(null), 8000);')).toBe(true);
    expect(CALLS_A_DISMISS.test('const timer = setTimeout(onCancel, 5000);')).toBe(true);
    // …and the things it must leave alone: label swaps, debounces, polling, and
    // mount-time focus management. Matching these is how this guard gets deleted.
    expect(CLEARS_A_SURFACE.test('setTimeout(() => setCopied(false), 1500);')).toBe(false);
    expect(CLEARS_A_SURFACE.test('const t = setTimeout(() => refetch(), 500);')).toBe(false);
    expect(CLEARS_A_SURFACE.test('setTimeout(() => inputRef.current?.focus(), 0);')).toBe(false);
    expect(CALLS_A_DISMISS.test('setTimeout(onSettled, 300);')).toBe(false);
  });

  it('keeps every allowlisted surface actually matching a pattern', () => {
    // An allowlist entry that no longer matches is either a fixed surface whose entry
    // was never removed, or a pattern that drifted off it. Both are silent failures.
    for (const [file, why] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const matched = CLEARS_A_SURFACE.test(source) || CALLS_A_DISMISS.test(source);
      expect(matched, `${file} (${why}) no longer matches — remove it from ALLOWLIST`).toBe(true);
    }
  });

  it('routes every converted surface through the shared hook', () => {
    // The positive half. The scan above catches a re-inlined timer; it would NOT catch
    // a regression that deletes the dwell entirely, which this does.
    //
    // Matched on the IMPORT, not on the name appearing anywhere: every one of these
    // files also *names* the hook in a comment explaining why it uses it, so a
    // `toContain('usePausableAutoDismiss')` passes on a file that has removed the
    // call and kept the paragraph — which is exactly what happened when this test
    // was first written and watched against the pre-fix source.
    const IMPORTS_HOOK = /import\s*\{[^}]*\busePausableAutoDismiss\b[^}]*\}\s*from/;
    for (const file of [
      'components/Toast/ToastHost.tsx',
      'features/schedule/ScheduleView.tsx',
      'features/grid/GridView.tsx',
      'features/sprints/RetroBoardSurface.tsx',
    ]) {
      expect(IMPORTS_HOOK.test(readFileSync(resolve(SRC, file), 'utf8')), file).toBe(true);
    }
  });
});

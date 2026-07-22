import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Automated accessibility assertions for the Playwright e2e suite (#1685).
 *
 * WCAG 2.1 AA is a hard requirement for TruePPM (the /accessibility skill and the
 * Design System brand rules), but nothing in CI gated it — contrast, missing
 * accessible names, and ARIA regressions could only be caught by a human running
 * the audit. This helper wires axe-core into the existing `web:e2e` job so those
 * regressions fail the pipeline instead.
 *
 * It is a *foothold* gate, deliberately scoped so it lands green and can be
 * ratcheted up later (more routes, a lower impact floor) rather than blocking on
 * a full-app audit:
 *   - Scans against the WCAG 2.1 A/AA tag set only — the same bar the
 *     /accessibility skill audits to — not axe's full best-practice ruleset,
 *     which includes opinionated rules that are not WCAG success criteria.
 *   - Fails only on `critical` and `serious` impact. `moderate`/`minor` findings
 *     are still attached to the report as ratchet candidates but do not fail.
 *
 * ## Impact-floor ratchet (#2202)
 *
 * The GLOBAL floor stays `critical`/`serious` — flipping `moderate` on for every
 * scan at once would light up the not-yet-fixed `moderate` debt on routes whose
 * audit fixes are still in flight (the 2026-07-18 audit). Instead the floor is
 * ratcheted **per scope**: a scan that is verified clean at `moderate` opts in
 * with `gateModerate: true`, so its `moderate` findings fail the build too. As
 * each remaining route's audit fix lands and its scan proves clean, flip
 * `gateModerate` on for it; once every scan carries it, promote `moderate` into
 * the global `GATED_IMPACTS` set and drop the per-call flag. This is a monotonic
 * ratchet — a scope never loses a gated impact level once it has earned one.
 */

/** Impact levels that fail the build for every scan. Ratchet downward (add
 *  `moderate`) globally only once every scan opts in via `gateModerate`. */
const GATED_IMPACTS = new Set(['critical', 'serious']);

/** WCAG 2.1 Level A + AA tags — the success criteria TruePPM commits to. */
const WCAG_21_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export interface A11yScanOptions {
  /**
   * CSS selectors to exclude from the scan. Use sparingly and only for content
   * TruePPM does not own (e.g. a third-party embed); document why at the call site.
   */
  exclude?: string[];
  /**
   * axe rule ids to disable. Each must carry a documented justification at the
   * call site — a disabled rule is a hole in the gate, not a convenience.
   */
  disableRules?: string[];
  /**
   * Per-scope impact ratchet (#2202). When `true`, `moderate` violations fail
   * this scan in addition to the global `critical`/`serious` floor. Set it only
   * on a scan that has been verified clean at `moderate`; leave it off on scopes
   * whose `moderate` debt is still being worked so the gate stays green. See the
   * "Impact-floor ratchet" note in the module docstring.
   */
  gateModerate?: boolean;
}

/**
 * Scan the current page state with axe and assert there are no critical/serious
 * WCAG 2.1 A/AA violations.
 *
 * Call after the page under test has rendered (gate on a "page ready" locator
 * first — scanning mid-load produces noise from transient skeleton states).
 *
 * @param page     The page to scan (scanned in its current DOM state).
 * @param testInfo The test's TestInfo, used to attach the violation report.
 * @param options  Optional exclusions / rule disables (each needs justification).
 */
export async function expectNoA11yViolations(
  page: Page,
  testInfo: TestInfo,
  options: A11yScanOptions = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_21_AA_TAGS);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  if (options.disableRules?.length) builder = builder.disableRules(options.disableRules);

  const results = await builder.analyze();
  const gatedImpacts = options.gateModerate
    ? new Set([...GATED_IMPACTS, 'moderate'])
    : GATED_IMPACTS;
  const gated = results.violations.filter((v) => gatedImpacts.has(v.impact ?? ''));

  // Attach the FULL violation set (gated + ungated) so a failure is actionable
  // from the report alone — no rerun needed — and so moderate/minor ratchet
  // candidates stay visible even on a green run.
  if (results.violations.length) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
  }

  const summary = gated
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        `    ${v.helpUrl}\n` +
        v.nodes.map((n) => `      → ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n');

  const floorLabel = [...gatedImpacts].join('/');
  expect(
    gated,
    `Found ${gated.length} ${floorLabel} WCAG 2.1 A/AA accessibility violation(s):\n${summary}`,
  ).toEqual([]);
}

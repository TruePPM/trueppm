import { test, expect } from './fixtures/coverage';

import { expectNoA11yViolations, setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * Accessibility foothold gate (#1685).
 *
 * Runs axe-core against TruePPM's core chrome inside the existing `web:e2e` job
 * and fails on critical/serious WCAG 2.1 A/AA violations. This is intentionally a
 * small, reliable foothold — the public login page plus the authenticated app
 * shell — so the gate lands green and can be ratcheted up (more routes, a lower
 * impact floor) in follow-up MRs. See `fixtures/a11y.ts` for the scan policy.
 *
 * Each test gates on a "page rendered" locator before scanning: axe on a
 * mid-load DOM (loading skeletons, un-hydrated regions) reports transient noise.
 */

/**
 * `color-contrast` is fully enforced. The foothold's first run (#1685) surfaced
 * only pre-existing DS-v2 color-token contrast debt — the sage-500 wordmark,
 * login disabled/placeholder text, the brand-primary/15 badge, and the StatusBar
 * build hash on the sunken surface. That debt was resolved through /brand +
 * /ux-review in #1689 (wordmark → sage-700 brand-primary; disabled text →
 * secondary; badge tint /15 → /10; StatusBar moved to the raised surface), so the
 * gate now runs with no rule exclusions — every critical/serious WCAG 2.1 A/AA
 * rule, contrast included, fails the pipeline.
 */
test.describe('accessibility @a11y', () => {
  test('login page has no critical/serious WCAG violations', async ({ page }, testInfo) => {
    // Public route — no auth seed, no API mocks needed. It renders a self-
    // contained credentials form, which makes it a stable, deterministic target.
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await expectNoA11yViolations(page, testInfo);
  });

  test('authenticated app shell has no critical/serious WCAG violations', async ({
    page,
  }, testInfo) => {
    // Seed auth and mock the shell's data reads so the chrome (top bar, rail,
    // status bar) renders fully before axe runs. setupCatchAll must be registered
    // before setupApiMocks so specific routes win (Playwright matches in reverse).
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page);

    await page.goto('/');
    // Banner (TopBar) is the last piece of chrome to settle — a reliable
    // "shell rendered" signal before scanning.
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();

    await expectNoA11yViolations(page, testInfo);
  });
});

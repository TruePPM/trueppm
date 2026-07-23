import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';
import type { Locator } from '@playwright/test';

/**
 * Pointer-focus ring smoke (#2292) — regression guard for the rule-4/214
 * `focus:`-on-standalone-triggers pattern that #2166 (MR !1585) applies at scale.
 *
 * Firefox, desktop Safari, AND Chromium all decline to match `:focus-visible`
 * when a `<button>` is focused by a *mouse click*, so a standalone trigger styled
 * `focus-visible:ring-*` shows NO focus ring after a click — a WCAG 2.4.7 (Focus
 * Visible) failure. The fix is `focus:ring-*` on standalone triggers (form fields
 * keep `focus-visible:`). This is exactly the behavioral pair no vitest/jsdom test
 * can exercise, because it hinges on real-browser `:focus-visible` heuristics:
 *
 *   (+) a `focus:` trigger paints its ring on pointer focus;
 *   (-) a `focus-visible:` control does not — the precise gap the fix closes.
 *
 * Chromium is sufficient: it shares the pointer `:focus-visible` suppression the
 * bug depends on, so a Chromium-only run still discriminates the two. The
 * negative case is self-validating — if a future Chromium ever started matching
 * `:focus-visible` on click, it fails loudly, signalling the guard's premise broke.
 *
 * Assertions compare box-shadow before vs. after focus (Tailwind `ring-*` renders
 * as a box-shadow), so a baseline shadow on the control cannot mask the result:
 * the test asserts the ring is *added* (or not) by pointer focus, not its absolute value.
 */

const PROJECT_ID = 'e2e-focusring-0000-0000-0000-000000002292';
const CAL_URL = `/projects/${PROJECT_ID}/calendar?calAnchor=2026-03-01`;

/** Read a control's computed box-shadow — where a Tailwind `ring-*` utility lands. */
function boxShadow(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).boxShadow);
}

test.describe('Pointer-focus ring (rule 4/214)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Focus Ring Project', start_date: '2026-03-01' }],
      tasks: [],
    });
    await page.goto(CAL_URL);
    // Gate on a page-rendered signal (not just a control's toBeVisible) before
    // interacting with chrome on a data-driven route.
    await expect(page.getByRole('group', { name: 'Calendar view mode' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a focus: standalone trigger paints its ring on pointer (mouse) focus', async ({ page }) => {
    // The shell notification bell is a rule-35 reference `focus:` trigger, present
    // on every authenticated page.
    const bell = page.getByRole('button', { name: /Notifications/ });
    await expect(bell).toBeVisible();

    const before = await boxShadow(bell);

    // Give the button *pointer* focus without opening its popover: mousedown
    // focuses the element; its onClick only fires on the (later) mouseup.
    const box = await bell.boundingBox();
    expect(box, 'notification bell should have a bounding box').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    const after = await boxShadow(bell);
    await page.mouse.up();

    // focus: paints the ring on pointer focus — the ring is added vs. the resting state.
    expect(after).not.toBe('none');
    expect(after).not.toBe(before);
  });

  test('a focus-visible: control does NOT ring on pointer (mouse) focus — the gap #2166 closes', async ({
    page,
  }) => {
    // The calendar view-mode toggle still uses focus-visible: (the calendar tree
    // is not part of the #2166 conversion). Its segments are plain aria-pressed
    // toggle buttons: clicking one keeps focus on it (no popover, no navigation),
    // so this is a clean negative control.
    const group = page.getByRole('group', { name: 'Calendar view mode' });
    const week = group.getByRole('button', { name: 'week' });

    const before = await boxShadow(week);
    await week.click(); // real pointer click -> pointer focus
    await expect(week).toHaveAttribute('aria-pressed', 'true');
    const after = await boxShadow(week);

    // focus-visible: does not match on pointer focus in Chromium -> no ring added.
    // (This is the pre-fix behavior; converting such a control to focus: is what
    // makes the ring appear — asserted positively in the test above.)
    expect(after).toBe(before);
  });
});

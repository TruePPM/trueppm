import type { Page } from '@playwright/test';

/**
 * The narrowest viewport at which the Schedule toolbar holds its **full**
 * composition — every control a button in the bar, nothing collapsed.
 *
 * Measured, not guessed (#3076): the bar's available width is
 * `window − rail − padding`, and the fit ladder starts conceding at 1,672px of
 * bar. Playwright's `devices['Desktop Chrome']` is 1280×720, which leaves
 * ~1,032px — enough room for the ladder to have spent eight of its rungs, so
 * the structure trio is behind `Structure ▾`, the zoom stepper is one
 * `Zoom: Week` button, and `Read / Author` is a single collapsed chip.
 */
export const FULL_TOOLBAR_VIEWPORT = { width: 1920, height: 1080 } as const;

/**
 * Give a spec the toolbar's full composition.
 *
 * Reach for this when a spec drives the schedule *through* a toolbar control
 * but the control is not its subject — grouping rows, zooming to a tier,
 * opening the cheatsheet. Those specs were written when 1280 still showed the
 * whole bar, and pinning the width keeps each one testing what it is named
 * after instead of re-deriving where the ladder put its button.
 *
 * It is deliberately **not** a global default: what the bar does as it narrows
 * is a real behaviour with a real owner, and that owner is
 * `schedule-toolbar-fit.spec.ts`. Widening a spec here must never be the reason
 * a clipped control goes unnoticed there.
 */
export async function useFullToolbar(page: Page): Promise<void> {
  await page.setViewportSize({ ...FULL_TOOLBAR_VIEWPORT });
}

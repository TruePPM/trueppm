import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Drive the Schedule's merged mode control (#3263).
 *
 * `BuildModePill` and `AuthorModePill` were two toolbar controls answering one
 * question — "what can I do to this plan right now" — and they merged into
 * `ScheduleModeChip` at every width. The chip **states** the mode on its
 * trigger and **changes** it from its popover, so a spec that used to click one
 * pill now performs two acts.
 *
 * Wrapped here rather than repeated: the composition is the thing #3263 chose,
 * and a dozen specs each re-encoding it is a dozen places to edit when the next
 * issue moves the `Author` → `Amend` relabel onto this control.
 */
export function modeChip(page: Page): Locator {
  return page.getByTestId('schedule-mode-chip');
}

/** Flip Read ⇄ Author through the chip's popover. */
export async function toggleAuthorMode(page: Page): Promise<void> {
  await modeChip(page).click();
  await page.getByRole('menuitemcheckbox', { name: /Author mode/ }).click();
  // The popover keeps checkbox items open on purpose (multi-toggle), so it has
  // to be dismissed or it covers whatever the spec asserts on next.
  await page.keyboard.press('Escape');
}

/** Open the keyboard cheatsheet — the retired `BuildModePill`'s only act. */
export async function openScheduleCheatsheet(page: Page): Promise<void> {
  await modeChip(page).click();
  await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
  await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
}

import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Locators for the ⌘K command palette.
 *
 * These exist because `page.getByRole('combobox')` is **not** a safe way to reach the
 * palette input. The palette is only one of several comboboxes the app renders, and a
 * page-level query matches whichever ones happen to be mounted:
 *
 * - `features/reports/BurnChart.tsx` — `<select aria-label="Metric">`
 * - `features/shell/commandPalette/CommandPalette.tsx` — the palette input itself
 * - `features/shell/LocationSegment.tsx`
 * - `components/EntitySelectCombobox.tsx`
 *
 * Two failure modes follow, and the second is the dangerous one (#2778):
 *
 * 1. **Strict-mode violation** — two matches, the call throws. Noisy, but honest. This
 *    reddened `main` on pipeline `070ea052` via `command-palette-labels.spec.ts`.
 * 2. **A silent false pass** — `getByRole('combobox').or(getByRole('textbox')).first()`
 *    resolves to the *first match in DOM order*, which is the BurnChart `<select>`, not
 *    the palette. `keyboard-shortcuts-help.spec.ts` asserted `toHaveValue('?')` against
 *    that select and read back `"tasks"`; the spec had never tested the palette at all.
 *    The `.or(...)` fallback is what makes the wrong element selectable, so it is gone
 *    rather than merely narrowed.
 *
 * The failure is nondeterministic *across* runs (it needs a colliding combobox mounted)
 * but deterministic *within* one — Playwright's own test-level retry reproduces it. Only
 * a job-level retry clears it, and per #2754 the flaky ledger never sees those. So this
 * class gets retried away instead of fixed unless the locator itself is scoped.
 *
 * Always reach the palette through these helpers; never re-derive it from `page`.
 */

/** The palette dialog. `aria-label="Command palette"` — CommandPalette.tsx. */
export function paletteDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Command palette' });
}

/**
 * The palette's search input, scoped to the dialog so no other combobox can match.
 *
 * Pass the dialog when you already hold it — saves re-querying and keeps a single
 * source of truth for the scope within a spec.
 */
export function paletteSearch(page: Page, dialog?: Locator): Locator {
  return (dialog ?? paletteDialog(page)).getByRole('combobox');
}

/**
 * Open the palette with the ⌘K/Ctrl+K hotkey and wait for it to be usable.
 *
 * Waits on the *input* rather than only the dialog: the dialog animates in
 * (`motion-safe:animate-cmdk-in`), so a dialog that is visible is not yet a dialog whose
 * input accepts a `fill()`. Returns both handles so callers do not re-query.
 */
export async function openCommandPalette(
  page: Page,
): Promise<{ dialog: Locator; search: Locator }> {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = paletteDialog(page);
  await expect(dialog).toBeVisible();
  const search = paletteSearch(page, dialog);
  await expect(search).toBeVisible();
  return { dialog, search };
}

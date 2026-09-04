import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * The Start sheet's unsaved-changes guard (web-rule 217, #3310).
 *
 * The sheet collects a name, a program, a start date, a calendar override and a
 * draft flag, and every one of its four dismiss paths — Escape, backdrop, the
 * compact ×, Cancel — discarded all of it silently. It is the only in-app
 * project-create surface and is mounted from six places, so an accidental
 * backdrop click meant re-entering the whole setup with nothing to say it had
 * been lost.
 *
 * `NewProjectModal.test.tsx` covers all four paths in jsdom. This spec exists
 * for the half jsdom cannot answer:
 *
 * - **The backdrop click is a hit-test, not a handler call.** The scrim is a
 *   full-screen `<button>` and the dialog panel sits on top of it, so a plain
 *   `.click()` lands on the panel. The unit test invokes the handler directly
 *   and would stay green even if the scrim were unreachable in a real layout.
 * - **Focus containment is only observable in a browser.** Per web-rule 362,
 *   jsdom does not move focus the way a browser does, so a "focus stayed in the
 *   guard" assertion written against jsdom is vacuous by construction. The
 *   guard is a nested `alertdialog` running its own trap while the sheet's
 *   parent trap yields (rule 245(b)) — that hand-off has to be checked here.
 */

const PROJECT_ID = 'e2e-guard-0000-0000-0000-0000-000000003310';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

async function setupRoutes(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projectId: PROJECT_ID,
    projects: [
      {
        id: PROJECT_ID,
        name: 'Apollo Replan',
        description: '',
        start_date: '2026-09-01',
        calendar: 'default',
        health: 'AUTO',
        open_task_count: 0,
      },
    ],
    selfRole: 300,
  });

  // Endpoints the sheet's own hooks read on mount. Unmocked they fall to the
  // catch-all, which serves a LIST shape for everything — truthy but malformed
  // for an object endpoint like `/workspace/`, which is the #1190 flake class.
  // Mock each with its real shape rather than leaning on the 401-guard net.
  await page.route(/\/api\/v1\/project-templates\/(\?.*)?$/, async (route) => {
    await route.fulfill(json({ count: 0, next: null, previous: null, results: [] }));
  });
  await page.route(/\/api\/v1\/programs\/(\?.*)?$/, async (route) => {
    await route.fulfill(json({ count: 0, next: null, previous: null, results: [] }));
  });
  await page.route(/\/api\/v1\/workspace\/$/, async (route) => {
    await route.fulfill(json({ methodology: 'HYBRID', calendar: null }));
  });
}

/**
 * The rail's "+ New project" control lives inside the Tier-3 "Browse"
 * disclosure, closed by default. Opening it is part of reaching the sheet.
 */
async function openSheet(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browse projects and programs' }).click();
  await page.getByRole('button', { name: '+ New project' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Click the scrim where the dialog is not. A bare `.click()` targets the
 * element's centre, which the dialog panel covers — the exact reason this
 * assertion cannot live in the unit test.
 */
async function clickBackdrop(page: Page) {
  await page.getByRole('button', { name: 'Close dialog' }).click({ position: { x: 8, y: 8 } });
}

test.describe('Start sheet — unsaved-changes guard (#3310)', () => {
  test('a dirty backdrop dismiss prompts, and Keep editing returns the typed values', async ({
    page,
  }) => {
    await setupRoutes(page);
    const dialog = await openSheet(page);
    const name = dialog.getByRole('textbox', { name: /^name/i });
    await name.fill('Apollo Replan');

    await clickBackdrop(page);

    const guard = page.getByRole('alertdialog');
    await expect(guard).toBeVisible();
    await expect(guard).toContainText('Discard unsaved changes?');
    // The sheet is still mounted behind it — the dismiss was refused, not deferred.
    await expect(dialog).toBeVisible();

    await guard.getByRole('button', { name: /keep editing/i }).click();

    await expect(guard).toHaveCount(0);
    await expect(name).toHaveValue('Apollo Replan');
  });

  test('Discard changes closes the sheet', async ({ page }) => {
    await setupRoutes(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('textbox', { name: /^name/i }).fill('Apollo Replan');

    await clickBackdrop(page);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /discard changes/i })
      .click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('an untouched sheet still closes on one backdrop click', async ({ page }) => {
    // The guard must not tax the common case: opening the sheet and thinking
    // better of it is one click, exactly as it was before.
    await setupRoutes(page);
    const dialog = await openSheet(page);

    await clickBackdrop(page);

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
  });

  test('focus moves into the guard and Tab cannot leave it', async ({ page }) => {
    // Rule 245(b): the sheet's own document-level Tab handler must yield while
    // the nested alertdialog is open, or the two traps fight over focus and Tab
    // walks back into the form behind the scrim (WCAG 2.4.3 / 2.1.2).
    await setupRoutes(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('textbox', { name: /^name/i }).fill('Apollo Replan');

    await page.keyboard.press('Escape');
    const guard = page.getByRole('alertdialog');
    await expect(guard).toBeVisible();

    // Seats on the safe path, never the destructive verb.
    await expect(guard.getByRole('button', { name: /keep editing/i })).toBeFocused();

    // Cycle past the end of the guard's two buttons; focus must wrap, not escape.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
    await expect(guard.locator(':focus')).toHaveCount(1);
  });
});

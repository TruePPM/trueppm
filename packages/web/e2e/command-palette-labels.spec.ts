import { test, expect, type Page } from './fixtures/coverage';
import {
  paletteSearch,
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  type ProjectFixture,
} from './fixtures';

/**
 * E2E coverage for the ⌘K "Labels" group (#2334).
 *
 * Golden path: from inside a project, open the palette, type a label name, and
 * land on the Board with that label's facet pre-applied via `?fl=`.
 * Edge: the group is query-gated (a cold palette lists no labels) and Tier-2
 * (absent off a project route, because the label catalog is project-scoped).
 *
 * All API calls are route-mocked; no server required.
 */

const PROJECT_ID = 'cmdk-label-proj-00000000-0000-0000-0000-000000002334';

const PROJECTS: ProjectFixture[] = [{ id: PROJECT_ID, name: 'Atlas Migration' }];

const LABELS = [
  { id: 'lab-rework', name: 'Rework', color: '#B45309', position: 0, server_version: 1, task_count: 12 },
  { id: 'lab-review', name: 'Needs review', color: '#1D4ED8', position: 1, server_version: 1, task_count: 1 },
];

async function setup(page: Page, { inProject = true } = {}): Promise<void> {
  await setupAuth(page);
  // Catch-all FIRST so an endpoint this page reads but we forgot returns a typed
  // 404 rather than falling through and 401ing (#2366). Specific routes below win.
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID });
  // The label catalog the palette group is built from. Registered last so it
  // beats the catch-all's empty-list shape.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: LABELS.length, next: null, previous: null, results: LABELS }),
    }),
  );
  await page.goto(inProject ? `/projects/${PROJECT_ID}/overview` : '/me/work');
}

/** Open the palette and wait for the combobox to be ready. */
async function openPalette(page: Page) {
  await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('⌘K — find tasks by label (#2334)', () => {
  test('typing a label name deep-links to the Board with the facet applied', async ({ page }) => {
    await setup(page);
    const dialog = await openPalette(page);

    await paletteSearch(page).fill('rework');
    const row = dialog.getByRole('option', { name: /Rework .*12 tasks.*Label/ });
    await expect(row).toBeVisible();

    await row.click();
    // The Board reads `?fl=` on arrival (boardFacets PARAM_LABELS) — a URL that
    // carries facets wins over stored state, so the filter is applied on landing.
    await expect(page).toHaveURL(
      new RegExp(`/projects/${PROJECT_ID}/board\\?fl=lab-rework`),
    );
  });

  test('the group is query-gated — a cold palette lists no labels', async ({ page }) => {
    await setup(page);
    const dialog = await openPalette(page);

    // Palette open, nothing typed: other groups render, the Labels group does not.
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Rework/ })).toHaveCount(0);
    await expect(dialog.getByText('Labels', { exact: true })).toHaveCount(0);
  });

  test('is Tier-2 — no Labels group off a project route', async ({ page }) => {
    await setup(page, { inProject: false });
    const dialog = await openPalette(page);

    await paletteSearch(page).fill('rework');
    // Labels are project-scoped (ADR-0400); a cross-project label view is #2333.
    await expect(dialog.getByRole('option', { name: /Rework/ })).toHaveCount(0);
  });
});

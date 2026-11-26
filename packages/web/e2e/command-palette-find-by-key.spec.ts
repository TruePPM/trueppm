import { test, expect, type Page } from './fixtures/coverage';
import {
  paletteSearch,
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  type ProjectFixture,
} from './fixtures';

/**
 * ⌘K find-by-key (#3888, ADR-1237): typing a key or a `PLAT-T-10` reference asks
 * `GET /api/v1/resolve/` and offers the answer as a **Reference** row.
 *
 * Golden path: a task reference resolves, the row shows the current form, and
 * Enter opens the task under the project key. Empty state: a reference the server
 * 404s (missing or not visible, indistinguishable by design) reads "No matches".
 */

const PROJECT: ProjectFixture = { id: 'cmdk-key-proj', name: 'Platform Core' };
const TASK_ID = '7a1d0c4e-2b3f-4c5d-8e9f-0a1b2c3d4e5f';

async function setup(page: Page, refs: string[]): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT.id });
  await page.route('**/api/v1/resolve/**', async (route) => {
    const ref = new URL(route.request().url()).searchParams.get('ref') ?? '';
    refs.push(ref);
    if (ref.toUpperCase() === 'PLAT-T-10') {
      await route.fulfill({
        json: {
          type: 'task',
          id: TASK_ID,
          project_id: PROJECT.id,
          program_id: null,
          key: 'PLAT',
          canonical_ref: 'PLAT-T-10',
        },
      });
      return;
    }
    if (ref.toUpperCase() === 'PLAT') {
      await route.fulfill({
        json: {
          type: 'project',
          id: PROJECT.id,
          project_id: PROJECT.id,
          program_id: null,
          key: 'PLAT',
          canonical_ref: 'PLAT',
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: 'Not found.' } });
  });
  await page.goto('/me/work');
  await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
}

test.describe('command palette: find by key', () => {
  test('a task reference resolves and opens under the project key', async ({ page }) => {
    const refs: string[] = [];
    await setup(page, refs);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await paletteSearch(page).fill('plat-t-10');
    const row = dialog.getByRole('option', { name: 'PLAT-T-10 Task', exact: true });
    await expect(row).toBeVisible();
    // The palette sent the query untouched; the server does the parsing.
    expect(refs).toContain('plat-t-10');

    await paletteSearch(page).press('Enter');
    await expect(page).toHaveURL(new RegExp(`/projects/PLAT/[^?]+\\?task=${TASK_ID}$`));
  });

  test('a reference the server does not resolve reads as no matches', async ({ page }) => {
    const refs: string[] = [];
    await setup(page, refs);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await paletteSearch(page).fill('NOPE-T-1');
    await expect.poll(() => refs.includes('NOPE-T-1')).toBe(true);
    await expect(dialog.getByText('No matches for “NOPE-T-1”.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /NOPE-T-1/ })).toHaveCount(0);
  });
});

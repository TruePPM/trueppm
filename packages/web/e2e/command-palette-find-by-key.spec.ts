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
 * Enter opens the task under the project key; a bare key in capitals offers its
 * project. A risk reference opened from the register
 * itself opens that risk's drawer. Empty state: a reference the server 404s
 * (missing, or in a project you are not a member of, indistinguishable by design)
 * reads "No matches".
 */

const PROJECT: ProjectFixture = { id: 'cmdk-key-proj', name: 'Platform Core' };
const TASK_ID = '7a1d0c4e-2b3f-4c5d-8e9f-0a1b2c3d4e5f';
const RISK_ID = '9b2e1d5f-3c4a-4d6e-9f10-1b2c3d4e5f6a';
const RISK = {
  id: RISK_ID,
  short_id: '7',
  short_id_display: 'R-007',
  qualified_id: 'PLAT-R-7',
  server_version: 1,
  project: PROJECT.id,
  title: 'Vendor delay',
  description: 'Lead time may slip',
  status: 'OPEN',
  probability: 4,
  impact: 4,
  severity: 16,
  owner: null,
  owner_name: null,
  owner_initials: null,
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  tasks: [],
  category: 'TECHNICAL',
  response: 'MITIGATE',
  mitigation_due_date: null,
  trigger: '',
  contingency: '',
  notes: '',
};

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
    if (ref.toUpperCase() === 'PLAT-R-7') {
      await route.fulfill({
        json: {
          type: 'risk',
          id: RISK_ID,
          project_id: PROJECT.id,
          program_id: null,
          key: 'PLAT',
          canonical_ref: 'PLAT-R-7',
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

  test('a bare key in capitals offers the project as a reference', async ({ page }) => {
    const refs: string[] = [];
    await setup(page, refs);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await paletteSearch(page).fill('PLAT');
    await expect(dialog.getByRole('option', { name: 'PLAT Project', exact: true })).toBeVisible();
    await expect(dialog.getByText('Reference', { exact: true })).toBeVisible();
    expect(refs).toContain('PLAT');
  });

  test('a risk reference opened from the register opens that risk', async ({ page }) => {
    const refs: string[] = [];
    await setup(page, refs);
    await page.route('**/api/v1/projects/*/risks/', (route) =>
      route.fulfill({ json: { count: 1, next: null, previous: null, results: [RISK] } }),
    );
    await page.goto('/projects/PLAT/risk');
    await expect(page.getByRole('button', { name: 'Open risk: Vendor delay' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await paletteSearch(page).fill('PLAT-R-7');
    await expect(palette.getByRole('option', { name: 'PLAT-R-7 Risk', exact: true })).toBeVisible();
    await paletteSearch(page).press('Enter');

    await expect(page).toHaveURL(new RegExp(`/projects/PLAT/risk\\?risk=${RISK_ID}$`));
    await expect(page.getByRole('dialog').getByText('Vendor delay').first()).toBeVisible();
  });

  test('a reference the server does not resolve reads as no matches', async ({ page }) => {
    const refs: string[] = [];
    await setup(page, refs);
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    // Registered before typing, so the absence assertions run after the answer.
    const answered = page.waitForResponse(
      (res) => res.url().includes('/api/v1/resolve/') && res.url().includes('NOPE-T-1'),
    );
    await paletteSearch(page).fill('NOPE-T-1');
    expect((await answered).status()).toBe(404);
    expect(refs).toContain('NOPE-T-1');
    await expect(dialog.getByText('No matches for “NOPE-T-1”.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('option', { name: /NOPE-T-1/ })).toHaveCount(0);
  });
});

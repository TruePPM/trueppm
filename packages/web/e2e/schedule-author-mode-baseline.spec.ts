/**
 * The Schedule mode chip leads the toolbar, Read hides the create controls, and
 * Read → Author on a baselined plan asks once per baseline (#3748).
 *
 * Toggles are driven through a local helper rather than the shared
 * `toggleAuthorMode` fixture: that fixture presses Escape after the click to
 * dismiss the popover, and on a baselined plan the thing on screen after the
 * click is the confirm — so Escape would cancel it and the spec would assert
 * against a dialog it had itself dismissed.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { modeChip } from './fixtures/schedule-mode';

const PROJECT_ID = 'e2e-baseauth-0000-0000-0000-000000003748';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECT = [
  {
    id: PROJECT_ID,
    name: 'Baselined Plan',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    can_author: true,
  },
];

const TASKS = [
  {
    id: 'ba1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

const BASELINE_V1 = {
  id: 'bl-0000-0000-0000-000000000001',
  project: PROJECT_ID,
  name: 'Baseline v1',
  created_by: null,
  created_at: '2026-04-01T09:00:00Z',
  is_active: true,
  has_cpm_dates: true,
  task_count: 1,
};

const BASELINES_URL = new RegExp(`/api/v1/projects/${PROJECT_ID}/baselines/(\\?.*)?$`);

async function gotoSchedule(
  page: Page,
  baselines: { status: 200; results: unknown[] } | { status: 500 },
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECT, projectId: PROJECT_ID, tasks: TASKS });
  // Registered last so it wins over the catch-all.
  await page.route(BASELINES_URL, async (route) => {
    if (baselines.status === 500) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: baselines.results.length,
        next: null,
        previous: null,
        results: baselines.results,
      }),
    });
  });
  await page.goto(BASE_URL);
  await expect(page.getByText('Foundation').first()).toBeVisible();
}

/** Open the chip and flip Author mode — no Escape afterwards (see file header). */
async function pickAuthorMode(page: Page): Promise<void> {
  await modeChip(page).click();
  await page.getByRole('menuitemcheckbox', { name: /Author mode/ }).click();
}

test.describe('Schedule mode chip and baselined Author (#3748)', () => {
  test('the chip leads the toolbar, and Read hides the create controls', async ({ page }) => {
    await gotoSchedule(page, { status: 200, results: [] });

    const addItem = page.getByRole('button', { name: 'Add item' });
    await expect(addItem).toBeVisible();
    const chipBox = await modeChip(page).boundingBox();
    const addBox = await addItem.boundingBox();
    expect(chipBox && addBox && chipBox.x < addBox.x).toBe(true);

    await pickAuthorMode(page);
    await expect(modeChip(page)).toHaveText(/Read only\s*·\s*Switch to Author to edit/);
    await expect(addItem).toHaveCount(0);

    // No baseline, so the way back is immediate.
    await pickAuthorMode(page);
    await expect(page.getByTestId('baselined-author-confirm')).toHaveCount(0);
    await expect(modeChip(page)).toHaveText(/^Author$/);
    await expect(addItem).toBeVisible();
  });

  test('entering Author on a baselined plan asks once per baseline', async ({ page }) => {
    await gotoSchedule(page, { status: 200, results: [BASELINE_V1] });
    await expect(modeChip(page)).toContainText('vs Baseline v1');

    // Author → Read never asks.
    await pickAuthorMode(page);
    await expect(modeChip(page)).toContainText('Read only');

    // Read → Author asks, and backing out stays in Read.
    await pickAuthorMode(page);
    const dialog = page.getByRole('dialog', { name: 'This plan has a baseline' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Baseline v1');
    await dialog.getByRole('button', { name: 'Stay in Read' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(modeChip(page)).toContainText('Read only');

    // Continuing enters Author, with the baseline on the chip.
    await pickAuthorMode(page);
    await dialog.getByRole('button', { name: 'Switch to Author' }).click();
    // Anchored: the Read label also contains the word "Author".
    await expect(modeChip(page)).toHaveText(/^Author\s*·\s*vs Baseline v1$/);

    // Same baseline: the next round trip does not ask again.
    await pickAuthorMode(page);
    await expect(modeChip(page)).toContainText('Read only');
    await pickAuthorMode(page);
    await expect(modeChip(page)).toContainText('vs Baseline v1');
    await expect(page.getByTestId('baselined-author-confirm')).toHaveCount(0);
  });

  test('a failed baselines read still asks rather than assuming none', async ({ page }) => {
    await gotoSchedule(page, { status: 500 });

    await pickAuthorMode(page);
    await expect(modeChip(page)).toContainText('Read only');
    await pickAuthorMode(page);
    await expect(page.getByRole('dialog', { name: 'This plan may have a baseline' })).toBeVisible();
  });
});

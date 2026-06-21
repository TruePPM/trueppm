/**
 * E2E for the Board "Export PDF" action (issue 326, ADR-0159).
 *
 * Golden path: open the More⋯ overflow on a desktop viewport, click Export PDF,
 * and assert a `board-*.pdf` download is produced by the client-side
 * html-to-image + jsPDF pipeline rasterizing the off-screen print layout.
 * Mobile: the action is hidden below the `sm` breakpoint (a deck export is a
 * desktop task).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-pdf-00000000-0000-0000-0000-000000000326';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Deck Export Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const COMMITTED_TASK = {
  id: 't1',
  wbs_path: '1.1',
  name: 'Stakeholder interviews',
  parent_id: 'phase-1',
  status: 'IN_PROGRESS',
  early_start: '2026-04-05',
  early_finish: '2026-04-10',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

async function setup(page: import('@playwright/test').Page) {
  const tasks = [SUMMARY_TASK, COMMITTED_TASK];
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    });
  });
}

test.describe('Board PDF export (issue 326)', () => {
  test('Export PDF produces a board-*.pdf download', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const toolbar = page.getByRole('toolbar', { name: 'Board toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'More board controls' }).click();
    const exportItem = page.getByRole('button', { name: 'Export the board as a PDF' });
    await expect(exportItem).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await exportItem.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^board-deck-export-project-\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  test('Export PDF is hidden at the mobile breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const toolbar = page.getByRole('toolbar', { name: 'Board toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // The More⋯ overflow still exists on mobile, but the deck-export action is
    // gated out below `sm`.
    await page.getByRole('button', { name: 'More board controls' }).click();
    await expect(page.getByRole('button', { name: 'Export the board as a PDF' })).toHaveCount(0);
  });
});

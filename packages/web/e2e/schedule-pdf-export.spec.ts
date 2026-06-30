/**
 * E2E for the Schedule "Export schedule as PDF" action (issue 1437, ADR-0188).
 *
 * Golden path: open the Project-actions ⋯ overflow on a desktop viewport, click
 * "Export schedule as PDF", and assert a `<Project>_Schedule_<date>.pdf` download
 * is produced by the client-side html-to-image + jsPDF pipeline rasterizing the
 * off-screen Layout-A print surface.
 * Mobile: the action is hidden below the `sm` breakpoint (a one-page Gantt deck
 * is a desktop task) — mirrors the board export (issue 326).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-schedpdf-0000-0000-0000-000000001437';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Gantt Export Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'task-a',
    wbs_path: '1',
    name: 'Design',
    early_start: '2026-04-05',
    early_finish: '2026-04-12',
    planned_start: '2026-04-05',
    duration: 6,
    percent_complete: 40,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'task-b',
    wbs_path: '2',
    name: 'Build',
    early_start: '2026-04-13',
    early_finish: '2026-04-24',
    planned_start: '2026-04-13',
    duration: 8,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 1,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'task-ms',
    wbs_path: '3',
    name: 'Launch',
    early_start: '2026-04-24',
    early_finish: '2026-04-24',
    planned_start: '2026-04-24',
    duration: 0,
    percent_complete: 0,
    is_critical: true,
    is_milestone: true,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 1,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

// task-b depends on task-a (FS, lag 0) — re-projected as the SVG connector path.
const FIXTURE_DEPENDENCY = {
  id: 'dep-1',
  predecessor: 'task-a',
  successor: 'task-b',
  dep_type: 'FS',
  lag: 0,
};

async function setup(page: import('@playwright/test').Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    dependencies: [FIXTURE_DEPENDENCY],
  });
  // The schedule reads its grid from GET /tasks/ — override the default-empty
  // route with the dated fixture so Layout A renders the Gantt, not the
  // no-activities empty state.
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    }),
  );
}

test.describe('Schedule PDF export (issue 1437)', () => {
  test('Export schedule as PDF produces a <Project>_Schedule_<date>.pdf download', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    await toolbar.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    const exportItem = menu.getByRole('menuitem', { name: 'Export schedule as PDF' });
    await expect(exportItem).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await exportItem.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^Gantt_Export_Project_Schedule_\d{4}-\d{2}-\d{2}\.pdf$/,
    );
  });

  test('Export schedule as PDF is hidden at the mobile breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // The Project-actions ⋯ overflow still exists on mobile (it holds the
    // collapsed analysis toggles), but the deck-export action is gated out
    // below `sm`.
    await toolbar.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Export schedule as PDF' })).toHaveCount(0);
  });
});

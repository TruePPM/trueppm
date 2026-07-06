/**
 * E2E for the Schedule export in-app surfaces (issue 1438, ADR-0233; builds on the
 * issue-1437 Layout-A pipeline).
 *
 * Golden path (lg): a dedicated "Export" toolbar button opens the options dialog;
 * clicking "Export PDF" runs the client-side html-to-image + jsPDF pipeline over
 * the off-screen Layout-A print surface and produces a `<Project>_Schedule_<date>.pdf`
 * download, then the dialog shows the success state.
 * Responsive: at md the button folds into the Project-actions ⋯ menu (opening the
 * same dialog); below sm export is hidden entirely (a deck export is a desk task).
 * Empty state: with no activities the Export button is disabled.
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

async function setup(
  page: import('@playwright/test').Page,
  tasks: typeof FIXTURE_TASKS = FIXTURE_TASKS,
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    dependencies: [FIXTURE_DEPENDENCY],
  });
  // The schedule reads its grid from GET /tasks/ — override the default-empty
  // route with the fixture so Layout A renders the Gantt (or the empty state).
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
}

test.describe('Schedule export surfaces (issue 1438)', () => {
  test('Export button opens the options dialog and produces a PDF download (lg)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // At lg the export is a dedicated, always-visible toolbar button.
    await toolbar.getByRole('button', { name: 'Export schedule as PDF' }).click();

    const dialog = page.getByRole('dialog', { name: 'Export schedule' });
    await expect(dialog).toBeVisible();
    // Layout B is present but disabled until #1439.
    await expect(dialog.getByRole('radio', { name: 'B — Report' })).toBeDisabled();
    // Paper picker is a segmented radiogroup.
    await expect(dialog.getByRole('radio', { name: 'Letter' })).toBeChecked();

    const downloadPromise = page.waitForEvent('download', { timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^Gantt_Export_Project_Schedule_\d{4}-\d{2}-\d{2}\.pdf$/,
    );

    // The generation state machine reaches success.
    await expect(dialog.getByRole('heading', { name: /PDF ready/ })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('Export folds into the Project-actions ⋯ menu at the md breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await setup(page);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // No standalone button at md — it lives in the overflow menu instead.
    await expect(toolbar.getByRole('button', { name: 'Export schedule as PDF' })).toHaveCount(0);

    await toolbar.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await menu.getByRole('menuitem', { name: 'Export schedule as PDF…' }).click();

    await expect(page.getByRole('dialog', { name: 'Export schedule' })).toBeVisible();
  });

  test('Export is hidden at the mobile breakpoint (sm)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await setup(page);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // No standalone button, and the ⋯ overflow (which still holds the collapsed
    // analysis toggles) carries no export entry below sm.
    await expect(toolbar.getByRole('button', { name: 'Export schedule as PDF' })).toHaveCount(0);
    await toolbar.getByRole('button', { name: 'Project actions' }).click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Export schedule as PDF/ })).toHaveCount(0);
  });

  test('Export button is disabled when the schedule is empty (lg)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, []);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    await expect(toolbar.getByRole('button', { name: 'Export schedule as PDF' })).toBeDisabled();
  });

  test('A wide (multi-year) schedule bands across sheets and still exports cleanly (lg)', async ({
    page,
  }) => {
    // An ~18-month timeline exceeds one page at a legible density, so the export
    // runs its week-snapped horizontal banding path (repeated label column +
    // "Sheet n of N") end to end. The artifact-hardening acceptance is that this
    // does not throw or hang — it produces a valid multi-sheet download (issue 1440).
    const WIDE_TASKS = [
      { ...FIXTURE_TASKS[0], early_start: '2026-01-05', early_finish: '2026-03-01', planned_start: '2026-01-05' },
      {
        ...FIXTURE_TASKS[1],
        id: 'task-wide-b',
        wbs_path: '2',
        early_start: '2026-08-01',
        early_finish: '2026-12-01',
        planned_start: '2026-08-01',
        predecessor_count: 0,
      },
      {
        ...FIXTURE_TASKS[2],
        id: 'task-wide-ms',
        wbs_path: '3',
        early_start: '2027-06-15',
        early_finish: '2027-06-15',
        planned_start: '2027-06-15',
        predecessor_count: 0,
      },
    ];
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, WIDE_TASKS);
    await page.goto(BASE_URL);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });
    await toolbar.getByRole('button', { name: 'Export schedule as PDF' }).click();

    const dialog = page.getByRole('dialog', { name: 'Export schedule' });
    await expect(dialog).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Export PDF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^Gantt_Export_Project_Schedule_\d{4}-\d{2}-\d{2}\.pdf$/,
    );
    await expect(dialog.getByRole('heading', { name: /PDF ready/ })).toBeVisible({
      timeout: 30_000,
    });
  });
});

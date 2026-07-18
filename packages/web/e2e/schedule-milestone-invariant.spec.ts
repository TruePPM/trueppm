/**
 * Schedule milestone invariant — !221 regression.
 *
 * Reproduces the failure mode VoC flagged on milestone "test": after a
 * successor was linked, the milestone row rendered Start=May 6 / Finish=May 25
 * — a 19-day span — even though milestones are zero-duration single points.
 * Sarah's hard-NO is "client-facing milestone with a date range"; this spec
 * locks the fix in so a regression at any layer (serializer, CPM, frontend
 * render) surfaces here.
 *
 * The fixture deliberately serves a milestone task with `early_start` and
 * `early_finish` set to *different* dates — simulating either legacy data or
 * a CPM bypass. The row must still render a single date (em-dash in Finish)
 * because the frontend invariant is the last line of defense before pixels.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-mile-00000000-0000-0000-0000-000000000221';

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Milestone Invariant Project',
    description: '',
    start_date: '2026-05-04',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'm-task-pre',
    wbs_path: '1',
    name: 'Phase 3',
    early_start: '2026-05-04',
    early_finish: '2026-05-21',
    duration: 14,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
  },
  {
    id: 'm-task-mile',
    wbs_path: '2',
    name: 'Phase Gate',
    // Bogus span: 19 calendar days. The frontend must NOT render this finish.
    early_start: '2026-05-06',
    early_finish: '2026-05-25',
    duration: 0,
    percent_complete: 0,
    is_critical: false,
    is_milestone: true,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
  },
];

async function gotoSchedule(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule milestone invariant — !221 regression', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('milestone row Finish column renders single date, not a span', async ({ page }) => {
    // Wait for the milestone row to render.
    const milestoneRow = page.locator('[data-row-id="m-task-mile"]');
    await expect(milestoneRow).toBeVisible();

    // The Finish column for a milestone uses the dedicated aria-label.
    const finishCell = milestoneRow.getByLabel(/milestone — single date in Start column/i);
    await expect(finishCell).toBeVisible();

    // Finish cell shows em-dash. The (bogus) finish date "May 25" must not appear.
    await expect(finishCell).toHaveText('—');

    // The milestone row itself must not include the bogus "May 25" anywhere.
    await expect(milestoneRow).not.toContainText('May 25');
  });
});

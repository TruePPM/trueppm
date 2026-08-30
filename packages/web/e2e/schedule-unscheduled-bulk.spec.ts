/**
 * The Unscheduled gutter's "Schedule N…" button, end to end (#2987).
 *
 * The bug this closes is structural, not cosmetic: the tray named the problem
 * with a count and had no route to the sheet that solves it, so a planner
 * concluded the only path was clicking each task. Each flow therefore ends on
 * what the gutter shows afterwards — a button that posts a correct batch and
 * leaves the tray full is a button that appears to do nothing.
 *
 * Reads and the batch write share one stateful store (`setupTaskStore`): the
 * sheet invalidates ['tasks', projectId] on success, so a stateless list mock
 * would re-serve the pre-edit fixture and the gutter count would drop and then
 * come back — the #2752 class of flake, which no timeout can fix.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore, type TaskStoreHandle } from './fixtures/task-store';

const PROJECT_ID = 'e2e-unsch-0000-0000-0000-000000002987';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;
const SPRINT_ID = 'sprint-2987';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Unscheduled Bulk Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(
  id: string,
  wbs: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    wbs_path: wbs,
    name,
    // Unscheduled by the `useUnscheduledTasks` predicate: no PM-committed start.
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...extra,
  };
}

/**
 * A phase with two undated children, one undated root row, and one row whose
 * dates belong to sprint planning.
 *
 * The sprint-targeted row is the point of the fixture: the tray counts it (it
 * *is* unscheduled) but must not offer to date it, so the header total and the
 * button's count deliberately disagree.
 */
const TASKS = [
  row('phase', '1', 'Mobilization', {
    is_summary: true,
    planned_start: '2026-04-01',
    early_start: '2026-04-01',
  }),
  row('t1', '1.1', 'Draft charter', { parent_id: 'phase' }),
  row('t2', '1.2', 'Stakeholder map', { parent_id: 'phase', status: 'BACKLOG' }),
  row('t3', '2', 'Vendor shortlist'),
  row('t4', '3', 'Team retro tooling', { status: 'BACKLOG', sprint: SPRINT_ID }),
];

async function setup(page: Page): Promise<TaskStoreHandle> {
  await setupAuth(page);
  await setupCatchAll(page);
  // No `tasks:` — setupTaskStore owns every /tasks/ read, and leaving the
  // stateless default registered too would put two sources of truth for the
  // same list one route-precedence change apart.
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID });
  return setupTaskStore(page, { tasks: TASKS });
}

/** The gutter region — every assertion below is scoped to it. */
function gutterOf(page: Page) {
  return page.getByRole('region', { name: 'Unscheduled tasks' });
}

test.describe('Unscheduled gutter — bulk schedule (#2987)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('offers to schedule only the rows whose dates the tray owns', async ({ page }) => {
    await page.goto(BASE_URL);
    const gutter = gutterOf(page);
    await expect(gutter).toBeVisible();

    // Four rows are unscheduled; the sprint-targeted one is not datable here.
    await expect(gutter.getByText('(4)')).toBeVisible();
    await expect(
      gutter.getByRole('button', { name: /^Schedule 3 unscheduled tasks/ }),
    ).toBeVisible();
  });

  test('the button opens the bulk sheet over exactly those rows', async ({ page }) => {
    await page.goto(BASE_URL);
    await gutterOf(page).getByRole('button', { name: /^Schedule 3/ }).click();

    const sheet = page.getByTestId('bulk-edit-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('3 items');
  });

  test('dating the selection empties the tray of everything it could act on', async ({ page }) => {
    await page.goto(BASE_URL);
    const gutter = gutterOf(page);
    await gutter.getByRole('button', { name: /^Schedule 3/ }).click();

    const sheet = page.getByTestId('bulk-edit-sheet');
    await sheet.getByTestId('bulk-planned-start-set').click();
    await sheet.getByTestId('bulk-planned-start-value').fill('2026-05-04');
    await expect(page.getByTestId('bulk-edit-apply')).toContainText('Apply to 3');
    await page.getByTestId('bulk-edit-apply').click();

    await expect(page.getByTestId('bulk-edit-result')).toBeVisible();
    await page.getByTestId('bulk-edit-done').click();

    // Only the sprint-targeted row is left — it was never in the batch, and the
    // count re-derives from the refetched list rather than local arithmetic.
    await expect(gutter.getByText('(1)')).toBeVisible();
    await expect(
      gutter.getByRole('button', { name: /^Schedule \d/ }),
    ).toHaveCount(0);
  });

  test('reaches rows hidden inside a collapsed phase', async ({ page }) => {
    await page.goto(BASE_URL);
    const gutter = gutterOf(page);
    await expect(gutter).toBeVisible();

    // Collapse the phase so its two undated children leave `visibleTasks` —
    // the selection the sheet resolves against. Without the bridge's ancestor
    // expansion the batch would silently shrink from 3 rows to 1.
    await page.getByRole('button', { name: /^Collapse Mobilization/ }).click();
    // Scope to the outline row, not the page: the tray renders a chip carrying
    // the same name, so an unscoped text locator never reaches zero.
    await expect(page.locator('[data-row-id="t1"]')).toHaveCount(0);

    await gutter.getByRole('button', { name: /^Schedule 3/ }).click();

    const sheet = page.getByTestId('bulk-edit-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('3 items');
  });
});

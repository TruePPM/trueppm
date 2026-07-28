/**
 * E2E for the "Recently deleted" task Trash (#2494, ADR-0689).
 *
 * Golden path: open the panel from the Schedule Project-actions (···) menu, see a
 * task deleted days ago (the recovery the Undo toast could not survive), restore it,
 * and watch it leave the list.
 * Also covered: the Board's ⋯ More entry point; the empty state (which must also say
 * what is NOT recoverable); and the non-restorable row, whose Restore is disabled
 * because the server said so.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-trash00-0000-0000-0000-000000002494';
const SCHEDULE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;
const BOARD_URL = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Recovery Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'task-live',
    wbs_path: '1',
    name: 'Still here',
    early_start: '2026-04-05',
    early_finish: '2026-04-12',
    planned_start: '2026-04-05',
    duration: 6,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 2,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

interface TrashRow {
  id: string;
  name: string;
  wbs_path: string;
  type: string;
  status: string;
  deleted_at: string | null;
  days_remaining: number | null;
  retention_days: number | null;
  subtree_count: number;
  can_restore: boolean;
}

function trashRow(over: Partial<TrashRow> = {}): TrashRow {
  return {
    id: 'task-gone',
    name: 'Pour foundation',
    wbs_path: '1.2',
    type: 'TASK',
    status: 'TODO',
    deleted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    days_remaining: 87,
    retention_days: 90,
    subtree_count: 0,
    can_restore: true,
    ...over,
  };
}

/**
 * Mock the project surface plus the trash list.
 *
 * `rowsByCall` is consumed one entry per GET, so a spec can model "restore removed
 * it" without a stateful server: the first read returns the tombstone, the read the
 * restore invalidation triggers returns an empty list. The trash route is registered
 * AFTER the catch-all `**\/api/v1/tasks/**` because Playwright resolves routes in
 * reverse registration order — registered first, it would never be reached.
 */
async function setup(
  page: import('@playwright/test').Page,
  rowsByCall: TrashRow[][],
): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    dependencies: [],
  });
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

  await page.route('**/api/v1/tasks/*/restore/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'task-gone', name: 'Pour foundation' }),
    }),
  );

  let call = 0;
  await page.route('**/api/v1/tasks/trash/*', async (route) => {
    const results = rowsByCall[Math.min(call, rowsByCall.length - 1)];
    call += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, truncated: false }),
    });
  });
}

async function openFromSchedule(page: import('@playwright/test').Page) {
  const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  await toolbar.getByRole('button', { name: 'Project actions' }).click();
  await page
    .getByRole('menu', { name: 'Project actions' })
    .getByRole('menuitem', { name: 'Recently deleted…' })
    .click();
  return page.getByRole('dialog', { name: 'Recently deleted' });
}

test.describe('Recently deleted tasks (#2494)', () => {
  test('restores a task deleted long after its Undo toast expired', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, [[trashRow()], []]);
    await page.goto(SCHEDULE_URL);

    const dialog = await openFromSchedule(page);
    await expect(dialog).toBeVisible();

    const row = dialog.getByText('Pour foundation');
    await expect(row).toBeVisible();
    await expect(dialog.getByText(/Deleted 3 days ago/)).toBeVisible();
    await expect(dialog.getByText(/auto-deletes in 87 days/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Restore' }).click();

    // The row leaves the list — the restore is the outcome, not the toast.
    await expect(dialog.getByText('Pour foundation')).toBeHidden();
    await expect(dialog.getByText('Nothing deleted recently')).toBeVisible();
  });

  test('is reachable from the Board overflow too', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, [[trashRow()]]);
    await page.goto(BOARD_URL);

    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByRole('button', { name: /Recently deleted tasks/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Recently deleted' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Pour foundation')).toBeVisible();
  });

  test('empty state also states what is not recoverable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, [[]]);
    await page.goto(SCHEDULE_URL);

    const dialog = await openFromSchedule(page);
    await expect(dialog.getByText('Nothing deleted recently')).toBeVisible();
    await expect(dialog.getByText(/labels, risks, baselines/)).toBeVisible();
  });

  test('Restore is disabled when the server says the caller may not restore', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setup(page, [[trashRow({ can_restore: false })]]);
    await page.goto(SCHEDULE_URL);

    const dialog = await openFromSchedule(page);
    await expect(dialog.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });
});

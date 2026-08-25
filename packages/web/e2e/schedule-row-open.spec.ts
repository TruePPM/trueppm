/**
 * A schedule row has an Open affordance, on BOTH surfaces (#2979).
 *
 * The original report was "task names are not clickable in Timeline mode". #2960
 * changed the facts underneath it: the Timeline now renders the same real-DOM
 * `TaskListPanel` the Grid does, so the accurate residue is narrower and wider at
 * once — **there was no Open affordance on a schedule row, on either surface.**
 *
 * The paths that existed before this:
 *  - double-click a canvas *bar* — Timeline only; the Grid has no bar;
 *  - `Enter` on a focused row — but only for a reader WITHOUT edit rights. For an
 *    editor in build mode `Enter` inserts a row.
 *
 * So an editor on the Grid had no way in at all, and nobody had a visible one.
 * The row menu was not the answer: it is gated on `authoring`, so it is empty for
 * exactly the readers who most need a way to open a task.
 *
 * This spec asserts the affordance on both surfaces and by both input methods.
 * `data-row-id` and the layout radiogroup are the same handles #2960's spec uses.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-open-0000-0000-0000-000000002979';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Row Open Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-16',
  planned_start: '2026-04-05',
  duration: 10,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  status: 'NOT_STARTED',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const TASKS = [
  { ...baseRow, id: 'r1', wbs_path: '1', name: 'Survey the site', parent_id: null },
  { ...baseRow, id: 'r2', wbs_path: '2', name: 'Pour the slab', parent_id: null },
];

const layout = (page: Page) => page.getByRole('radiogroup', { name: 'Schedule layout' });
const outline = (page: Page) => page.getByRole('treegrid', { name: 'Task list' });

/**
 * The drawer is a permanently mounted, translated-off `role="dialog"`, so an
 * unnamed locator is a strict-mode collision rather than a missing drawer — it
 * has to be located by its accessible name (same reason as schedule-links-cell).
 */
const drawer = (page: Page, taskName: string) =>
  page.getByRole('dialog', { name: new RegExp(taskName) }).first();

async function goto(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  await page.goto(BASE_URL);
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('Schedule row — the Open affordance (#2979)', () => {
  test.beforeEach(({ page }) => goto(page));

  test('the Grid row offers Open, and it opens that row’s drawer', async ({ page }) => {
    const row = page.locator('[data-row-id="r1"]');
    await row.hover();
    const open = row.getByTestId('row-open-task');
    await expect(open).toBeVisible();
    // Named for the row it belongs to — thirty icon-only buttons that all
    // announce as "button" would be no affordance at all.
    await expect(open).toHaveAccessibleName('Open Survey the site');

    await open.click();
    await expect(drawer(page, 'Survey the site')).toBeVisible();
  });

  test('the Timeline row offers the same Open — one row model, one affordance', async ({
    page,
  }) => {
    await layout(page).getByRole('radio', { name: 'Timeline' }).click();
    // The Timeline keeps the outline (#2960) with the {wbs, task} column set, so
    // the affordance rides the same row rather than being rebuilt for the canvas.
    await expect(outline(page)).toBeVisible();

    const row = page.locator('[data-row-id="r2"]');
    await row.hover();
    const open = row.getByTestId('row-open-task');
    await expect(open).toHaveAccessibleName('Open Pour the slab');

    await open.click();
    await expect(drawer(page, 'Pour the slab')).toBeVisible();
  });

  test('Alt+Enter on a focused row opens it without touching the mouse', async ({ page }) => {
    // `row.press` focuses the element first. A bare `page.keyboard.press` after
    // a click is not equivalent: a click inside the row can land on a cell, and
    // the binding lives on the row div that owns the roving tab stop.
    const row = page.locator('[data-row-id="r1"]');
    await row.press('Alt+Enter');
    await expect(drawer(page, 'Survey the site')).toBeVisible();
  });

  test('the cheatsheet names the binding, so it is findable rather than folklore', async ({
    page,
  }) => {
    await page.getByTestId('build-mode-pill').click();
    const sheet = page.getByRole('dialog', { name: 'Schedule shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Open the focused row’s details')).toBeVisible();
  });
});

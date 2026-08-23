/**
 * Right-click over the bar track (#2978, revised #2960).
 *
 * The outline owns the left of the surface on both layouts since #2960 and its
 * rows carry the full row menu. The bar track is still a canvas, so a
 * right-click there produced the browser's own "Save Image As…" menu with
 * nothing of the plan on offer.
 *
 * This class is invisible to vitest: jsdom has no layout and no hit-testing, so
 * the row-index arithmetic has unit tests and the *reachability* has this.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-tlmenu-00000000-0000-0000-0000-000000002978';

const PROJECTS = [
  { id: PROJECT_ID, name: 'Timeline Menu Project', description: '', start_date: '2026-04-01', calendar: 'default' },
];

function task(id: string, wbs: string, name: string) {
  return {
    id,
    wbs_path: wbs,
    name,
    parent_id: null,
    duration: 5,
    status: 'NOT_STARTED',
    percent_complete: 0,
    is_milestone: false,
    is_summary: false,
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    scheduled_start: '2026-04-06',
    is_critical: false,
    assignees: [],
    notes: '',
    server_version: 1,
    can_edit: true,
  };
}

const TASKS = [
  task('t-one', '1', 'Site access permits'),
  task('t-two', '2', 'Lay-down area survey'),
];

test.describe('Timeline right-click (#2978)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECT_ID,
      tasks: TASKS,
      statusSummary: { task_count: TASKS.length },
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('toolbar', { name: 'Schedule toolbar' })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('radio', { name: 'Timeline' }).click();
    await expect(page.getByTestId('schedule-canvas-scroll')).toBeVisible();
  });

  test('right-clicking a task row opens the row menu, not the browser image menu', async ({
    page,
  }) => {
    const canvas = page.getByTestId('schedule-canvas-scroll');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no box');

    // First row: just below the 28px ruler, half a 28px row down.
    await page.mouse.click(box.x + 200, box.y + 28 + 14, { button: 'right' });

    // The app's own menu — the same portal the outline row opens.
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Indent' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
    // The pointer drag's NAMED twin (web rules 311(d)/320) — the outline's row
    // menu has carried it since #2954, so a track menu without it would be the
    // divergence #2960 exists to close.
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeVisible();

    // The panel is a control now, so it has to be reachable, and `toBeVisible`
    // cannot say that — it is a box-and-opacity question, not a viewport one
    // (web rule 319(a)).
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.y).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
  });

  test('"Move to…" opens the destination picker the outline uses', async ({ page }) => {
    const canvas = page.getByTestId('schedule-canvas-scroll');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no box');
    await page.mouse.click(box.x + 200, box.y + 28 + 14, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    // The same dialog the row menu's twin opens — one implementation of the
    // move, reached from either place.
    await expect(page.getByRole('dialog', { name: /Move/i })).toBeVisible();
  });

  test('right-clicking the ruler leaves the browser menu alone', async ({ page }) => {
    // Nothing of ours to offer above the first row, so preventDefault would only
    // take the native menu away and give nothing back.
    const canvas = page.getByTestId('schedule-canvas-scroll');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no box');

    await page.mouse.click(box.x + 200, box.y + 6, { button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('right-clicking below the last row opens nothing', async ({ page }) => {
    const canvas = page.getByTestId('schedule-canvas-scroll');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no box');

    // Two tasks — well past them.
    await page.mouse.click(box.x + 200, box.y + 28 + 28 * 8, { button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

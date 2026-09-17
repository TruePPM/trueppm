import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * Calendar Week view mode (issue #3167).
 *
 * The Month|Week toggle used to be inert: `calView` reached the URL but never
 * reached CalendarGrid, so Week re-rendered the identical month grid. These
 * specs pin the three things that make Week a real view — it renders one week,
 * it heads with the week's date range, and it drops the 4-lane cap that hides
 * most of a busy week behind an unexpandable "+N more".
 */

const PROJECT_ID = 'e2e-calwk-0000-0000-0000-000000003167';
// 2026-03-11 is a Wednesday → the Mar 9–15 week, inside March.
const ANCHOR = '2026-03-11';
const url = (view: string) =>
  `/projects/${PROJECT_ID}/calendar?calAnchor=${ANCHOR}&calView=${view}`;

const taskRow = (i: number, start: string, finish: string) => ({
  id: `cw-task-${i}`,
  wbs_path: `1.${i}`,
  name: `Week Task ${i}`,
  early_start: start,
  early_finish: finish,
  planned_start: start,
  duration: 3,
  percent_complete: 0,
  is_critical: false,
  status: 'NOT_STARTED',
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  assignments: [],
});

// Eight tasks all overlapping Mar 9–15 — double the month-mode 4-lane cap, so
// month hides four of them and week must show all eight.
const OVERLAPPING = Array.from({ length: 8 }, (_, i) => taskRow(i, '2026-03-09', '2026-03-13'));
// One task inside March but outside the Mar 9–15 week — the month/week discriminator.
const OUT_OF_WEEK = {
  ...taskRow(99, '2026-03-23', '2026-03-25'),
  id: 'cw-task-outside',
  name: 'Later In March',
};

test.describe('Calendar week view (#3167)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Week View Project', start_date: '2026-03-01' }],
      tasks: [...OVERLAPPING, OUT_OF_WEEK],
    });
  });

  test('golden path: Week renders one week, its date range, and every overlapping task', async ({
    page,
  }) => {
    await page.goto(url('week'));
    // Gate on the window heading — it states the week, and it only resolves once
    // the calendar's reads have landed. The grid landmark is deliberately named
    // just "Calendar" (a stable identity, not a state readout), so it mounts
    // before the data and cannot serve as the gate.
    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('region', { name: 'Calendar' })).toBeVisible();

    // All eight overlapping tasks are present — the lane cap is gone.
    for (let i = 0; i < 8; i++) {
      await expect(
        page.getByRole('button', { name: new RegExp(`^Week Task ${i},`) }),
      ).toBeVisible();
    }
    // ...and nothing is hidden behind an inert overflow label.
    await expect(page.getByText(/more$/)).toHaveCount(0);

    // A task elsewhere in the same month is outside the week window.
    await expect(page.getByRole('button', { name: /Later In March/ })).toHaveCount(0);
  });

  test('Month still caps at four lanes — the cap is lifted for week only', async ({ page }) => {
    await page.goto(url('month'));
    await expect(page.getByRole('heading', { level: 2, name: 'March 2026' })).toBeVisible({
      timeout: 10_000,
    });
    // 8 overlapping tasks, 4 lanes → 4 hidden.
    await expect(page.getByText('+4 more')).toBeVisible();
    // The out-of-week task IS visible in month mode.
    await expect(page.getByRole('button', { name: /Later In March/ })).toBeVisible();
  });

  test('toggling Month → Week swaps the view and the heading', async ({ page }) => {
    await page.goto(url('month'));
    await expect(page.getByRole('heading', { level: 2, name: 'March 2026' })).toBeVisible({
      timeout: 10_000,
    });

    await page
      .getByRole('group', { name: 'Calendar view mode' })
      .getByRole('button', { name: 'week' })
      .click();

    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible();
    await expect(page.getByText('+4 more')).toHaveCount(0);
  });

  test('the date grid is an ARIA grid, and its day-cell count states the mode (#3241)', async ({
    page,
  }) => {
    // The structural assertion the #3167 class could not be written with: "how
    // many days did this render", rather than "is some fixture task that falls
    // outside the week absent". Before #3241 the day cells were bare <div>s
    // with no role, no accessible name and no test hook of any kind.
    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible({
      timeout: 10_000,
    });

    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid.getByRole('gridcell')).toHaveCount(7);
    // Each cell says which day it is — "Foundation Pour, due" never did.
    await expect(grid.getByRole('gridcell', { name: 'Wednesday, March 11, 2026' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Calendar legend' })).toBeVisible();

    await page.goto(url('month'));
    await expect(page.getByRole('heading', { level: 2, name: 'March 2026' })).toBeVisible({
      timeout: 10_000,
    });
    // A month is 4-6 whole weeks; March 2026 starts on a Sunday and so needs
    // all six rows (Feb 23 – Apr 5).
    await expect(
      page.getByRole('grid', { name: 'Calendar dates' }).getByRole('gridcell'),
    ).toHaveCount(42);
  });

  test('arrow keys traverse the day cells (#3241)', async ({ page }) => {
    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    const cell = (name: string) => grid.getByRole('gridcell', { name });

    // Saturday is the first day the fixture's Mar 9-13 chips do not cover, so
    // a real pointer click lands on the cell rather than on a chip.
    await cell('Saturday, March 14, 2026').click();
    await expect(cell('Saturday, March 14, 2026')).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(cell('Sunday, March 15, 2026')).toBeFocused();

    // Clamped at the row's end — the grid does not own the anchor, so it never
    // steps the window out from under the focused cell.
    await page.keyboard.press('ArrowRight');
    await expect(cell('Sunday, March 15, 2026')).toBeFocused();

    await page.keyboard.press('Home');
    await expect(cell('Monday, March 9, 2026')).toBeFocused();
  });

  test('empty state: a week with no tasks says so instead of rendering a blank row', async ({
    page,
  }) => {
    // Anchor a week that no fixture task touches, while the project still has
    // tasks — so this is the empty-window path, not the empty-project path.
    await page.goto(`/projects/${PROJECT_ID}/calendar?calAnchor=2026-06-10&calView=week`);
    await expect(page.getByRole('heading', { level: 2, name: 'Jun 8 – 14, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('No tasks in the week of Jun 8 – 14, 2026.')).toBeVisible();
  });
});

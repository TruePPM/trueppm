/**
 * Shell v2 Schedule toolbar, legend and forecast strip (#4796), behind `shell_v2`.
 *
 * The ladder is MEASURED (rule 343), so the only honest assertions are
 * Playwright's: every child's right edge inside the bar's, at 1440, 1024 and
 * 768 (below 768 the phone schedule renders and the bar is absent), and the concessions monotonic as the bar narrows.
 * `toBeVisible()` alone is not the assertion — a clipped child of an
 * `overflow-hidden` parent still has a box (#2974).
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-v2-00000000-0000-0000-0000-000000004796';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Atlas Platform Launch',
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
  status: 'NOT_STARTED',
  assignees: [],
  total_float: 12,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const TASKS = [
  { ...baseRow, id: 'ph', wbs_path: '1', name: 'Assess', is_summary: true, parent_id: null },
  {
    ...baseRow,
    id: 'c1',
    wbs_path: '1.1',
    name: 'Inventory legacy schemas',
    is_summary: false,
    parent_id: 'ph',
    total_float: 2,
  },
  {
    ...baseRow,
    id: 'c2',
    wbs_path: '1.2',
    name: 'Profile data quality',
    is_summary: false,
    parent_id: 'ph',
    is_critical: true,
    total_float: 0,
  },
  {
    ...baseRow,
    id: 'r2',
    wbs_path: '2',
    name: 'Migration tooling',
    is_summary: false,
    parent_id: null,
  },
];

/**
 * A real forecast, so the docked strip has something to render: without it
 * `ScheduleForecastBar` shows its empty state and never the Details button,
 * and "no strip under v2" would pass against a strip that is still there.
 */
const MC_RESULT = {
  project_id: PROJECT_ID,
  runs: 500,
  p50: '2026-04-20',
  p80: '2026-04-28',
  p95: '2026-05-06',
  histogram_buckets: [
    { date: '2026-04-13', count: 120 },
    { date: '2026-04-20', count: 250 },
    { date: '2026-04-27', count: 130 },
  ],
  last_run_at: '2026-04-02T10:00:00Z',
  forecast_staleness: 'current',
  plan_version: 7,
  plan_version_current: 7,
  cpm_finish: '2026-04-16',
  delta_vs_cpm: { p50: 4, p80: 12, p95: 20 },
  confidence_curve: [
    { date: '2026-04-13', pct: 24 },
    { date: '2026-04-20', pct: 74 },
    { date: '2026-04-27', pct: 100 },
  ],
  sensitivity: [],
};

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Schedule toolbar' });
const outline = (page: Page) => page.getByRole('treegrid', { name: 'Item list' });

const BASELINE = {
  id: 'b1',
  project: PROJECT_ID,
  name: 'Baseline 1',
  created_by: null,
  created_at: '2026-04-01T10:00:00Z',
  is_active: true,
  has_cpm_dates: true,
  task_count: 1,
};

async function goto(
  page: Page,
  {
    v2 = true,
    baseline = false,
    failTasks = false,
  }: { v2?: boolean; baseline?: boolean; failTasks?: boolean } = {},
) {
  await page.addInitScript((on: boolean) => {
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: on }));
  }, v2);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  // Registered last so it wins over the default list mock: the reads echo writes.
  await setupTaskStore(page, { tasks: TASKS });
  if (baseline) {
    // An active baseline makes the Baseline toggle (and the legend's Baseline
    // entry) exist, so the ladder is measured with its widest inventory.
    await page.route('**/api/v1/projects/*/baselines/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [BASELINE] }),
      }),
    );
    await page.route('**/api/v1/projects/*/baselines/b1/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...BASELINE,
          tasks: [
            {
              task_id: 'c1',
              task_name: 'Inventory legacy schemas',
              start: '2026-04-03',
              finish: '2026-04-07',
              duration: 5,
              actual_start: null,
              actual_finish: null,
            },
          ],
        }),
      }),
    );
  }
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MC_RESULT),
    }),
  );
  if (failTasks) {
    // Registered after the store so the read fails: the page must say what it lost.
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }),
    );
  }
  await page.goto(BASE_URL);
}

/** Children whose right edge escapes the bar, or -1 until the v2 bar has fitted. */
async function clipped(page: Page): Promise<string[] | null> {
  const bar = page.getByTestId('schedule-toolbar-v2');
  if ((await bar.count()) === 0) return null;
  return bar.evaluate((el) => {
    if (el.getAttribute('data-fit-step') === null || el.children.length === 0) return null;
    const right = el.getBoundingClientRect().right;
    return Array.from(el.children)
      .filter((c) => {
        const r = c.getBoundingClientRect();
        return !(r.width === 0 && r.height === 0) && r.right > right + 1;
      })
      .map((c) => (c.textContent ?? '').trim().slice(0, 30) || c.tagName);
  });
}

/**
 * Narrows the bar's own box (as a docked rail or detail panel would) so the
 * demotion rungs are reachable at a desktop viewport, where the phone layout
 * (below 768) replaces the bar and no viewport width demotes this fixture.
 */
const narrowBar = (page: Page, px: number) =>
  page.getByTestId('schedule-toolbar-v2').evaluate((el, w) => {
    (el as HTMLElement).style.maxWidth = `${w}px`;
  }, px);

const step = async (page: Page) =>
  Number(await page.getByTestId('schedule-toolbar-v2').getAttribute('data-fit-step'));

test.describe('shell v2 Schedule toolbar (#4796)', () => {
  test('golden path at 1440: primary controls, persistent legend, no forecast strip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    await expect(outline(page)).toBeVisible({ timeout: 10_000 });
    const bar = toolbar(page);
    await expect(bar).toHaveAttribute('data-testid', 'schedule-toolbar-v2');
    await expect(bar.getByRole('button', { name: 'Filter' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /Add task/ })).toBeVisible();
    await expect(
      bar.getByRole('button', { name: /^More schedule actions, \d+ items?$/ }),
    ).toBeVisible();

    const legend = page.getByRole('list', { name: 'Schedule legend' });
    await expect(legend).toBeVisible();
    for (const word of ['Critical', 'Near-critical', 'Today']) {
      await expect(legend.getByText(word, { exact: true })).toBeVisible();
    }
    // v1's "Legend" show/hide toggle does not exist: the legend never folds.
    await expect(page.getByRole('button', { name: /^Legend/ })).toHaveCount(0);
    // The docked Monte Carlo strip is gone even with a forecast to show (the
    // flag-off test below proves this mock renders it); the header's P80 stamp
    // is the forecast.
    await expect(page.getByTestId('mc-details-btn')).toHaveCount(0);

    await expect.poll(() => clipped(page)).toEqual([]);
  });

  test('ladder is measured and monotonic across 1440 / 1024 / 768, with an active baseline', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { baseline: true });
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    let previous = -1;
    for (const width of [1440, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => clipped(page), { message: `nothing clips at ${width}` }).toEqual([]);
      const s = await step(page);
      expect(s, `ladder only concedes as the bar narrows (${width})`).toBeGreaterThanOrEqual(
        previous,
      );
      previous = s;
      // Primary controls never fold.
      await expect(toolbar(page).getByRole('button', { name: 'Filter' })).toBeVisible();
      await expect(toolbar(page).getByRole('button', { name: /Add task/ })).toBeVisible();
      // A demoted command appears in exactly one place: the overflow, counted in its name.
      const inBar = await toolbar(page).getByRole('button', { name: 'Critical only' }).count();
      const trigger = toolbar(page).getByRole('button', { name: /^More schedule actions/ });
      await trigger.click();
      const inMenu = await page.getByRole('menuitemcheckbox', { name: 'Critical only' }).count();
      expect(inBar + inMenu, `Critical only is in one place at ${width}`).toBe(1);
      const name = (await trigger.getAttribute('aria-label')) ?? '';
      expect(name).toBe(
        `More schedule actions, ${5 + (inMenu ? 1 : 0) + (await demotedOthers(page))} items`,
      );
      // Whatever the bar has conceded, the legend never reaches the overflow
      // (checked while the menu is open): it stays in the bar or relocates to
      // the timeline header, and is visible in one of them.
      await expect(page.getByRole('menuitem', { name: /legend/i })).toHaveCount(0);
      await expect(page.getByRole('list', { name: 'Schedule legend' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  });

  test('on a phone the v2 toolbar is absent and the phone schedule still renders', async ({
    page,
  }) => {
    // MobileSchedule ignores every toolbar control, as v1's toolbar knows
    // (it renders nothing on a phone), so a v2 bar here would be inert.
    await page.setViewportSize({ width: 390, height: 900 });
    await goto(page);
    await expect(page.getByTestId('schedule-toolbar-v2')).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: 'Schedule toolbar' })).toHaveCount(0);
    await expect(page.getByText('Inventory legacy schemas')).toBeVisible({ timeout: 10_000 });
  });

  test('demoting the focused control moves focus to More and says where it went', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { baseline: true });
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    const today = toolbar(page).getByRole('button', { name: 'Today', exact: true });
    await expect(today).toBeVisible();
    await today.focus();
    await narrowBar(page, 340);
    await expect(toolbar(page).getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
    await expect(
      toolbar(page).getByRole('button', { name: /^More schedule actions/ }),
    ).toBeFocused();
    await expect(page.getByTestId('v2-demotion-live')).toHaveText('Today moved to More');
  });

  test('menus are hittable: a real pointer click on a demoted Critical only turns the filter on', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await goto(page, { baseline: true });
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    await narrowBar(page, 460);
    await expect.poll(() => clipped(page)).toEqual([]);
    await expect(toolbar(page).getByRole('button', { name: 'Critical only' })).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]crit=1/);

    await toolbar(page)
      .getByRole('button', { name: /^More schedule actions/ })
      .click();
    const item = page.getByRole('menuitemcheckbox', { name: 'Critical only' });
    // The point a pointer would land on is the item itself, not the bar above
    // it or the canvas below — the clip that #4796's audit found.
    expect(
      await item.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit !== null && el.contains(hit);
      }),
    ).toBe(true);
    await item.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    // The filter took effect: its state is in the URL (the page's filter
    // persistence), and the menu now reports it checked.
    await expect(page).toHaveURL(/[?&]crit=1/);
    await toolbar(page)
      .getByRole('button', { name: /^More schedule actions/ })
      .click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Critical only' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('menus are hittable: a real pointer click on a Filter item applies it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    await expect(outline(page)).toBeVisible({ timeout: 10_000 });
    await toolbar(page).getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Milestones only' }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(toolbar(page).getByRole('button', { name: 'Filter, 1 active' })).toBeVisible();
    // No row in this plan is a milestone.
    await expect(outline(page).getByText('Migration tooling')).toHaveCount(0);
  });

  test('every bar control has a 44x44 hit target without growing past 32px (rules 5, 330)', async ({
    page,
  }) => {
    const measure = async (label: string) => {
      await expect.poll(() => clipped(page)).toEqual([]);
      const controls = toolbar(page).locator('[data-testid^="schedule-v2-"]');
      const n = await controls.count();
      expect(n).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < n; i++) {
        const m = await controls.nth(i).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const before = getComputedStyle(el, '::before');
          // A point 5px above the visible button, inside the cushion.
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top - 5);
          return {
            id: el.getAttribute('data-testid'),
            visualHeight: r.height,
            hitW: Number.parseFloat(before.width),
            hitH: Number.parseFloat(before.height),
            cushionHits: hit !== null && el.contains(hit),
          };
        });
        expect(m.visualHeight, `${m.id} @${label}`).toBe(32);
        expect(m.hitH, `${m.id} @${label}`).toBeGreaterThanOrEqual(44);
        expect(m.hitW, `${m.id} @${label}`).toBeGreaterThanOrEqual(44);
        expect(m.cushionHits, `${m.id} @${label}`).toBe(true);
      }
    };
    for (const width of [1440, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await goto(page);
      await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
      await measure(`${width}`);
    }
    // No viewport >= 768 collapses anything with this fixture, so reach the
    // collapsed Zoom trigger and icon-only Add task by narrowing the bar.
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    for (const px of [460, 340]) {
      await narrowBar(page, px);
      await expect.poll(() => step(page)).toBeGreaterThan(0);
      await measure(`bar ${px}px`);
    }
  });

  test('keyboard: one tab stop, roving arrows, overflow operable', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    const bar = toolbar(page);
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar.locator('[tabindex="0"]')).toHaveCount(1);
    await bar.getByRole('button', { name: 'Filter' }).focus();
    await page.keyboard.press('End');
    const trigger = bar.getByRole('button', { name: /^More schedule actions/ });
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Home');
    await expect(bar.getByRole('button', { name: 'Filter' })).toBeFocused();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`toolbar and legend are axe clean (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1440, height: 900 });
      await goto(page);
      await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
      await toolbar(page)
        .getByRole('button', { name: /^More schedule actions/ })
        .click();
      await expect(page.getByRole('menu')).toBeVisible();
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .include('[data-testid="schedule-toolbar-v2"]')
        .include('[role="menu"]')
        .analyze();
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test('flag off: v1 toolbar unchanged, no v2 surface', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { v2: false });
    await expect(toolbar(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('schedule-toolbar-v2')).toHaveCount(0);
    await expect(page.getByTestId('schedule-legend-v2')).toHaveCount(0);
    // The same forecast mock renders v1's docked strip: the v2 absence above is
    // not an empty state.
    await expect(page.getByTestId('mc-details-btn')).toBeVisible({ timeout: 10_000 });
  });
  test('Total float prints ▲ for critical rows under v2 and stays bare on v1 (#5106)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page);
    const critical = outline(page).getByRole('row', { name: /Profile data quality/ });
    await expect(critical.getByRole('gridcell', { name: /Total float: 0 working day/ })).toHaveText(
      '\u25B2 0d',
    );
  });

  test('v1 Total float stays a bare number (#5106)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { v2: false });
    const critical = outline(page).getByRole('row', { name: /Profile data quality/ });
    await expect(critical.getByRole('gridcell', { name: /Total float: 0 working day/ })).toHaveText(
      '0d',
    );
  });

  test('a failed load says the schedule could not be computed, with retry and a support code (#5106)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await goto(page, { failTasks: true });
    await expect(page.getByText("The schedule couldn't be computed.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('alert').getByRole('button', { name: /retry/i })).toBeVisible();
    await expect(page.getByText('SCHEDULE-LOAD')).toBeVisible();
  });
});

/** Today (menuitem) and Baseline (menuitemcheckbox) rows demoted alongside Critical only; each counts 0 while it is still inline in the bar. */
async function demotedOthers(page: Page): Promise<number> {
  return (
    (await page.getByRole('menuitem', { name: 'Today', exact: true }).count()) +
    (await page.getByRole('menuitemcheckbox', { name: 'Baseline', exact: true }).count())
  );
}

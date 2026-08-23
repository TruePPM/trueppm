import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Schedule "Display" menu — WBS/Owner column toggles + the Chart section
 * (dependency lines, on-bar task-name placement, progress pills) — #2097, with
 * per-view task-name placement — #2107.
 *
 * The Chart toggles persist to localStorage (`trueppm.schedule.chartDisplay.v1`),
 * distinct from the data filters mirrored to the URL, and hiding a chart element
 * lights the trigger's active-count badge. Task-name placement is tracked
 * independently for Grid vs Timeline (`taskNamePlacementByView`): Grid omits the
 * Timeline-only "Aligned left" option, and switching a view's placement leaves
 * the other view untouched.
 */
// The Display trigger is located THROUGH the toolbar, not by name alone.
// `name` matching is substring by default, and the coach bar's dismiss control
// says "bring it back from Display options" (#2959), so a bare 'Display' now
// resolves to two buttons. `exact: true` is not the fix either — the trigger's
// own accessible name becomes "Display, 1 active filter" once a filter is on.
// Scoping to the toolbar is stable under both.

/**
 * Shape of the persisted `trueppm.schedule.chartDisplay.v1` blob, as far as the
 * assertions below read it. `JSON.parse` returns `any`, and these reads happen
 * inside `page.evaluate`, so without a shape here the `any` would become the
 * inferred return type of every one of those callbacks.
 */
interface ChartDisplayStore {
  dependencyLinesVisible?: boolean;
  taskNamePlacementByView?: { grid?: string; timeline?: string };
}

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
    status: 'IN_PROGRESS',
    is_summary: false,
    parent_id: null,
  },
  {
    id: 't2',
    wbs_path: '1.1',
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 100,
    is_critical: false,
    is_milestone: false,
    status: 'COMPLETE',
    is_summary: false,
    parent_id: null,
  },
];

async function gotoSchedule(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_PROJECTS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_PROJECTS,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        name: 'Alpha Platform Upgrade',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'HYBRID',
        code: '',
        health: 'AUTO',
        visibility: 'WORKSPACE',
        timezone: '',
        default_view: 'SCHEDULE',
        lead: null,
        lead_detail: null,
        iteration_label: 'Sprint',
        is_archived: false,
        archived_at: null,
        archived_by: null,
        recalculated_at: null,
        is_sample: false,
        program_detail: null,
        server_version: 1,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_TASKS,
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }),
    }),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

test.describe('Schedule Display menu — columns + Chart section (#2097)', () => {
  test.beforeEach(async ({ page }) => {
    // Wide viewport so the "Display" trigger shows its label and the Grid task
    // list renders (Columns section only appears in Grid mode).
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoSchedule(page);
    await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('exposes WBS + Owner column toggles and the Grid-scoped Chart section', async ({ page }) => {
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu).toBeVisible();

    // WBS + Owner columns are now toggleable (previously missing).
    await expect(menu.getByRole('menuitemcheckbox', { name: 'WBS' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Owner' })).toBeVisible();

    // Chart section: dep lines + progress checkboxes, task-name radio group.
    await expect(menu.getByText('Chart')).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Dependency lines' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Progress %' })).toBeVisible();

    // The sub-label is scoped to the active view and offers Next-to-bar +
    // Hidden. "Aligned left" drew a canvas-owned name column that existed only
    // because Timeline hid the outline; #2960 renders the outline on both
    // surfaces, so the option is retired everywhere.
    await expect(menu.getByText('Task names (Grid)')).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Next to bar' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Hidden' })).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Aligned left' })).toHaveCount(0);
  });

  test('hiding dependency lines persists to localStorage and lights the badge', async ({
    page,
  }) => {
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await menu.getByRole('menuitemcheckbox', { name: 'Dependency lines' }).click();

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('trueppm.schedule.chartDisplay.v1');
          const stored = raw ? (JSON.parse(raw) as ChartDisplayStore) : null;
          return stored?.dependencyLinesVisible ?? null;
        }),
      )
      .toBe(false);

    // The trigger now advertises one active/hidden element in its accessible name.
    await expect(page.getByRole('button', { name: /Display, 1 active/i })).toBeVisible();
  });

  test('the Timeline offers the SAME two placements as the Grid (#2960)', async ({ page }) => {
    await page.getByRole('radio', { name: 'Timeline' }).click();

    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu.getByText('Task names (Timeline)')).toBeVisible();
    // "Aligned left" is gone from the surface it was invented for: the outline
    // renders here now, so a canvas-drawn name column would sit beside the real
    // one. Its removal is what makes "a gate's name is not repeated in the
    // track" true rather than aspirational.
    await expect(menu.getByRole('menuitemradio', { name: 'Aligned left' })).toHaveCount(0);

    const next = menu.getByRole('menuitemradio', { name: 'Next to bar' });
    await next.click();
    await expect(next).toHaveAttribute('aria-checked', 'true');

    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('trueppm.schedule.chartDisplay.v1');
          const stored = raw ? (JSON.parse(raw) as ChartDisplayStore) : null;
          return stored?.taskNamePlacementByView?.timeline ?? null;
        }),
      )
      .toBe('next');
  });

  test('the Columns section narrows with the surface (#2960)', async ({ page }) => {
    const openMenu = async () => {
      await page
        .getByRole('toolbar', { name: 'Schedule toolbar' })
        .getByRole('button', { name: 'Display' })
        .click();
      return page.getByRole('menu', { name: 'Display options' });
    };

    // Grid draws all seven columns, so all six toggleable ones are offered.
    let menu = await openMenu();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Start' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Owner' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Timeline draws WBS + Task only, so it offers exactly the one toggle that
    // does something — the rest are ABSENT, not present-and-inert (rule 302).
    await page.getByRole('radio', { name: 'Timeline' }).click();
    menu = await openMenu();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'WBS' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Start' })).toHaveCount(0);
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Finish' })).toHaveCount(0);
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Owner' })).toHaveCount(0);
  });

  test('Grid and Timeline placements are independent and survive navigation (#2107)', async ({
    page,
  }) => {
    // Set Grid → "Next to bar" (Grid defaults to Hidden).
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    let menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu.getByText('Task names (Grid)')).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Next to bar' }).click();
    await page.keyboard.press('Escape');

    // Switch to Timeline and set a *different* placement — "Hidden".
    await page.getByRole('radio', { name: 'Timeline' }).click();
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu.getByText('Task names (Timeline)')).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Hidden' }).click();

    // Each view kept its own choice — the two do not clobber each other.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = localStorage.getItem('trueppm.schedule.chartDisplay.v1');
          const stored = raw ? (JSON.parse(raw) as ChartDisplayStore) : null;
          return stored?.taskNamePlacementByView ?? null;
        }),
      )
      .toEqual({ grid: 'next', timeline: 'hidden' });

    // Reload — a full page teardown proves the per-view preferences persist
    // (they "save when you go back"). The view mode is also persisted, so the
    // schedule reopens in Timeline.
    await page.reload();
    await expect(
      page
        .getByRole('toolbar', { name: 'Schedule toolbar' })
        .getByRole('button', { name: 'Display' }),
    ).toBeVisible({ timeout: 10_000 });

    // Still in Timeline: "Hidden" is the restored selection.
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu.getByText('Task names (Timeline)')).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Hidden' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');

    // Switch back to Grid: its independent "Next to bar" choice is intact.
    await page.getByRole('radio', { name: 'Grid' }).click();
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu.getByText('Task names (Grid)')).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Next to bar' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

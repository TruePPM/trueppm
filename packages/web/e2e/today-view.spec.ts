import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Unified "Today" split view (issue 412, ADR-0180).
 *
 * The dual-hat PM + Scrum-Master home the `unified` role-context lens lands on:
 * a read-only SchedulePulse strip (schedule health + the active sprint's live
 * progress) above the embedded sprint board. These specs assert the strip renders
 * its schedule signal and the active-sprint rollup chip, and that the board is
 * embedded below — plus the no-active-sprint empty state.
 */

const PROJECT_ID = 'e2e-today-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Apollo Platform',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

function unifiedUser(): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: [],
    role_context: 'unified',
  };
}

const ATRISK_OVERVIEW = {
  schedule_health: 'at_risk' as const,
  spi: 0.92,
  tasks_late_count: 2,
  critical_task_count: 5,
  total_tasks: 20,
  complete_tasks: 5,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-07-01', percent_complete: 40 },
};

type Methodology = 'WATERFALL' | 'AGILE' | 'HYBRID';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function paginated(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

async function base(
  page: Page,
  opts: { overview?: typeof ATRISK_OVERVIEW; tasks?: unknown[]; methodology?: Methodology } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  // The project-detail mock returns the fixture verbatim, so stamping
  // effective_methodology drives the strip's methodology-aware halves (issue 1338).
  const projects = opts.methodology
    ? [{ ...FIXTURE_PROJECTS[0], effective_methodology: opts.methodology }]
    : FIXTURE_PROJECTS;
  await setupApiMocks(page, {
    projects,
    projectId: PROJECT_ID,
    user: unifiedUser(),
    overview: opts.overview,
    tasks: opts.tasks,
  });
}

/** Register an ACTIVE sprint (overrides the fixtures' empty default — must come after base()). */
async function routeActiveSprint(page: Page) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill(
      json(
        paginated([
          {
            id: 'sp-1',
            short_id: 'A1',
            short_id_display: 'SP-A1',
            name: 'Sprint 14',
            goal: 'Checkout polish',
            start_date: '2026-06-15',
            finish_date: '2026-06-26',
            state: 'ACTIVE',
            committed_points: 13,
            completed_points: null,
          },
        ]),
      ),
    ),
  );
}

/**
 * The reads the embedded board makes beyond the shared fixture (overview, tasks,
 * dependencies, board-config, board-views, flow-metrics, sprint-forecast), each with
 * its real shape so nothing on the page leans on the catch-all.
 */
async function mockBoardReads(page: Page) {
  await page.route('**/api/v1/sprints/sp-1/burndown/', (route) =>
    route.fulfill(json({ sprint: { id: 'sp-1', name: 'Sprint 14' }, snapshots: [] })),
  );
  await page.route('**/api/v1/sprints/sp-1/scope-changes/', (route) =>
    route.fulfill(
      json({
        summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
        events: [],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill(
      json({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
        team_velocity_per_day: null,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/forecast/`, (route) =>
    route.fulfill(
      json({
        velocity: {
          sprints: [],
          rolling_avg_points: null,
          rolling_stdev_points: null,
          forecast_range_low: null,
          forecast_range_high: null,
          rolling_avg_tasks: null,
          rolling_stdev_tasks: null,
          team_velocity_per_day: null,
        },
        remaining_committed_points: 0,
        sprints_to_complete_low: null,
        sprints_to_complete_high: null,
        milestones: [],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/fields/`, (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (route) =>
    route.fulfill(json(paginated([]))),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) =>
    route.fulfill(json({ ok: true })),
  );
  await page.route('**/api/v1/me/timer/', (route) => route.fulfill(json({ active: false })));
  await page.route('**/api/v1/me/work/', (route) =>
    route.fulfill(
      json({
        ...paginated([]),
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    ),
  );
  await page.route('**/api/v1/programs/', (route) => route.fulfill(json(paginated([]))));
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill(json({ id: 'w1', name: 'E2E', public_sharing_enabled: false })),
  );
}

test.describe('Unified Today view (ADR-0180)', () => {
  test('golden path — renders the schedule strip + active-sprint rollup above the board', async ({
    page,
  }) => {
    // Two tasks committed to the active sprint, one COMPLETE → derived 50%.
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'IN_PROGRESS', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks });
    await routeActiveSprint(page);

    await page.goto(`/projects/${PROJECT_ID}/today`);

    // Gate on the page-rendered signal before asserting chrome (the strip).
    const pulse = page.getByTestId('schedule-pulse');
    await expect(pulse).toBeVisible();
    // Schedule health band carries its text label, not color alone.
    await expect(page.getByTestId('pulse-health')).toContainText('At risk');
    // The active-sprint rollup chip (board → schedule link).
    await expect(page.getByTestId('pulse-sprint')).toContainText('Sprint 14');
    await expect(page.getByTestId('pulse-sprint').getByRole('progressbar')).toBeVisible();
    // The board is embedded below in its own landmark.
    await expect(page.getByRole('region', { name: 'Sprint board' })).toBeVisible();
  });

  test('active sprint — the board itself paints: a column heading, never the route placeholder (#4144)', async ({
    page,
  }) => {
    // #4144 reported /today stuck on five grey blocks with every API read 200.
    // Its cause is unidentified and it does not reproduce under mocks, so this
    // is a guard, not a regression test for a known fix. The `Sprint board` region being visible (the golden
    // path above) does not prove the board rendered — the region is visible
    // around a skeleton too — so this asserts on a real column heading.
    //
    // Every endpoint the page reads is mocked with its real shape. The shared
    // fixture covers overview, tasks, dependencies, board-config, board-views,
    // flow-metrics and sprint-forecast; the rest are registered below. Any read
    // that still falls through to the catch-all 404 fails the test, so a newly
    // added read on this page cannot quietly degrade the mocked surface.
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'NOT_STARTED', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks });
    await routeActiveSprint(page);
    await mockBoardReads(page);

    const unmocked: string[] = [];
    page.on('response', (res) => {
      if (res.url().includes('/api/v1/') && res.status() === 404) unmocked.push(res.url());
    });

    await page.goto(`/projects/${PROJECT_ID}/today`);

    // The board seeds its sprint scope from the single ACTIVE sprint.
    await expect(page).toHaveURL(/[?&]sprint=sp-1\b/);
    const board = page.getByRole('region', { name: 'Sprint board' });
    // Anchored: the column <h2>'s accessible name is "<label>, <n> task(s)".
    await expect(board.getByRole('heading', { name: /^To Do, / })).toBeVisible();
    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    // Neither the route placeholder nor the board's own skeleton is left up.
    await expect(page.getByRole('status', { name: 'Loading…', exact: true })).toHaveCount(0);
    await expect(page.getByRole('status', { name: 'Loading board…' })).toHaveCount(0);
    expect(unmocked, 'reads that fell through to the catch-all 404').toEqual([]);
  });

  test('flow analytics left open — the embedded board and its charts get a real size (#4144)', async ({
    page,
  }) => {
    // #4144's reporter suspected the Today split column gave the embedded board
    // no definite height, collapsing it and the flow charts to zero. Measured,
    // it does not: this pins that. The panel's open state is sticky per browser
    // (localStorage), so a returning visitor lands on /today with the charts
    // mounted. A chart container that measured 0 would make Recharts warn with
    // width(0)/height(0); its width(-1)/height(-1) warning is only the
    // pre-measure first render and fires on /board too, so it is not asserted.
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'NOT_STARTED', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks });
    await routeActiveSprint(page);
    await mockBoardReads(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/flow-metrics/**`, (route) =>
      route.fulfill(
        json({
          window_days: 90,
          since: '2026-05-01',
          until: '2026-07-30',
          cycle_time: { p50: 3, p80: 5, p95: 8 },
          lead_time: { p50: 5, p80: 8, p95: 12 },
          cfd: Array.from({ length: 14 }, (_, i) => ({
            date: `2026-06-${String(i + 1).padStart(2, '0')}`,
            counts: { BACKLOG: 5, NOT_STARTED: 4, IN_PROGRESS: 3, REVIEW: 1, COMPLETE: i },
          })),
          throughput: [
            { week_start: '2026-06-01', completed_count: 2 },
            { week_start: '2026-06-08', completed_count: 3 },
          ],
          data_integrity: { bulk_moved_count: 0, backdated_count: 0, missing_transition_count: 0 },
          flow_metrics_suppressed: false,
        }),
      ),
    );
    await page.addInitScript(
      (key) => window.localStorage.setItem(key, 'true'),
      `tppm.board.flowPanel.${PROJECT_ID}`,
    );
    const zeroSize: string[] = [];
    page.on('console', (msg) => {
      if (/width\(0\) and height\(0\)/.test(msg.text())) zeroSize.push(msg.text());
    });

    await page.goto(`/projects/${PROJECT_ID}/today`);

    const board = page.getByRole('region', { name: 'Sprint board' });
    await expect(board.getByRole('heading', { name: /^To Do, / })).toBeVisible();
    await expect(page.getByTestId('flow-analytics-charts')).toBeVisible();
    const charts = page.locator('.recharts-responsive-container');
    await expect(charts).toHaveCount(2);
    for (const chart of await charts.all()) {
      const box = await chart.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);
    }
    const region = await board.boundingBox();
    expect(region?.height ?? 0).toBeGreaterThan(200);
    expect(zeroSize).toEqual([]);
  });

  test('a route chunk that never settles ends at a Retry, not a permanent ghost', async ({
    page,
  }) => {
    // A lazy route chunk whose import() never settles rejects nothing and so
    // never reaches RouteErrorBoundary (rule 374). This is defense-in-depth,
    // not the #4144 fix: that report's network log shows board-child reads, so
    // its route chunk had loaded. Hold the Today chunk open and fast-forward
    // past the placeholder's bound (ROUTE_LOAD_STALL_MS, 15 s).
    await page.clock.install();
    await base(page, { overview: ATRISK_OVERVIEW });
    await page.route('**/assets/TodayView-*.js', () => {
      // Deliberately never fulfilled: a held module request.
    });

    await page.goto(`/projects/${PROJECT_ID}/today`);
    await expect(page.getByRole('status', { name: 'Loading…', exact: true })).toBeVisible();

    await page.clock.runFor(15_000);

    await expect(page.getByRole('status', { name: 'Loading…', exact: true })).toHaveCount(0);
    const stalled = page
      .getByRole('alert')
      .filter({ hasText: 'This view is taking too long to load.' });
    await expect(stalled).toBeVisible();
    await expect(stalled.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('empty state — shows "No active sprint" when none is active', async ({ page }) => {
    await base(page, { overview: ATRISK_OVERVIEW });
    // No sprint route override → fixtures return an empty sprint list.
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    await expect(page.getByTestId('pulse-no-sprint')).toContainText('No active sprint');
  });

  test('WATERFALL — keeps the schedule pulse, drops the sprint rollup', async ({ page }) => {
    await base(page, { overview: ATRISK_OVERVIEW, methodology: 'WATERFALL' });
    // Even with an active sprint, the rollup half is gone on waterfall.
    await routeActiveSprint(page);
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    await expect(page.getByTestId('pulse-health')).toContainText('At risk');
    await expect(page.getByTestId('pulse-sprint')).toHaveCount(0);
    // The board still embeds below — board is visible for every methodology.
    await expect(page.getByRole('region', { name: 'Sprint board' })).toBeVisible();
  });

  test('AGILE — foregrounds the sprint rollup, drops the CPM/SPI pulse', async ({ page }) => {
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'IN_PROGRESS', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks, methodology: 'AGILE' });
    await routeActiveSprint(page);
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    // The active sprint chip is shown and foregrounded.
    await expect(page.getByTestId('pulse-sprint')).toContainText('Sprint 14');
    await expect(page.getByTestId('pulse-sprint').getByRole('progressbar')).toBeVisible();
    // The CPM/SPI schedule-pulse cluster is off-vocabulary on agile → not rendered.
    await expect(page.getByTestId('pulse-health')).toHaveCount(0);
  });
});

import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * Overview risk-ranked focus cards E2E (#1191 / #1192).
 *
 * The Overview KPI strip leads with a three-column focus row and demotes the
 * rest to a compact secondary strip. Since #2483 the added-time card holds the
 * first column unconditionally — it is a relationship, not a severity reading,
 * so it has no band to be ranked by — and the ranking fills the remaining two.
 * This spec covers:
 *   - golden path: an at-risk project → heading "Needs attention", the worst
 *     ranked metric leads beside added time, plain-language copy (no SPI/EVM).
 *   - calm path: an all-healthy project → heading "Project health", the
 *     schedule card leads (intrinsic priority), the secondary strip is present.
 *
 * Both strips name their own severity verdict (#2429), so the region locators
 * below track the derived heading rather than a fixed label.
 *
 * Every endpoint the Overview page's hooks read is mocked with its real
 * response shape (#1190 lesson): a catch-all list shape would crash the
 * object-shaped /overview/ read and tear the page out from under the spec.
 */

const PROJECT_ID = 'e2e-focus-00000000-0000-0000-0000-000000001191';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Focus Cards Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// At-risk overview: 3 tasks late + 2 high risks → both lead as at-risk.
const FIXTURE_OVERVIEW_AT_RISK = {
  schedule_health: 'at_risk',
  spi: 0.88,
  tasks_late_count: 3,
  critical_task_count: 4,
  total_tasks: 20,
  complete_tasks: 8,
  next_milestone: { id: 'm1', name: 'Phase gate', date: '2026-05-01', percent_complete: 0 },
  team_utilization_pct: 70,
  owner_name: 'Alice Smith',
  start_date: '2026-01-01',
  open_risk_count: 5,
  high_risk_count: 2,
};

// All-healthy overview: nothing late, no high risks, util under 85.
const FIXTURE_OVERVIEW_HEALTHY = {
  schedule_health: 'on_track',
  spi: 1.02,
  tasks_late_count: 0,
  critical_task_count: 2,
  total_tasks: 20,
  complete_tasks: 14,
  next_milestone: { id: 'm1', name: 'Phase gate', date: '2026-05-01', percent_complete: 0 },
  team_utilization_pct: 60,
  owner_name: 'Alice Smith',
  start_date: '2026-01-01',
  open_risk_count: 0,
  high_risk_count: 0,
};

async function setupRoutes(
  page: import('@playwright/test').Page,
  overview: Record<string, unknown>,
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
  // falling through and 401ing, which trips the token-refresh session
  // teardown and races the page render (#2366). Routes below win.
  await setupCatchAll(page);

  await page.route(`**/api/v1/projects/`, (route) =>
    route.fulfill(
      json({ count: FIXTURE_PROJECTS.length, next: null, previous: null, results: FIXTURE_PROJECTS }),
    ),
  );
  // ProjectShell gates every project route on the detail query (#1111): a 404
  // renders ProjectNotFound in place of the page under test.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill(json(FIXTURE_PROJECTS[0])),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill(json(overview)),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill(json({ items: [] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill(json({ tasks: [] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprint-forecast/`, (route) =>
    route.fulfill(
      json({
        status: 'no_velocity',
        remaining_points: 0,
        remaining_count: null,
        sample_count: 0,
        p50_sprints: null,
        p80_sprints: null,
        p50_date: null,
        p80_date: null,
        p95_date: null,
        basis: 'monte_carlo',
        forecast_basis: 'velocity',
        velocity_suppressed: false,
      }),
    ),
  );
  // BlockedRollupPanel read — GET /projects/{id}/blocked/.
  await page.route('**/api/v1/projects/*/blocked/', (route) =>
    route.fulfill(json({ project_id: PROJECT_ID, count: 0, blocked: [] })),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) => route.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill(
      json({
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
    ),
  );
  // No saved Monte Carlo run → forecast card shows "—".
  await page.route('**/api/v1/projects/*/monte-carlo/latest/', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'No simulation result available.' }),
    }),
  );
  // Burn-up chart read — GET /projects/{id}/burn/?chart_type=…
  await page.route('**/api/v1/projects/*/burn/**', (route) =>
    route.fulfill(
      json({ chart_type: 'burnup', metric: 'tasks', since: '2026-01-01', until: '2026-06-01', series: [] }),
    ),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
}

test.describe('Overview risk-ranked focus cards (#1191)', () => {
  test('golden path — at-risk metric leads, three focus cards, plain-language copy', async ({
    page,
  }) => {
    await setupRoutes(page, FIXTURE_OVERVIEW_AT_RISK);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Page-rendered signal: the focus region with the alarmed heading. Exact —
    // a demoted problem names the secondary strip "Also needs attention", which
    // a substring match would collide with (#2429).
    const focus = page.getByRole('region', { name: 'Needs attention', exact: true });
    await expect(focus).toBeVisible({ timeout: 10_000 });

    // Three focus cards lead the page. Added time holds the first column
    // unconditionally (#2483); the two ranked slots behind it go to the worst
    // metrics, which for this fixture are schedule health and late tasks.
    await expect(
      focus.getByRole('region', { name: 'Added time vs computed finish', exact: true }),
    ).toBeVisible();
    await expect(focus.getByText('3 late')).toBeVisible();
    await expect(focus.getByText('of 20 tasks')).toBeVisible();

    // The secondary strip is present and holds the demoted metrics. Its heading
    // states the severity verdict for what was demoted (#2429): open risks is
    // at-risk and no longer fits the two ranked focus slots, so the strip names
    // that rather than reading calm — the demotion stays legible instead of
    // hiding a real problem under a reassuring label.
    const secondary = page.getByRole('region', { name: 'Also needs attention', exact: true });
    await expect(secondary).toBeVisible();
    await expect(secondary.getByText('2 high')).toBeVisible();
    await expect(secondary.getByText('Next milestone')).toBeVisible();

    // No EVM jargon anywhere on the page (#1192).
    await expect(page.getByText(/\bSPI\b/)).toHaveCount(0);
    await expect(page.getByText(/\bEVM\b/)).toHaveCount(0);
  });

  test('calm path — all-healthy reads "Project health", schedule leads, secondary demoted', async ({
    page,
  }) => {
    await setupRoutes(page, FIXTURE_OVERVIEW_HEALTHY);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Calm heading — no red/amber alarm wording.
    const focus = page.getByRole('region', { name: 'Project health' });
    await expect(focus).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('region', { name: /needs attention/i })).toHaveCount(0);

    // Intrinsic order with all-healthy → schedule health leads the focus row.
    await expect(focus.getByText('Schedule health')).toBeVisible();
    await expect(focus.getByText('On schedule')).toBeVisible();

    // The secondary strip is still present (only 3 items, always visible) and,
    // with nothing demoted in trouble, names itself calm (#2429).
    await expect(page.getByRole('region', { name: 'Holding steady' })).toBeVisible();
  });
});

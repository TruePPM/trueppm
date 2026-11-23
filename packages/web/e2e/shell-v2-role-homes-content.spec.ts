/**
 * Shell v2 role homes, content and states (#4768, #4769, #4771, #5107).
 *
 * Contributor: assigned work, grouped, with no project-management vocabulary; an
 * error is not an empty home. PM: forecast hero (server P80, as-of, curve), the
 * biggest-slip and blocked cards, decisions waiting, the project table; empty with no
 * programs. Executive: one program, a switcher, no cross-program view. Forecast view:
 * reachable from the project's context header, draws the weekly histogram. Preferences:
 * the Resource Manager home toggle PATCHes `home_override`.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PG = 'e2e-homes-00000000-0000-0000-0000-000000004769';
const PJ = 'e2e-homes-00000000-0000-0000-0000-000000004768';
const pj = (v: unknown) => JSON.stringify(v);
const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: pj(body),
});

type Home = 'contributor' | 'pm' | 'exec';

interface Opts {
  home: Home;
  programs?: 'some' | 'none' | 'error';
  work?: 'some' | 'error';
}

const USER = (home: Home, homeProgram: boolean) => ({
  id: '7',
  username: 'casey',
  display_name: 'Casey',
  initials: 'C',
  email: 'casey@example.com',
  max_project_role: home === 'exec' ? 1 : 100,
  workspace_role: null,
  can_access_admin_settings: false,
  default_landing: 'auto',
  landing: {
    intent: 'my_work',
    path: '/me/work',
    resolved_by: 'role_policy',
    home,
    home_program: homeProgram ? { id: PG, code: 'ATL', name: 'Atlas Program' } : null,
  },
});

const MC = {
  project_id: PJ,
  runs: 500,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  histogram_buckets: [
    { date: '2026-11-02', count: 90 },
    { date: '2026-11-09', count: 120 },
    { date: '2026-12-07', count: 60 },
  ],
  confidence_curve: [
    { date: '2026-11-02', pct: 10 },
    { date: '2026-11-15', pct: 50 },
    { date: '2026-12-10', pct: 80 },
    { date: '2026-12-28', pct: 95 },
  ],
  forecast_staleness: 'current',
  plan_version: 1,
  plan_version_current: 1,
  last_run_at: '2026-11-20T10:00:00Z',
  cpm_finish: '2026-11-30',
  delta_vs_cpm: { p50: -15, p80: 10, p95: 28 },
  commitment_date: '2026-12-08',
  p80_delta_vs_commitment_days: 2,
};

async function setup(page: Page, o: Opts) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json(USER(o.home, o.home === 'exec' && o.programs !== 'none'))),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/programs/', (r) => {
    if (o.programs === 'error') return r.fulfill(json({ detail: 'boom' }, 500));
    const results =
      o.programs === 'none'
        ? []
        : [
            { id: PG, name: 'Atlas Program', code: 'ATL', my_role: 1 },
            { id: 'second-program', name: 'Beacon Program', code: 'BCN', my_role: 1 },
          ];
    return r.fulfill(json({ count: results.length, next: null, previous: null, results }));
  });
  await page.route(`**/api/v1/programs/${PG}/rollup/`, (r) =>
    r.fulfill(
      json({
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 1,
        program_health: 'on_track',
        kpis: {
          p80_completion: {
            available: true,
            value: '2026-12-10',
            unit: 'date',
            as_of: '2026-11-20T10:00:00Z',
            driver_project_id: PJ,
            projects_without_forecast: 0,
          },
        },
        definitions: { p80_completion: 'The date 4 in 5 runs finish by, from the server.' },
      }),
    ),
  );
  await page.route(`**/api/v1/programs/${PG}/projects/`, (r) =>
    r.fulfill(
      json([
        {
          id: PJ,
          name: 'Atlas Migration',
          start_date: '2026-04-01',
          at_risk_count: 3,
          overdue_count: 1,
        },
      ]),
    ),
  );
  await page.route('**/api/v1/projects/health-summary/', (r) =>
    r.fulfill(
      json([
        {
          id: PJ,
          name: 'Atlas Migration',
          health_band: 'at_risk',
          health_band_source: 'derived',
          at_risk_count: 3,
          critical_count: 0,
        },
      ]),
    ),
  );
  await page.route(`**/api/v1/projects/${PJ}/monte-carlo/latest/`, (r) => r.fulfill(json(MC)));
  await page.route(`**/api/v1/projects/${PJ}/blocked/`, (r) =>
    r.fulfill(
      json({
        project_id: PJ,
        count: 2,
        truncated: false,
        blocked: [
          {
            task_id: 't1',
            task_short_id: 'T-1',
            title: 'Waiting on vendor sandbox',
            assignee: null,
            blocker_type: null,
            blocked_since: null,
            blocked_age_seconds: null,
            blocked_by: null,
            blocking_task: null,
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/v1/programs/${PG}/decisions/**`, (r) =>
    r.fulfill(
      json({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'd1',
            server_version: 1,
            program: PG,
            title: 'Approve vendor sandbox extension',
            owner: null,
            owner_detail: null,
            due_date: '2026-12-01',
            status: 'awaiting',
            decided_at: null,
            linked_task: null,
            linked_risk: null,
            link: null,
            impact_note: '',
            created_by: null,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          },
        ],
      }),
    ),
  );
  await page.route('**/api/v1/me/work/**', (r) =>
    o.work === 'error'
      ? r.fulfill(json({ detail: 'boom' }, 500))
      : r.fulfill(
          json({
            count: 0,
            next: null,
            previous: null,
            results: [],
            due_today_count: 0,
            active_sprints: [],
            retro_action_items: [],
            external_items: [],
            external_sources: [],
          }),
        ),
  );
}

test.describe('shell v2 role homes: content and states', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('PM home: forecast hero, slip and blocked cards, decisions, projects', async ({ page }) => {
    await setup(page, { home: 'pm' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Forecast · Atlas Program' })).toBeVisible();
    await expect(page.getByText('P80 is 2 working days past commitment.')).toBeVisible();
    await expect(page.getByText('2 blocked in Atlas Migration')).toBeVisible();
    await expect(page.getByText('Longest waiting: Waiting on vendor sandbox')).toBeVisible();
    await expect(page.getByText('Approve vendor sandbox extension')).toBeVisible();
    const table = page.getByRole('table', { name: 'Projects in this program' });
    await expect(table.getByRole('link', { name: 'Atlas Migration' })).toBeVisible();
    await expect(table.getByText('At risk').first()).toBeVisible();
    await expect(page.getByRole('img', { name: /Chance of finishing by date/ })).toBeVisible();
  });

  test('PM home with no programs says so', async ({ page }) => {
    await setup(page, { home: 'pm', programs: 'none' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'No programs yet' })).toBeVisible();
  });

  test('PM home shows an error, not an empty home, when programs fail to load', async ({
    page,
  }) => {
    await setup(page, { home: 'pm', programs: 'error' });
    await page.goto('/home');
    await expect(page.getByText("Couldn't load your programs.")).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No programs yet' })).toHaveCount(0);
  });

  test('Executive home opens on the server program and switches the view only', async ({
    page,
  }) => {
    await setup(page, { home: 'exec' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'Forecast · Atlas Program' })).toBeVisible();
    await expect(page.getByText(/all programs/i)).toHaveCount(0);
    await page
      .getByTestId('page-frame-toolbar')
      .getByLabel('Program')
      .selectOption('second-program');
    await expect(page.getByRole('heading', { name: 'Forecast · Beacon Program' })).toBeVisible();
  });

  test('Executive home with no program opens on the empty state', async ({ page }) => {
    await setup(page, { home: 'exec', programs: 'none' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { name: 'No programs to show' })).toBeVisible();
  });

  test('Contributor home: empty state when nothing is assigned', async ({ page }) => {
    await setup(page, { home: 'contributor' });
    await page.goto('/home');
    await expect(page.getByRole('region', { name: 'My Work', exact: true })).toBeVisible();
    await expect(page.getByText(/critical path|forecast|schedule health/i)).toHaveCount(0);
  });

  test('Contributor home: a failed read is an error with retry, not an empty home', async ({
    page,
  }) => {
    await setup(page, { home: 'contributor', work: 'error' });
    await page.goto('/home');
    await expect(page.getByText("Couldn't load your work.")).toBeVisible();
    await expect(page.getByRole('main').getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('the forecast view is reachable from the context header and draws the histogram', async ({
    page,
  }) => {
    await setup(page, { home: 'pm' });
    await page.route(`**/api/v1/projects/${PJ}/`, (r) =>
      r.fulfill(
        json({
          id: PJ,
          name: 'Atlas Migration',
          description: '',
          start_date: '2026-04-01',
          calendar: 'default',
        }),
      ),
    );
    await page.goto(`/projects/${PJ}/overview`);
    await page.getByRole('link', { name: 'Forecast', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/.*/forecast$`));
    await expect(page.getByRole('img', { name: /Finish by week/ })).toBeVisible();
  });

  test('Preferences: the Resource Manager home toggle PATCHes home_override', async ({ page }) => {
    await setup(page, { home: 'pm' });
    const bodies: unknown[] = [];
    await page.route('**/api/v1/auth/me/profile/', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      bodies.push(route.request().postDataJSON());
      return route.fulfill(json({ home_override: 'rm' }));
    });
    await page.goto('/me/settings/general');
    const box = page.getByRole('checkbox', { name: /Open on the Resource Manager home/ });
    await expect(box).not.toBeChecked();
    await box.click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toEqual({ home_override: 'rm' });
  });
});

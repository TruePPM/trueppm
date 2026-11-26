/**
 * E2E for the shell v2 Program Overview (#4799) behind `?ff=shell_v2`: the program
 * P80 lead, one row per project on a shared axis sorted by slip with the PM's latest
 * status update, the empty program, and the partial rollup that names the project
 * the program P80 leaves out. `/programs/:id/rollup/` is mocked with its full object
 * shape (never the catch-all list mock; see #1190).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';
import { expectNoA11yViolationsBothThemes } from './fixtures/a11y';

const PROGRAM_ID = 'e2e-program-v2-0000-0000-0000-000000004799';
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
const C = '00000000-0000-0000-0000-0000000000c3';

const PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Atlas Launch',
  description: '',
  code: 'ATL',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: 'user-alice',
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 3,
  member_count: 3,
};

const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  accessible: true,
  schedule_health: 'on_track',
  p50: null,
  p80: null,
  forecast_as_of: null,
  commitment_date: null,
  p80_delta_vs_commitment_days: null,
  p80_delta_vs_commitment_reason: 'no_forecast',
  lead_name: 'Pat Manager',
  latest_update: null,
  ...extra,
});

const ROWS = [
  row(A, 'Data Migration', {
    p50: '2027-02-01',
    p80: '2027-02-20',
    forecast_as_of: '2026-11-20T09:12:00Z',
    commitment_date: '2027-02-10',
    p80_delta_vs_commitment_days: 8,
    p80_delta_vs_commitment_reason: null,
    latest_update: {
      id: '00000000-0000-0000-0000-000000000101',
      seq: 4,
      rag: 'amber',
      computed_health: 'critical',
      first_line: 'Vendor slipped two weeks',
      author_name: 'Pat Manager',
      posted_at: '2026-11-20T09:12:00Z',
    },
  }),
  row(B, 'Portal', {
    p50: '2027-01-10',
    p80: '2027-01-20',
    forecast_as_of: '2026-11-20T09:12:00Z',
    commitment_date: '2027-01-25',
    p80_delta_vs_commitment_days: -3,
    p80_delta_vs_commitment_reason: null,
  }),
  row(C, 'Identity Consolidation'),
];

function rollup(projects: unknown[], withoutIds: string[], budget?: unknown) {
  const forecast = {
    available: true,
    unit: 'date',
    value: projects.length ? '2027-02-20' : null,
    as_of: projects.length ? '2026-11-20T09:12:00Z' : null,
    driver_project_id: projects.length ? A : null,
    projects_without_forecast: withoutIds.length,
    projects_without_forecast_ids: withoutIds,
    ...(projects.length ? {} : { reason: 'no_projects' }),
  };
  return {
    aggregation_policy: 'worst',
    policy_available: true,
    policy_unavailable_reason: null,
    project_count: projects.length,
    program_health: projects.length ? 'at_risk' : 'unknown',
    program_health_reason: projects.length ? null : 'no_projects',
    kpis: { p80_completion: forecast, ...(budget ? { budget_utilization: budget } : {}) },
    as_of: '2026-11-20T09:12:00Z',
    definitions: {
      program_health: 'Server program health sentence.',
      p80_completion: 'Server program P80 sentence.',
    },
    projects,
    forecast,
    summary: {
      projects_in_scope_count: 3,
      projects_on_track: 1,
      open_risk_count: 4,
      cross_project_link_count: 2,
    },
  };
}

const LOAD = (over: number, reason: string | null, withheld = 1) => ({
  as_of: '2026-11-20T09:12:00Z',
  window: { start: '2026-11-16', end: '2027-01-10' },
  weeks: ['2026-11-16'],
  scope: {
    project_count: 2,
    withheld_project_count: withheld,
    capacity_withheld_project_count: 0,
    program_id: PROGRAM_ID,
  },
  people: [],
  over_allocated_count: over,
  reason,
  definitions: { load_pct: 'Load sentence.', over_allocated_count: 'Over-allocated sentence.' },
});

async function open(page: Page, body: unknown, load: unknown = LOAD(2, null)) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const json = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'user-alice',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@example.com',
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) => r.fulfill(json(PROGRAM)));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) => r.fulfill(json([])));
  await page.route('**/api/v1/me/people-load/**', (r) =>
    load === 'fail' ? r.fulfill({ status: 500, body: '{}' }) : r.fulfill(json(load)),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) => r.fulfill(json(body)));
  await page.goto(`/programs/${PROGRAM_ID}?ff=shell_v2`);
  await expect(page.getByTestId('program-overview2')).toBeVisible({ timeout: 10_000 });
}

test.describe('shell v2 program overview', () => {
  test('golden path: P80 lead, rows on one axis sorted by slip, PM narrative', async ({
    page,
  }, testInfo) => {
    await open(page, rollup(ROWS, []));
    await expect(page.getByTestId('program-overview2-p80')).toContainText('2027');
    await expect(page.getByTestId('program-overview2-lead')).toContainText('Set by Data Migration');
    const rows = page.getByTestId('program-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Data Migration');
    await expect(rows.nth(0)).toContainText('At risk');
    await expect(rows.nth(0)).toContainText('Vendor slipped two weeks');
    await expect(rows.nth(0)).toContainText('+8d past commitment');
    await expect(rows.nth(1)).toContainText('3d ahead of commitment');
    await expect(rows.nth(2)).toContainText('No status update posted yet.');
    await expect(page.getByTestId('program-row-band')).toHaveCount(2);
    await expect(page.getByTestId('program-overview2-partial')).toHaveCount(0);
    await expect(page.getByText(/Enterprise/)).toHaveCount(0);
    await expectNoA11yViolationsBothThemes(page, testInfo);
  });

  test('supporting tiles are the server counts; over-allocated is the scoped people-load figure', async ({
    page,
  }) => {
    await open(
      page,
      rollup(ROWS, [], {
        available: false,
        reason: 'no_budget',
        projects_without_budget: 1,
        projects_without_budget_ids: [C],
      }),
    );
    const tiles = page.getByTestId('program-overview2-tile');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0)).toContainText('1 of 3');
    await expect(tiles.nth(1)).toContainText('2');
    await expect(tiles.nth(2)).toContainText('4');
    await expect(tiles.nth(3)).toContainText('Over-allocated');
    await expect(tiles.nth(3)).toContainText('1 project withheld');
    const lines = page.getByTestId('not-computable');
    await expect(lines).toHaveCount(1);
    await expect(lines.nth(0)).toContainText(
      'Program budget burn can’t be computed: Identity Consolidation has no budget baseline.',
    );
  });

  test('no project in scope: not-computable line, never 0 of 0', async ({ page }, testInfo) => {
    const body = rollup(
      ROWS.map((r) => ({ ...r, accessible: false })),
      [],
    );
    body.summary.projects_in_scope_count = 0;
    body.summary.projects_on_track = 0;
    await open(page, body);
    await expect(page.getByTestId('not-computable').first()).toContainText(
      'not a member of any project in this program',
    );
    await expect(
      page.getByTestId('program-overview2-tile').filter({ hasText: 'Open risks' }),
    ).toHaveCount(0);
    await expect(page.getByText('0 of 0')).toHaveCount(0);
    await expectNoA11yViolationsBothThemes(page, testInfo);
  });

  test('partial scope: the count tiles say how many projects they leave out', async ({ page }) => {
    const body = rollup(
      ROWS.map((r, i) => ({ ...r, accessible: i === 0 })),
      [],
    );
    body.summary.projects_in_scope_count = 1;
    await open(page, body);
    await expect(page.getByTestId('program-overview2-tile').nth(2)).toContainText(
      '2 projects not counted',
    );
  });

  test('no budget line when the budget KPI is not configured', async ({ page }) => {
    await open(page, rollup(ROWS, []));
    await expect(page.getByTestId('program-overview2-tile')).toHaveCount(4);
    await expect(page.getByTestId('not-computable')).toHaveCount(0);
    await expect(page.getByText('Program budget burn')).toHaveCount(0);
  });

  test('over-allocated says why not when the caller schedules no project, or the read fails', async ({
    page,
  }) => {
    await open(page, rollup(ROWS, []), LOAD(0, 'no_projects', 0));
    await expect(page.getByTestId('program-overview2-tile')).toHaveCount(3);
    await expect(page.getByTestId('not-computable')).toContainText(
      'Over-allocated can’t be computed: you do not hold a Scheduler role',
    );
  });

  test('a failed people-load read leaves a not-computable line, never a zero', async ({ page }) => {
    await open(page, rollup(ROWS, []), 'fail');
    await expect(page.getByTestId('not-computable')).toContainText('the load figure did not load');
    await expect(page.getByTestId('program-overview2-tile')).toHaveCount(3);
  });

  test('empty program: one add action, no upsell', async ({ page }) => {
    await open(page, rollup([], []));
    await expect(page.getByTestId('program-overview2-empty')).toContainText(
      'No projects in this program',
    );
    await expect(page.getByRole('link', { name: 'Add a project' })).toBeVisible();
    await expect(page.getByText(/Enterprise/)).toHaveCount(0);
  });

  test('partial rollup names the project the program P80 excludes', async ({ page }) => {
    await open(page, rollup(ROWS, [C]));
    await expect(page.getByTestId('program-overview2-partial')).toHaveText(
      /1 of 3 projects didn’t report \(Identity Consolidation\); the program P80 excludes it until it reports\./,
    );
  });
});

import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program schedule on a phone (#3480) and bar drill-down (#3896).
 *
 * At 390px the canvas Gantt is not mounted; a project-grouped list of
 * critical-path tasks and cross-project links renders instead, with the P80
 * finish. See program-schedule.spec.ts for the desktop view.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000001118';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Helios Program',
  description: '',
  code: '',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 2,
  member_count: 1,
};

const FIXTURE_SCHEDULE = {
  program_id: PROGRAM_ID,
  start_date: '2026-03-02',
  finish_date: '2026-05-01',
  projects: [
    { id: 'proj-a', name: 'Helios Platform', accessible: true, duration: 10 },
    { id: 'proj-b', name: 'Helios Mobile', accessible: true, duration: 1 },
  ],
  tasks: [
    {
      id: 't-a1',
      name: 'Design API',
      hex_id: 'A-1',
      project_id: 'proj-a',
      is_milestone: false,
      is_external: false,
      wbs_path: '1.1',
      early_start: '2026-03-02',
      early_finish: '2026-03-13',
      late_start: '2026-03-02',
      late_finish: '2026-03-13',
      total_float_days: 0,
      is_critical: true,
      duration: 10,
    },
    {
      id: 't-b1',
      name: 'Integrate API',
      hex_id: 'B-1',
      project_id: 'proj-b',
      is_milestone: true,
      is_external: false,
      wbs_path: '1.1',
      early_start: '2026-03-16',
      early_finish: '2026-03-16',
      late_start: '2026-03-16',
      late_finish: '2026-03-16',
      total_float_days: 0,
      is_critical: true,
      duration: 1,
    },
  ],
  links: [
    {
      predecessor_id: 't-a1',
      successor_id: 't-b1',
      dep_type: 'FS',
      lag_days: 0,
      is_cross_project: true,
    },
  ],
  critical_path: ['t-a1', 't-b1'],
  cross_project_edge_count: 1,
};

type Page = import('@playwright/test').Page;

const ROLLUP = {
  aggregation_policy: 'average',
  policy_available: true,
  project_count: 2,
  program_health: 'GREEN',
  kpis: {},
  forecast: { available: true, value: '2026-06-12', unit: 'date' },
  projects: [
    {
      id: 'proj-a',
      name: 'Helios Platform',
      accessible: true,
      schedule_health: 'GREEN',
      p50: '2026-05-20',
      p80: '2026-06-05',
      forecast_as_of: null,
      commitment_date: null,
      p80_delta_vs_commitment_days: null,
      p80_delta_vs_commitment_reason: 'no_commitment',
      lead_name: null,
      latest_update: null,
    },
  ],
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  const pj = (data: unknown) => JSON.stringify(data);
  const ok = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: pj(body),
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill(ok(FIXTURE_ME)));
  await page.route('**/api/v1/edition/', (r) => r.fulfill(ok({ edition: 'community' })));
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill(ok({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null })),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) => r.fulfill(ok(FIXTURE_PROGRAM)));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/schedule/`, (r) =>
    r.fulfill(ok(FIXTURE_SCHEDULE)),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) => r.fulfill(ok(ROLLUP)));
  await page.route('**/api/v1/ws/ticket/', (r) => r.fulfill(ok({ ticket: 't', expires_in: 30 })));
}

test.describe('Program schedule on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('lists critical-path tasks per project with dates and the P80 finish', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/schedule`);

    await expect(page.getByRole('heading', { name: 'Program Schedule' })).toBeVisible();
    await expect(page.getByTestId('program-schedule-mobile-summary')).toContainText(/P80 finish/);
    // No wall: the old refusal copy is gone, the hint remains.
    await expect(page.getByText('Best viewed on a larger screen')).toHaveCount(0);
    await expect(page.getByText(/for the full timeline/)).toBeVisible();
    await expect(page.getByTestId('program-schedule-canvas-scroll')).toHaveCount(0);

    const platform = page.getByRole('listitem', { name: 'Helios Platform', exact: true });
    await expect(platform.getByRole('heading', { name: 'Helios Platform' })).toBeVisible();
    await expect(platform).toContainText('P80');
    await expect(
      platform.getByRole('button', { name: /Design API, .*Mar 2.*on the critical path/ }),
    ).toBeVisible();
    const mobile = page.getByRole('listitem', { name: 'Helios Mobile', exact: true });
    await expect(
      mobile.getByRole('button', { name: /Integrate API.*cross-project link/ }),
    ).toBeVisible();
    await expect(mobile).toContainText('No forecast');
  });

  test('tapping a row opens the task in its own project, and Back returns', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/schedule`);

    const row = page.getByRole('button', { name: /Design API/ });
    const box = await row.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await row.click();
    await expect(page).toHaveURL(/\/projects\/proj-a\/schedule\?task=t-a1/);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/schedule$`));
    await expect(page.getByRole('heading', { name: 'Program Schedule' })).toBeVisible();
  });

  test('empty program: shows the no-schedule state, not a list', async ({ page }) => {
    await setup(page);
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/schedule/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...FIXTURE_SCHEDULE,
          tasks: [],
          links: [],
          critical_path: [],
          cross_project_edge_count: 0,
          start_date: null,
          finish_date: null,
        }),
      }),
    );
    await page.goto(`/programs/${PROGRAM_ID}/schedule`);
    await expect(page.getByText('No program schedule yet')).toBeVisible();
  });
});

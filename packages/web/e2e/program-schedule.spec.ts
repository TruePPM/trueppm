import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program schedule view E2E (#1118, ADR-0120 §D6 / ADR-0182).
 *
 * The view renders the merged program-true cross-project schedule in the canvas
 * Gantt engine. Canvas pixels aren't assertable, so these specs verify the page
 * chrome that frames it: the header + project count, the legend that lets a
 * first-time viewer read cross-project edges and the critical path, and the
 * empty state when no member project has a computed schedule yet.
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
  my_role_label: 'Project Admin',
  project_count: 2,
  member_count: 1,
};

const FIXTURE_SCHEDULE = {
  program_id: PROGRAM_ID,
  start_date: '2026-03-02',
  finish_date: '2026-05-01',
  projects: [
    { id: 'proj-a', name: 'Helios Platform', accessible: true },
    { id: 'proj-b', name: 'Helios Mobile', accessible: true },
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

async function setup(page: Page, scheduleResponse: { status: number; body: unknown }) {
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

  // Catch-all 401-guard: every unmocked request returns an empty LIST shape.
  // Object endpoints this page reads (program detail, schedule) are mocked
  // explicitly below so the catch-all never serves them a malformed object.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/schedule/`, (r) =>
    r.fulfill({
      status: scheduleResponse.status,
      contentType: 'application/json',
      body: pj(scheduleResponse.body),
    }),
  );
  // Live-sync mints a ws ticket per member project; satisfy it so no 401 fires.
  await page.route('**/api/v1/ws/ticket/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ ticket: 't', expires_in: 30 }) }),
  );
}

test.describe('Program schedule view', () => {
  test('golden path: header, project count, and legend render', async ({ page }) => {
    await setup(page, { status: 200, body: FIXTURE_SCHEDULE });
    await page.goto(`/programs/${PROGRAM_ID}/schedule`);

    // Page-rendered gate: the heading appears only after the schedule resolves.
    await expect(page.getByRole('heading', { name: 'Program Schedule' })).toBeVisible();
    await expect(
      page.getByText(/Cross-project critical path across 2 projects/),
    ).toBeVisible();

    // The legend lets a first-time viewer read the chart.
    const legend = page.getByRole('list', { name: 'Schedule legend' });
    await expect(legend.getByText('Critical path')).toBeVisible();
    await expect(legend.getByText('Cross-project link')).toBeVisible();
    await expect(legend.getByText('Milestone')).toBeVisible();
  });

  test('empty state: no member project has a computed schedule yet', async ({ page }) => {
    // The endpoint returns 200 with an empty payload (lanes present, no scheduled
    // tasks) — not an error code — when nothing has been computed yet.
    await setup(page, {
      status: 200,
      body: {
        program_id: PROGRAM_ID,
        start_date: null,
        finish_date: null,
        projects: [
          { id: 'proj-a', name: 'Helios Platform', accessible: true },
          { id: 'proj-b', name: 'Helios Mobile', accessible: true },
        ],
        tasks: [],
        links: [],
        critical_path: [],
        cross_project_edge_count: 0,
      },
    });
    await page.goto(`/programs/${PROGRAM_ID}/schedule`);

    await expect(page.getByText('No program schedule yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Projects' })).toBeVisible();
  });
});

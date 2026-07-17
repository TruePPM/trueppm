/**
 * Configurable estimation scale — Project Methodology settings (ADR-0510, #2027).
 *
 * The estimation scale (Fibonacci / Linear / T-shirt) cascades Workspace → Program
 * → Project and is Scheduler+-editable, living beside "Estimate governance" on the
 * project Methodology page. This spec covers the golden path: an Admin overrides the
 * inherited workspace scale with T-shirt and the PATCH carries `estimation_scale`.
 *
 * All API calls are intercepted via page.route() so no backend is required.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

const pj = (data: unknown) => JSON.stringify(data);
const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: pj(body),
});

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-scale-00000000-0000-0000-0000-000000002027';

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    name: 'TrueScope Aerospace',
    subdomain: 'truescope',
    timezone: 'UTC',
    fiscal_year_start_month: 1,
    fiscal_year_start_day: 1,
    fiscal_year_start_display: 'January 1',
    work_week: [true, true, true, true, true, false, false],
    default_project_view: 'Overview',
    allow_guests: false,
    public_sharing: false,
    iteration_label: 'Sprint',
    iteration_label_override_policy: 'suggest',
    mc_history_enabled: true,
    mc_history_retention_cap: 100,
    mc_history_attribution_audience: 'ADMIN_OWNER',
    mc_history_override_policy: 'suggest',
    methodology: 'HYBRID',
    methodology_override_policy: 'suggest',
    estimation_scale: 'fibonacci',
    calendar: null,
    calendar_override_policy: 'suggest',
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Atlas Migration',
    description: '',
    start_date: '2026-01-01',
    status_date: null,
    calendar: null,
    program: null,
    estimation_mode: 'open',
    prioritization_model: 'none',
    stale_task_threshold_days: 14,
    end_date_shift_threshold_days: 7,
    agile_features: true,
    methodology: 'HYBRID',
    effective_methodology: 'HYBRID',
    inherited_methodology: 'HYBRID',
    board_cadence: 'sprint',
    default_member_role: 100,
    default_member_role_label: 'Team Member',
    // ADR-0510 — inherits the workspace Fibonacci scale by default.
    estimation_scale: null,
    effective_estimation_scale: 'fibonacci',
    inherited_estimation_scale: 'fibonacci',
    ...overrides,
  };
}

// Admin (300) is >= Scheduler, so the estimation-scale control is editable.
const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300,
  role_label: 'Project Admin',
};

async function setup(page: Page, patchRef: { body: Record<string, unknown> | null }) {
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

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json({ id: ME_ID, username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@example.com' })),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/workspace/', (r) => r.fulfill(json(workspace())));
  // useCurrentUserRole reads res.data[0] — a bare array, not a paginated envelope.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill(json([ADMIN_MEMBERSHIP])),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => {
    if (r.request().method() === 'PATCH') {
      patchRef.body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>;
      r.fulfill(json(project({ estimation_scale: 'tshirt', effective_estimation_scale: 'tshirt' })));
      return;
    }
    r.fulfill(json(project()));
  });
}

test('golden path — an Admin overrides the inherited scale with T-shirt', async ({ page }) => {
  const patchRef: { body: Record<string, unknown> | null } = { body: null };
  await setup(page, patchRef);

  await page.goto(`/projects/${PROJECT_ID}/settings/methodology`);

  // Wait for the page to render (the scale control is the last section).
  const scaleGroup = page.getByRole('radiogroup', { name: 'Estimation scale' });
  await expect(scaleGroup).toBeVisible();

  // Switch from the inherited default to Override, then pick T-shirt.
  await scaleGroup.getByText('Override').click();
  await page.getByRole('combobox', { name: 'Estimation scale' }).selectOption('tshirt');

  await page.getByRole('button', { name: /Save changes/i }).click();

  await expect.poll(() => patchRef.body).not.toBeNull();
  expect(patchRef.body).toMatchObject({ estimation_scale: 'tshirt' });
});

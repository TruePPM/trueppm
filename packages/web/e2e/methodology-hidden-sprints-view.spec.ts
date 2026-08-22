/**
 * Methodology-hidden view reached by direct URL (issue #2619).
 *
 * `/sprints` is hidden from the nav for a WATERFALL project (methodologyTabs.ts),
 * but stays reachable by direct URL by design — the preset communicates "this is
 * not how we work here", not "this is not allowed". The bug this spec guards
 * against: the empty state a visitor actually lands on used to invite the
 * deviation with a primary "Plan a sprint" CTA and zero context. It now states
 * the mismatch plainly and points the primary action at Schedule instead.
 *
 * A second scenario covers the sibling defect: flipping a project to WATERFALL
 * never touches its sprint data, so a project that already has sprints must
 * render them with a mismatch banner rather than the (wrong) empty state.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-meth-hidden-00000000-0000-0000-0000-000000002619';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Waterfall Bridge',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'WATERFALL',
  },
];

function projectDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    server_version: 1,
    name: 'Waterfall Bridge',
    description: '',
    start_date: '2026-04-01',
    calendar: null,
    estimation_mode: 'open',
    agile_features: false,
    methodology: 'WATERFALL',
    effective_methodology: 'WATERFALL',
    inherited_methodology: 'WATERFALL',
    ...overrides,
  };
}

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'A1',
  short_id_display: 'SP-A1',
  name: 'Active sprint',
  goal: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 20,
  committed_task_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: 0,
  completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

async function setupCommon(page: import('@playwright/test').Page, sprints: unknown[] = []) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
  // falling through and 401ing (#2366). Routes below win.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(projectDetail()),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: sprints.length, next: null, previous: null, results: sprints }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        members: [],
        totals: {
          committed_hours: 0,
          available_hours: 0,
          ratio: 0,
          buffer_hours: 0,
          label: 'on_track',
          pto_days: 0,
        },
        working_days: 0,
        hours_per_day: 8,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
      }),
    }),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
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
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2e',
        display_name: 'E2E',
        initials: 'E',
        email: 'e2e@example.com',
      }),
    }),
  );
  // `/members/**` (not bare `/members/`) so the glob also matches the
  // `?self=true` role query — the SprintHeader lifecycle buttons are gated on
  // SCHEDULER+ (#2146) and stay hidden if the role can't resolve.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300 }]),
    }),
  );
}

test.describe('A methodology-hidden view reached by direct URL (#2619)', () => {
  test('WATERFALL + no sprints: explanatory empty state, no primary "Plan a sprint" CTA', async ({
    page,
  }) => {
    await setupCommon(page, []);
    await page.goto(BASE_URL);

    await expect(page.getByText(/Sprints aren't part of this project's workflow/i)).toBeVisible();
    await expect(page.getByText(/No sprints yet/i)).not.toBeVisible();
    // The empty state's CTA is gone; the header's persistent "Plan next sprint"
    // action is untouched (it is not the defect this issue reports).
    await expect(page.getByRole('button', { name: 'Plan a sprint' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Go to Schedule' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Change methodology' })).toBeVisible();
  });

  test('WATERFALL + existing sprints: renders them with a mismatch banner, not the empty state', async ({
    page,
  }) => {
    await setupCommon(page, [ACTIVE_SPRINT]);
    await page.goto(BASE_URL);

    await expect(page.getByText(/No sprints yet/i)).not.toBeVisible();
    await expect(
      page.getByText(/This project is configured as Waterfall, but 1 sprint already is committed/i),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review methodology' })).toBeVisible();
    // The sprint itself still renders.
    await expect(page.getByRole('heading', { level: 1, name: /Active sprint/ })).toBeVisible();
  });

  test('"Change methodology" routes to Settings → How this team works', async ({ page }) => {
    // The Methodology anchor was absorbed by the consolidated section in #2969.
    // The in-app deep link points at the live id directly rather than leaning on
    // the alias rewrite — an alias is a promise to old links, not a destination
    // the product should keep minting.
    await setupCommon(page, []);
    await page.goto(BASE_URL);

    await page.getByRole('button', { name: 'Change methodology' }).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${PROJECT_ID}/settings#how-this-team-works$`),
    );
  });
});

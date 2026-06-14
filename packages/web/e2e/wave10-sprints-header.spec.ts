/**
 * Wave 10 — Sprints view header E2E (issue #227).
 *
 * Golden path: navigating to /projects/:id/sprints renders the breadcrumb,
 * H1 with active sprint name, the goal card, the milestone card with the
 * deep-link to Schedule view, and the timeline strip with closed / active /
 * planned cards.
 *
 * Edge cases:
 *  - No sprints → empty state copy is visible
 *  - Active sprint exists → Close button enabled
 *  - Already-planned sprint → Plan-next is disabled
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprints-00000000-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sprints Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Sprints Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware channel sweep and prep FAT review.',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: 'task-fat',
  target_milestone_detail: {
    id: 'task-fat',
    name: 'FAT review',
    wbs_path: '1.4.2',
    finish: '2026-04-21',
  },
  committed_points: 47,
  committed_task_count: 18,
  completed_points: 24,
  completed_task_count: 9,
  completion_ratio_points: 0.5106,
  completion_ratio_tasks: 0.5,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const CLOSED_SPRINT = {
  ...ACTIVE_SPRINT,
  id: 'sp-closed',
  short_id_display: 'SP-A1B2',
  name: 'Mainboard bringup',
  start_date: '2026-03-01',
  finish_date: '2026-03-14',
  state: 'COMPLETED',
  closed_at: '2026-03-14T17:00:00Z',
};

const PLANNED_SPRINT = {
  ...ACTIVE_SPRINT,
  id: 'sp-planned',
  short_id_display: 'SP-D33D',
  name: 'Pilot deployment',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
  state: 'PLANNED',
  committed_points: null,
  committed_task_count: null,
  completed_points: null,
  completed_task_count: null,
  activated_at: null,
};

async function setupCommon(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

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
      body: JSON.stringify(PROJECT_DETAIL),
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
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }),
    }),
  );
  // Trailing ** so the glob also matches useCurrentUserRole's
  // /members/?self=true query (drives the SCHEDULER+ inline-edit gate).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
  // Sprints view fires queries for burndown / capacity / velocity / backlog.
  // Stub them all with empty payloads so this spec stays focused on the header.
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
        totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
        working_days: 0, hours_per_day: 8,
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
        forecast_range_low: null, forecast_range_high: null,
        rolling_avg_tasks: null, rolling_stdev_tasks: null,
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
  // #985 consolidated review read — the closed-sprint outcome the #567 selector
  // binds to when a closed timeline card is chosen.
  await page.route(/\/api\/v1\/sprints\/.*\/outcome\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprint_id: 'sp-closed',
        state: 'COMPLETED',
        provisional: false,
        outcome_recorded: true,
        name: 'Retro & cleanup',
        start_date: '2026-03-01',
        finish_date: '2026-03-14',
        closed_at: '2026-03-14T17:00:00Z',
        goal: 'Pay down telemetry debt',
        goal_outcome: 'MET',
        commitment: {
          committed_points: 30,
          committed_task_count: 10,
          completed_points: 26,
          completed_task_count: 8,
          completion_ratio_points: 0.87,
          completion_ratio_tasks: 0.8,
        },
        velocity: {
          completed_points: 26,
          velocity_delta_points: 2,
          rolling_avg_points: 25,
          burn_status: 'on_track',
          trend_points: 1,
          projected_finish_date: null,
        },
        didnt_ship: [
          {
            task_id: 't-99',
            task_short_id: 'T-99',
            task_title: 'Flaky telemetry retry',
            story_points: 4,
            final_status: 'IN_PROGRESS',
            disposition: 'carried',
            next_sprint_id: 'sp-active',
            next_sprint_name: 'Telemetry & FAT prep',
            was_pending: false,
          },
        ],
        didnt_ship_summary: {
          carried_count: 1,
          carried_points: 4,
          dropped_count: 0,
          dropped_points: 0,
        },
        retro_summary: null,
        // #924 review block — required by the SprintReviewSection (ADR-0118).
        review: {
          accepted_count: 2,
          not_accepted_count: 1,
          no_criteria_count: 0,
          accepted_points: 8,
          not_accepted_points: 3,
          shipped: [],
          demo_list: [],
          // #1129 committed-at-planning → shipped COUNT delta (required on review).
          commitment: { committed_count: 10, shipped_count: 9, carried_count: 1 },
        },
        milestone_slip: {
          milestone_id: 'm-ga',
          milestone_name: 'Telemetry GA',
          milestone_short_id: 'T-200',
          slip_days: 9,
          baseline_finish: '2026-05-01',
          forecast_finish: '2026-05-10',
          basis: 'forecast',
        },
      }),
    }),
  );
}

test.describe('Wave 10 — Sprints view header', () => {
  test('renders the active sprint header, goal card, milestone card, and timeline', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 3,
          next: null,
          previous: null,
          results: [CLOSED_SPRINT, ACTIVE_SPRINT, PLANNED_SPRINT],
        }),
      }),
    );

    await page.goto(BASE_URL);

    // Scope to the in-view breadcrumb — the global context bar (ADR-0127) also
    // renders a "Breadcrumb" nav, but it lives outside #main-content.
    await expect(
      page.locator('#main-content').getByRole('navigation', { name: /Breadcrumb/i }),
    ).toContainText('Sprints');
    await expect(
      page.getByRole('heading', { level: 1, name: /Sprint 2 — Telemetry & FAT prep/ }),
    ).toBeVisible();
    await expect(page.getByText(/Close out telemetry firmware/i)).toBeVisible();
    await expect(
      page.getByRole('region', { name: /Advancing to Milestone/i }).getByText('FAT review'),
    ).toBeVisible();

    // Timeline strip — all three cards should appear
    const cadence = page.getByRole('region', { name: /Sprint Cadence/i });
    // short_id_display is demoted off the card face into each card's accessible
    // name (#1107) — the sprint name leads visually, the id stays for SR/selector.
    await expect(cadence.getByRole('article', { name: /SP-A1B2/ })).toBeVisible();
    await expect(cadence.getByRole('article', { name: /SP-C0FF/ })).toBeVisible();
    await expect(cadence.getByRole('article', { name: /SP-D33D/ })).toBeVisible();

    // Plan next disabled because a planned sprint exists
    await expect(
      page.getByRole('button', { name: /Plan next sprint \(a planned sprint already exists\)/i }),
    ).toBeDisabled();

    // Close sprint enabled (sprint is ACTIVE)
    await expect(page.getByRole('button', { name: /Close active sprint/i })).toBeEnabled();
  });

  test('selecting a closed sprint shows its review outcome (#567)', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 3,
          next: null,
          previous: null,
          results: [CLOSED_SPRINT, ACTIVE_SPRINT, PLANNED_SPRINT],
        }),
      }),
    );
    await page.goto(BASE_URL);

    // Default selection is the ACTIVE sprint — its burndown shows, no outcome yet.
    await expect(
      page.getByRole('heading', { level: 1, name: /Telemetry & FAT prep/ }),
    ).toBeVisible();
    await expect(page.getByTestId('sprint-closed-outcome')).toHaveCount(0);

    // Click the closed sprint's timeline card → review its outcome.
    await page.getByRole('button', { name: /Review SP-A1B2/i }).click();

    const outcome = page.getByTestId('sprint-closed-outcome');
    await expect(outcome).toBeVisible();
    await expect(outcome.getByLabel(/Goal Met/i)).toBeVisible();
    const didntShip = page.getByTestId('didnt-ship');
    await expect(didntShip).toContainText('Flaky telemetry retry');
    await expect(didntShip).toContainText('→ Telemetry & FAT prep');

    // #1098: the realized milestone slip pairs the points miss with days-of-slip.
    const slipLine = page.getByTestId('milestone-slip-line');
    await expect(slipLine).toContainText('Rolled over 4 pts');
    await expect(slipLine).toContainText('Telemetry GA');
    await expect(slipLine).toContainText('+9d vs baseline');
  });

  test('edits the sprint goal inline and shows the saved banner (DA-15, #920)', async ({
    page,
  }) => {
    await setupCommon(page);

    // The e2e user is role 300 (ADMIN) per setupCommon's members mock, so the
    // inline Edit affordance renders. The list route reflects the latest goal.
    let goal = ACTIVE_SPRINT.goal;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [{ ...ACTIVE_SPRINT, goal }],
        }),
      }),
    );
    await page.route('**/api/v1/sprints/sp-active/', (route) => {
      if (route.request().method() === 'PATCH') {
        goal = (route.request().postDataJSON() as { goal: string }).goal;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...ACTIVE_SPRINT, goal }),
      });
    });

    await page.goto(BASE_URL);

    const goalCard = page.getByRole('region', { name: /Sprint Goal/i });
    await expect(goalCard.getByText(/Close out telemetry firmware/i)).toBeVisible();

    await goalCard.getByRole('button', { name: /^Edit$/ }).click();
    const textarea = goalCard.getByRole('textbox');
    await expect(textarea).toBeVisible();
    await expect(goalCard.getByText(/Describes an outcome, not a checklist/)).toBeVisible();

    await textarea.fill('Telemetry failover is proven live end to end for the FAT demo.');
    await goalCard.getByRole('button', { name: /Save goal/ }).click();

    // Returns to the banner with the new goal; the editor is gone.
    await expect(goalCard.getByText(/proven live end to end/i)).toBeVisible();
    await expect(goalCard.getByRole('textbox')).toHaveCount(0);
  });

  test('schedule deep-link points at the milestone task hash', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [ACTIVE_SPRINT],
        }),
      }),
    );

    await page.goto(BASE_URL);
    const link = page.getByRole('link', { name: /Open in Schedule view/i });
    await expect(link).toHaveAttribute('href', `/projects/${PROJECT_ID}/schedule#task-task-fat`);
  });

  test('shows empty state when the project has no sprints', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );

    await page.goto(BASE_URL);
    await expect(page.getByText(/No sprints yet/i)).toBeVisible();
    await expect(page.getByText(/Plan your first sprint/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Close sprint/i })).toBeDisabled();
  });
});

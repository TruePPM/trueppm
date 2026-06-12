/**
 * Wave D — Sprint Review polish E2E (#1129/#1130/#1131/#1132/#1133).
 *
 * Drives the CLOSED-sprint review surface (SprintClosedOutcome) bound to
 * GET /sprints/{id}/outcome/. Verifies:
 *   - #1129 committed → shipped count line (always visible)
 *   - #1133 renamed labels ("criteria incomplete" / "criteria not set")
 *   - #1130 demo presenter input
 *   - #1132 flag-for-backlog one-tap action
 *
 * Mock-only — no backend. The user is role 300 (Member) so demo/note/flag
 * curation controls are present.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-review-00000000-0000-0000-0000-0000000000d4';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;
const SPRINT_ID = 'sp-closed';

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Review Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const CLOSED_SPRINT = {
  id: SPRINT_ID,
  server_version: 1,
  short_id: 'C1',
  short_id_display: 'SP-C1',
  name: 'Closed sprint',
  goal: 'Ship the wedge',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'COMPLETED',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 20,
  committed_task_count: 6,
  completed_points: 13,
  completed_task_count: 4,
  completion_ratio_points: 0.65,
  completion_ratio_tasks: 0.67,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: '2026-04-14T00:00:00Z',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-14T00:00:00Z',
};

function shippedStory(over: Record<string, unknown> = {}) {
  return {
    outcome_id: 'o-accepted',
    task_id: 't-accepted',
    task_short_id: 'T-300',
    task_title: 'Checkout flow',
    story_points: 8,
    acceptance: { met: 3, total: 3 },
    unmet_criteria: [],
    review_note: '',
    flagged_to_backlog: false,
    demo_ready: true,
    demo_order: 1,
    presenter: '',
    ...over,
  };
}

const OUTCOME = {
  sprint_id: SPRINT_ID,
  state: 'COMPLETED',
  provisional: false,
  outcome_recorded: true,
  name: 'Closed sprint',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  closed_at: '2026-04-14T00:00:00Z',
  goal: 'Ship the wedge',
  goal_outcome: 'PARTIAL',
  commitment: {
    committed_points: 20,
    committed_task_count: 6,
    completed_points: 13,
    completed_task_count: 4,
    completion_ratio_points: 0.65,
    completion_ratio_tasks: 0.67,
  },
  velocity: {
    completed_points: 13,
    velocity_delta_points: -2,
    rolling_avg_points: 15,
    burn_status: 'behind',
    trend_points: -3,
    projected_finish_date: null,
  },
  didnt_ship: [],
  didnt_ship_summary: { carried_count: 2, carried_points: 7, dropped_count: 0, dropped_points: 0 },
  retro_summary: null,
  review: {
    accepted_count: 1,
    not_accepted_count: 1,
    no_criteria_count: 1,
    accepted_points: 8,
    not_accepted_points: 5,
    shipped: [
      shippedStory(),
      shippedStory({
        outcome_id: 'o-incomplete',
        task_id: 't-incomplete',
        task_short_id: 'T-301',
        task_title: 'Payment retries',
        story_points: 5,
        acceptance: { met: 1, total: 2 },
        unmet_criteria: [{ id: 'ac-9', text: 'Handles declined card' }],
        demo_ready: false,
        demo_order: 0,
      }),
      shippedStory({
        outcome_id: 'o-notset',
        task_id: 't-notset',
        task_short_id: 'T-302',
        task_title: 'Receipt email',
        story_points: 2,
        acceptance: { met: 0, total: 0 },
        unmet_criteria: [],
        demo_ready: false,
        demo_order: 0,
      }),
    ],
    demo_list: ['T-300'],
    commitment: { committed_count: 6, shipped_count: 3, carried_count: 2 },
  },
  milestone_slip: null,
};

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill(json({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill(json(PROJECT_DETAIL)),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill(json({ count: 1, next: null, previous: null, results: [CLOSED_SPRINT] })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/outcome\//, (route) => route.fulfill(json(OUTCOME)));
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill(json({ sprint: CLOSED_SPRINT, snapshots: [] })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill(
      json({
        members: [],
        totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
        working_days: 0,
        hours_per_day: 8,
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
      }),
    ),
  );
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) => route.fulfill(json([])));
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
  await page.route('**/api/v1/edition/', (route) => route.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill(
      json({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill(json([{ id: 'mem-1', role: 300 }])),
  );
  // Curation writes — echo success.
  await page.route(/\/api\/v1\/sprint-task-outcomes\/.*\/set-presenter\//, (route) => {
    const b = route.request().postDataJSON() as { presenter: string };
    return route.fulfill(json({ id: 'o-accepted', presenter: b.presenter }));
  });
  await page.route(/\/api\/v1\/sprint-task-outcomes\/.*\/flag-for-backlog\//, (route) =>
    route.fulfill(json({ id: 'o-notset', flagged_to_backlog: true, task_id: 'new-backlog-task' })),
  );
}

test.describe('Wave D — Sprint Review polish', () => {
  test('#1129/#1133: shows the committed→shipped line and renamed coverage labels', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const sec = page.getByTestId('sprint-review');
    await expect(sec).toBeVisible();

    // #1129 — committed → shipped, carried-over line (always visible).
    const line = page.getByTestId('review-commitment-line');
    await expect(line).toContainText('6');
    await expect(line).toContainText('committed');
    await expect(line).toContainText('shipped');
    await expect(line).toContainText('carried over');

    // #1133 — renamed labels, no legacy copy.
    await expect(sec).toContainText('criteria incomplete');
    await expect(sec).toContainText('criteria not set');
    await expect(sec).not.toContainText('not accepted');
    await expect(sec).not.toContainText('no criteria');
  });

  test('#1130: a curator can set a demo presenter', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const input = page.getByLabel('Presenter');
    await expect(input).toBeVisible();
    const req = page.waitForRequest(
      (r) => r.url().includes('/set-presenter/') && r.method() === 'POST',
    );
    await input.fill('Alex');
    await input.blur();
    await req;
  });

  test('#1132: one-tap flag-for-backlog on a criteria-not-set story', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    const buttons = page.getByRole('button', { name: /Flag for backlog/i });
    await expect(buttons.first()).toBeVisible();
    const req = page.waitForRequest(
      (r) => r.url().includes('/flag-for-backlog/') && r.method() === 'POST',
    );
    await buttons.first().click();
    await req;
  });
});

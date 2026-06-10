/**
 * Sprint planning surface E2E (#495 + #864 + #865 + #866, ADR-0094 §1).
 *
 * Golden path: selecting a PLANNED sprint renders the unified planning surface —
 * the bridge banner (draft goal ↔ advancing milestone with predecessor count),
 * the capacity preflight points chip + footer band, and the incoming-carryover
 * preview — all on one screen.
 *
 * Empty state: a planned sprint with no points ceiling and nothing rolling
 * forward omits the points chip and the carryover card (no empty shells).
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-planning-00000000-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Planning Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

const PLANNED_SPRINT = {
  id: 'sp-planned',
  server_version: 1,
  short_id: 'D33D',
  short_id_display: 'SP-D33D',
  name: 'Pilot deployment',
  goal: 'Pilot the deployment runbook end to end so the FAT demo is unblocked.',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
  state: 'PLANNED',
  target_milestone: 'task-fat',
  target_milestone_detail: {
    id: 'task-fat',
    name: 'FAT review',
    wbs_path: '1.4.2',
    finish: '2026-04-21',
    predecessor_ids: ['task-pred-1'],
    rollup: null,
  },
  capacity_points: 24,
  committed_points: null,
  committed_task_count: null,
  completed_points: null,
  completed_task_count: null,
  activated_at: null,
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const BACKLOG_TASKS = [
  {
    id: 'task-pred-1',
    short_id_display: 'T-1',
    name: 'Calibrate sensors',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 18,
    is_critical: false,
    assignments: [{ resource_id: 'r1', resource_name: 'Aisha Khan', units: 1 }],
  },
];

const INCOMING_CARRYOVER = {
  prior_sprint: {
    id: 'sp-prev',
    short_id_display: 'SP-PREV',
    name: 'Sprint 11',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
  },
  tasks: [
    { id: 't-9', short_id: 'T-9', name: 'Flaky telemetry retry', story_points: 3, pulled_in_to_current: true },
    { id: null, short_id: 'T-8', name: 'Deferred calibration', story_points: 5, pulled_in_to_current: false },
  ],
};

const EMPTY_CAPACITY = {
  members: [],
  totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
  working_days: 10,
  hours_per_day: 8,
};

async function setup(
  page: import('@playwright/test').Page,
  opts: {
    sprint?: typeof PLANNED_SPRINT;
    carryover?: typeof INCOMING_CARRYOVER | { prior_sprint: null; tasks: [] };
  } = {},
) {
  const sprint = opts.sprint ?? PLANNED_SPRINT;
  const carryover = opts.carryover ?? INCOMING_CARRYOVER;

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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0,
        critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null,
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [sprint] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_CAPACITY) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/incoming_carryover\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(carryover) }),
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
  // Sprint-scoped backlog tasks (the planned backlog + draft-points numerator).
  await page.route(/\/api\/v1\/tasks\/\?.*sprint=sp-planned/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: BACKLOG_TASKS.length, next: null, previous: null, results: BACKLOG_TASKS }),
    }),
  );
  // Any other task / retro / carryover-action queries → empty.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route(/\/api\/v1\/projects\/.*\/retrospective\/carryover\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

test.describe('Sprint planning surface (#495)', () => {
  test('renders the unified planning surface for a planned sprint', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);

    // Bridge banner — draft goal next to the advancing milestone (#866).
    await expect(page.getByText(/Planning bridge/i)).toBeVisible();
    const goalCard = page.getByRole('region', { name: /Draft sprint goal/i });
    await expect(goalCard.getByText(/Pilot the deployment runbook/i)).toBeVisible();

    const milestone = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(milestone.getByText('FAT review')).toBeVisible();
    await expect(milestone.getByText(/predecessor task land in this sprint/i)).toContainText('1 of 1');

    // Capacity preflight points chip + footer (#864): 18 of 24 → 75%, 6 free.
    const capacity = page.getByRole('region', { name: /Capacity Preflight/i });
    await expect(capacity.getByText('18/24 pts · 75%')).toBeVisible();
    await expect(capacity.getByText('Team is at 75% of capacity. 6 pts free.')).toBeVisible();

    // Incoming-carryover preview (#865): two prior unfinished, 3 pts pulled in.
    const carryover = page.getByRole('region', { name: /Carry over from SP-PREV/i });
    await expect(carryover.getByText('2 tasks')).toBeVisible();
    await expect(carryover.getByText('Flaky telemetry retry')).toBeVisible();
    await expect(carryover.getByText(/3\s*pts rolled into\s*SP-D33D/)).toBeVisible();
  });

  test('omits the points chip and carryover card when there is nothing to show', async ({ page }) => {
    await setup(page, {
      sprint: { ...PLANNED_SPRINT, capacity_points: null },
      carryover: { prior_sprint: null, tasks: [] },
    });
    await page.goto(BASE_URL);

    await expect(page.getByText(/Planning bridge/i)).toBeVisible();
    // No points ceiling → no chip / footer band.
    await expect(page.getByText(/pts ·/)).toHaveCount(0);
    await expect(page.getByText(/of capacity/)).toHaveCount(0);
    // Nothing rolled forward → carryover card suppressed entirely.
    await expect(page.getByRole('region', { name: /Carry over from/i })).toHaveCount(0);
  });
});

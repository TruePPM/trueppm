/**
 * Sprint → milestone rollup E2E (ADR-0074 / issue #409).
 *
 * Verifies that the AdvancingToMilestoneCard on the SprintsView renders the
 * rolled-up percent, rollup basis, variance chip, and scope-change indicator
 * the way the server payload encodes them. Driven entirely off the server
 * response shape so a regression in any of the surfaces would surface here.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-mrollup-00000000-0000-0000-0000-000000000074';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Milestone Rollup Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  ...FIXTURE_PROJECTS[0],
  server_version: 1,
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
};

interface RollupShape {
  percent_complete: number | null;
  rollup_basis: 'points' | 'tasks' | 'none';
  variance_days: number | null;
  sprint_scope_changed: boolean;
  sprint_count: number;
}

function makeSprint(rollup: RollupShape, scopeChanged = false): object {
  return {
    id: 'sp-active',
    server_version: 1,
    short_id: 'C0FF',
    short_id_display: 'SP-C0FF',
    name: 'Telemetry & FAT prep',
    goal: 'Close out telemetry firmware channel sweep and prep FAT review.',
    notes: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'ACTIVE',
    target_milestone: 'task-fat',
    target_milestone_detail: {
      id: 'task-fat',
      name: 'FAT review',
      wbs_path: '1.4.2',
      finish: '2026-04-21',
      rollup: {
        ...rollup,
        sprint_scope_changed: scopeChanged,
        scope_change_sprint_id: scopeChanged ? 'sp-active' : null,
      },
    },
    capacity_points: 40,
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
}

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

  // Catch-all returns 404 for unmocked endpoints. Register FIRST so
  // more-specific routes registered below win. Without this, unmocked
  // requests proxy to the dev backend, fail, and trigger the global
  // session-expired dialog under test.
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
        id: 'e2e-user', username: 'e2e', display_name: 'E2E',
        initials: 'E', email: 'e2e@example.com',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300 }]),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: makeSprint(BASELINE_ROLLUP), snapshots: [] }),
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
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"detail":"None"}',
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
}

const BASELINE_ROLLUP: RollupShape = {
  percent_complete: 73,
  rollup_basis: 'points',
  variance_days: 3,
  sprint_scope_changed: false,
  sprint_count: 1,
};

/**
 * Minimal `/tasks/` payload carrying the milestone task with its CPM
 * `is_critical` / `total_float` fields (#551). The AdvancingToMilestoneCard
 * joins this from useScheduleTasks to annotate the variance chip. Overriding
 * the empty `/tasks/` route from setupCommon (last-registered route wins).
 */
async function mockMilestoneTask(
  page: import('@playwright/test').Page,
  cpm: { is_critical: boolean; total_float: number | null },
) {
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'task-fat',
            wbs_path: '1.4.2',
            name: 'FAT review',
            early_start: '2026-04-21',
            early_finish: '2026-04-21',
            planned_start: null,
            duration: 0,
            percent_complete: 0,
            status: 'NOT_STARTED',
            is_milestone: true,
            is_summary: false,
            parent_id: null,
            actual_start: null,
            actual_finish: null,
            schedule_variance_days: null,
            baseline_start: null,
            baseline_finish: null,
            late_finish: null,
            optimistic_duration: null,
            most_likely_duration: null,
            pessimistic_duration: null,
            estimate_status: null,
            ...cpm,
          },
        ],
      }),
    }),
  );
}

test.describe('Sprint → milestone rollup card (ADR-0074)', () => {
  test('renders the rolled-up percent + "by points" basis + +3d slip variance', async ({
    page,
  }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [makeSprint(BASELINE_ROLLUP)],
        }),
      }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('FAT review')).toBeVisible();
    await expect(card.getByText('73%')).toBeVisible();
    await expect(card.getByText(/by points/i)).toBeVisible();
    await expect(card.getByLabel(/Sprint plan: \+3d slip/i)).toBeVisible();
  });

  test('annotates the variance chip with "critical path" when the milestone is critical (#551)', async ({
    page,
  }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [makeSprint(BASELINE_ROLLUP)],
        }),
      }),
    );
    await mockMilestoneTask(page, { is_critical: true, total_float: 0 });

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Critical override: red chip + "critical path" suffix regardless of slip.
    await expect(card.getByText(/\+3d slip · critical path/)).toBeVisible();
  });

  test('annotates the variance chip with remaining float when off the critical path (#551)', async ({
    page,
  }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [makeSprint(BASELINE_ROLLUP)],
        }),
      }),
    );
    await mockMilestoneTask(page, { is_critical: false, total_float: 8 });

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Slip within float → amber chip annotated with "8d float".
    await expect(card.getByText(/\+3d slip · 8d float/)).toBeVisible();
  });

  test('persistent scope-changed chip opens the audit drawer (#550)', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [makeSprint(BASELINE_ROLLUP, /* scopeChanged */ true)],
        }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/sp-active\/scope-changes\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          summary: { points_added: 5, points_removed: 0, added_mid_sprint_count: 1, total: 1 },
          events: [
            {
              id: 'ev-1',
              item_name: 'Late telemetry fix',
              story_points: 5,
              added_by_name: 'Sam Rivera',
              added_at: '2026-04-08T10:00:00Z',
              goal_impact: false,
              status: 'accepted',
            },
          ],
        }),
      }),
    );
    // The changes-log now also reads duration-events (ADR-0151, issue 1254).
    await page.route(/\/api\/v1\/sprints\/sp-active\/duration-events\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [] }),
      }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Persistent, visible chip (no hover needed) — then click → audit drawer.
    const chip = card.getByRole('button', { name: /Scope changed/i });
    await expect(chip).toBeVisible();
    await chip.click();

    const drawer = page.getByRole('dialog', { name: /Scope changes/i });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Late telemetry fix')).toBeVisible();
    await expect(drawer.getByText('Sam Rivera', { exact: false })).toBeVisible();
  });

  test('falls back to "by tasks" when rollup_basis is tasks', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            makeSprint({
              percent_complete: 70,
              rollup_basis: 'tasks',
              variance_days: 0,
              sprint_scope_changed: false,
              sprint_count: 1,
            }),
          ],
        }),
      }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('70%')).toBeVisible();
    await expect(card.getByText(/by tasks/i)).toBeVisible();
  });

  test('suppresses the rollup block entirely when basis is "none"', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            makeSprint({
              percent_complete: null,
              rollup_basis: 'none',
              variance_days: null,
              sprint_scope_changed: false,
              sprint_count: 0,
            }),
          ],
        }),
      }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Card still renders the milestone identity, but the rollup block is suppressed.
    await expect(card.getByText('FAT review')).toBeVisible();
    await expect(card.getByText(/by points/i)).not.toBeVisible();
    await expect(card.getByText(/by tasks/i)).not.toBeVisible();
  });

  test('hybrid-bridge proof (#730): co-locates velocity vs CPM finish + the since-close delta', async ({
    page,
  }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [makeSprint(BASELINE_ROLLUP)],
        }),
      }),
    );
    // The bridge region reads /forecast/. A velocity_band snapshot with a prior
    // snapshot exercises the velocity-estimate read (web-rule 166 — no percentile)
    // AND the delta-since-last-close chip. Registered after setupCommon so it wins
    // over the catch-all (Playwright matches routes most-recent-first).
    await page.route(`**/api/v1/projects/${PROJECT_ID}/forecast/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          velocity: { sprints: [], rolling_avg_points: 25, forecast_range_low: 20, forecast_range_high: 30 },
          remaining_committed_points: 34,
          sprints_to_complete_low: 2,
          sprints_to_complete_high: 3,
          milestones: [
            {
              id: 'fs-1',
              milestone_id: 'task-fat',
              milestone_name: 'FAT review',
              basis: 'velocity_band',
              cpm_finish: '2026-04-21',
              p50: '2026-04-24',
              p80: '2026-05-02',
              velocity_low: 24,
              velocity_high: 32,
              confidence: 'medium',
              unmodeled_dependency: false,
              taken_at: '2026-06-01T00:00:00Z',
              previous: {
                cpm_finish: '2026-04-18',
                p50: '2026-04-20',
                p80: '2026-04-28',
                velocity_low: 24,
                velocity_high: 32,
                basis: 'velocity_band',
                confidence: 'medium',
                taken_at: '2026-05-20T00:00:00Z',
              },
              previous_sprint_name: 'Sprint 6',
            },
          ],
        }),
      }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });

    const bridge = card.getByTestId('milestone-bridge-forecast');
    await expect(bridge).toBeVisible();
    // CPM finish (deterministic, exact) beside the velocity estimate (web-rule 166).
    await expect(bridge.getByText('Schedule (CPM)')).toBeVisible();
    await expect(bridge.getByText('Velocity estimate', { exact: true })).toBeVisible();
    await expect(bridge.getByText(/est\./)).toBeVisible();
    await expect(bridge.getByText(/\(velocity estimate\)/)).toBeVisible();
    // A velocity_band snapshot must NOT borrow percentile vocabulary.
    await expect(bridge.getByText(/P80/)).toHaveCount(0);
    // Delta-since-last-close, attributed to the closing sprint, direction in words.
    await expect(bridge.getByText(/\+3d later/)).toBeVisible();
    await expect(bridge.getByText(/since Sprint 6/)).toBeVisible();
    // "If velocity holds" projection.
    await expect(bridge.getByText(/If velocity holds, ~2–3 more sprints to clear 34 pts\./)).toBeVisible();
  });
});

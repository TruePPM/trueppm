/**
 * Promote-to-milestone dialog E2E (DA-02 / ADR-0106 §2).
 *
 * Drives the promote affordance on the AdvancingToMilestoneCard empty state:
 * an active sprint with no bound milestone shows "Promote to milestone", which
 * opens the dialog. Covers the golden create+bind path and the server-error
 * state. The 409 already-bound path and the responsive collapse are covered by
 * the component unit spec (PromoteMilestoneDialog.test.tsx); they are not
 * reachable from this empty-state opener (the card only shows it when unbound).
 */
import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-promote-0000-0000-0000-000000000106';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Bridge Promote Test',
    description: '',
    start_date: '2026-06-01',
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

/** An ACTIVE sprint with NO bound milestone — the promote entry point. */
function unboundSprint(): object {
  return {
    id: 'sp-active',
    server_version: 1,
    short_id: 'C0DE',
    short_id_display: 'SP-12',
    name: 'Telemetry & FAT prep',
    goal: 'Close out telemetry firmware channel sweep and prep FAT review.',
    notes: '',
    start_date: '2026-06-16',
    finish_date: '2026-06-27',
    state: 'ACTIVE',
    target_milestone: null,
    target_milestone_detail: null,
    capacity_points: 34,
    committed_points: 34,
    committed_task_count: 8,
    completed_points: 10,
    completed_task_count: 3,
    completion_ratio_points: 0.29,
    completion_ratio_tasks: 0.38,
    activated_at: '2026-06-16T00:00:00Z',
    closed_at: null,
    created_at: '2026-06-10T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  };
}

async function setupCommon(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // 404 for anything unmocked so requests never proxy to the dev backend.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
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
  // role 300 (ADMIN) → clears the SCHEDULER gate on the promote affordance.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: unboundSprint(), snapshots: [] }) }),
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
        rolling_avg_tasks: null, rolling_stdev_tasks: null, team_velocity_per_day: null,
      }),
    }),
  );
  // Dialog candidate source (and schedule) — empty list is fine for create mode.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(/\/api\/v1\/dependencies\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [unboundSprint()] }),
    }),
  );
}

test.describe('Promote to milestone (DA-02 / ADR-0106)', () => {
  test('golden path — promote opens the dialog and create+bind posts the empty body', async ({
    page,
  }) => {
    await setupCommon(page);

    let promoteBody: unknown = undefined;
    await page.route('**/api/v1/sprints/*/promote-to-milestone/', (route) => {
      promoteBody = route.request().postDataJSON();
      const bound = {
        ...unboundSprint(),
        target_milestone: 'task-new',
        target_milestone_detail: { id: 'task-new', name: 'FAT review', wbs_path: '1.3.1', finish: '2026-06-27' },
      };
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(bound) });
    });

    await page.goto(BASE_URL);

    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: /Promote to milestone/i }).click();

    const dialog = page.getByRole('dialog', { name: /Promote sprint to milestone/i });
    await expect(dialog).toBeVisible();
    // create mode is the default; the new milestone preview shows the sprint goal + finish
    await expect(dialog.getByText(/Close out telemetry firmware/i)).toBeVisible();
    await expect(dialog.getByText(/Jun 27/)).toBeVisible();

    await dialog.getByRole('button', { name: /Create & bind/i }).click();

    // Dialog closes on success; the POST carried the empty create body (ADR §2).
    await expect(dialog).toBeHidden();
    expect(promoteBody === null || JSON.stringify(promoteBody) === '{}').toBeTruthy();
  });

  test('error state — a failed bind keeps the dialog open with an alert', async ({ page }) => {
    await setupCommon(page);
    await page.route('**/api/v1/sprints/*/promote-to-milestone/', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"boom"}' }),
    );

    await page.goto(BASE_URL);
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.getByRole('button', { name: /Promote to milestone/i }).click();

    const dialog = page.getByRole('dialog', { name: /Promote sprint to milestone/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Create & bind/i }).click();

    await expect(dialog.getByRole('alert')).toContainText(/update the milestone binding/i);
    await expect(dialog).toBeVisible();
  });
});

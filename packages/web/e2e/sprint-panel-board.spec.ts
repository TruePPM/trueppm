/**
 * Board sprint-panel E2E (#482 / ADR-0073).
 *
 * Verifies the SprintPanel rendered at the top of /projects/:id/board is
 * visible when an ACTIVE sprint exists on an AGILE project, that the
 * header band carries the goal + dates, and that SCHEDULER+ users can
 * collapse and re-expand the body (persisted to localStorage).
 */
import { test, expect } from '@playwright/test';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-spp-00000000-0000-0000-0000-000000000020';
const BASE_URL = `/projects/${PROJECT_ID}/board`;

const PROJECT_FIXTURE = {
  id: PROJECT_ID,
  name: 'Sprint Panel E2E',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  agile_features: true,
  methodology: 'AGILE' as const,
};

const PROJECT_DETAIL = {
  ...PROJECT_FIXTURE,
  server_version: 1,
  calendar: null,
  estimation_mode: 'open',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'BEEF',
  short_id_display: 'SP-BEEF',
  name: 'Iteration 14',
  goal: 'Land the new sprint panel on the Board',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: 40,
  wip_limit: 5,
  wip_count: 3,
  committed_points: 42,
  committed_task_count: 9,
  completed_points: 18,
  completed_task_count: 4,
  completion_ratio_points: 0.4286,
  completion_ratio_tasks: 0.444,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

async function setupSprintRoutes(
  page: import('@playwright/test').Page,
  options: { methodology?: 'AGILE' | 'WATERFALL' | 'HYBRID' } = {},
) {
  const detail = { ...PROJECT_DETAIL, methodology: options.methodology ?? 'AGILE' };
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [{ ...PROJECT_FIXTURE, methodology: detail.methodology }],
    projectId: PROJECT_ID,
    tasks: [],
    members: [{ id: 'mem-1', role: 200 }],
  });
  // Override the project detail so the methodology fixture is applied.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(detail),
    }),
  );
  // useCurrentUserRole expects an array — setupApiMocks's `?self=true`
  // branch returns a bare object. Override to return SCHEDULER as a
  // single-row array.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('self') === 'true') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-1', role: 200 }]),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 200 }]),
    });
  });
  // Note: setupApiMocks registers `**/projects/${id}/sprints/**` returning an
  // empty list. We re-register the same pattern AFTER so Playwright picks ours
  // (last-registered wins). Use the same `**` glob, not a stricter trailing-
  // slash pattern.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
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
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }),
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
        team_velocity_per_day: null,
      }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"detail":"None"}',
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
}

test.describe('Board sprint panel (#482 / ADR-0073)', () => {
  test('renders header band with goal and dates for an active sprint', async ({
    page,
  }) => {
    await setupSprintRoutes(page);
    await page.goto(BASE_URL);
    const panel = page.getByRole('region', { name: /active sprint summary/i });
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByText('SP-BEEF')).toBeVisible();
    await expect(
      panel.getByText('Land the new sprint panel on the Board'),
    ).toBeVisible();
  });

  test('expanded by default for SCHEDULER+ and collapse persists across reload', async ({
    page,
  }) => {
    await setupSprintRoutes(page);
    await page.goto(BASE_URL);
    const panel = page.getByRole('region', { name: /active sprint summary/i });
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const collapseBtn = panel.getByRole('button', {
      name: /collapse sprint panel/i,
    });
    await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    await collapseBtn.click();
    await expect(
      panel.getByRole('button', { name: /expand sprint panel/i }),
    ).toHaveAttribute('aria-expanded', 'false');

    await page.reload();
    const panelAfter = page.getByRole('region', { name: /active sprint summary/i });
    await expect(panelAfter).toBeVisible({ timeout: 10_000 });
    await expect(
      panelAfter.getByRole('button', { name: /expand sprint panel/i }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  test('surfaces the WIP chip and flips it to at-risk when over the limit (#546)', async ({
    page,
  }) => {
    await setupSprintRoutes(page);
    // Re-register the sprints route last (last-wins) with an over-limit sprint.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [{ ...ACTIVE_SPRINT, wip_limit: 4, wip_count: 6 }],
        }),
      }),
    );
    await page.goto(BASE_URL);
    const panel = page.getByRole('region', { name: /active sprint summary/i });
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const chip = panel.getByTestId('sprint-wip-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/WIP\s*6\/4/);
    await expect(chip).toHaveAttribute('aria-label', /over limit/i);
  });

  test('hidden entirely for WATERFALL projects', async ({ page }) => {
    await setupSprintRoutes(page, { methodology: 'WATERFALL' });
    await page.goto(BASE_URL);
    // Wait for the board to render before asserting the panel's absence.
    await expect(
      page.getByRole('toolbar', { name: 'Board toolbar' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('region', { name: /active sprint summary/i }),
    ).toHaveCount(0);
  });
});

/**
 * E2E for the Sprints view task-create keyboard shortcut (#2162).
 *
 * The view-local ⌘K/Ctrl+K binding collided with the always-mounted global
 * command palette (#1557), stacking two focus-trapped overlays on one keystroke.
 * It was rebound to a single `c`. This spec asserts both halves of the fix:
 *   - ⌘K opens ONLY the command palette (no stacked task-create modal);
 *   - `c` opens the task-create modal targeted at the active sprint, without
 *     also opening the palette.
 *
 * Uses the standard clean fixture stack (setupAuth + setupApiMocks +
 * setupCatchAll) so the shell boots past the #911 bootstrap refresh and the
 * WS ticket is mocked — no spurious "session expired" modal to race the
 * keystroke. Sprint object-endpoints are mocked explicitly because the
 * catch-all returns a list shape that those object payloads would crash on.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-sprint-cshort-0000-0000-0000-000000002162';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Shortcut Sprint Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    agile_features: true,
    methodology: 'AGILE',
  },
];

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'C0FF',
  short_id_display: 'SP-C0FF',
  name: 'Telemetry & FAT prep',
  goal: 'Close out telemetry firmware sweep.',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  exclude_from_velocity: false,
  committed_points: 40,
  committed_task_count: 18,
  completed_points: 14,
  completed_task_count: 6,
  completion_ratio_points: 0.35,
  completion_ratio_tasks: 0.33,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const jsonRoute = (body: unknown) => (route: import('@playwright/test').Route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page: Page): Promise<void> {
  // Catch-all first, then the specific mocks (Playwright: last match wins).
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID });

  // Sprint list — a single ACTIVE sprint, so SprintsView selects it and the
  // `c` shortcut has a target.
  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/sprints/`,
    jsonRoute({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
  );
  // Object-shaped endpoints the sprint surface reads — the catch-all's list
  // shape would crash their consumers (the object-endpoint rule).
  await page.route(
    `**/api/v1/projects/${PROJECT_ID}/velocity/`,
    jsonRoute({
      sprints: [],
      rolling_avg_points: null,
      rolling_stdev_points: null,
      forecast_range_low: null,
      forecast_range_high: null,
      rolling_avg_tasks: null,
      rolling_stdev_tasks: null,
    }),
  );
  await page.route(
    /\/api\/v1\/sprints\/.*\/capacity\//,
    jsonRoute({
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
  );
  await page.route(
    /\/api\/v1\/sprints\/.*\/burndown\//,
    jsonRoute({ sprint: ACTIVE_SPRINT, snapshots: [] }),
  );
  await page.route(
    /\/api\/v1\/sprints\/.*\/incoming_carryover\//,
    jsonRoute({ prior_sprint: null, tasks: [] }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
}

/** The active-sprint surface is up once its name heading paints. */
async function expectSprintSurface(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /Telemetry & FAT prep/i })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Sprints view task-create shortcut (#2162)', () => {
  test('⌘K opens only the command palette — no stacked task-create modal', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);
    await expectSprintSurface(page);

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    // The old view-local ⌘K also opened the task-create modal; it must not stack.
    await expect(page.getByRole('dialog', { name: /add task/i })).toHaveCount(0);
  });

  test('"c" opens the task-create modal targeted at the active sprint', async ({ page }) => {
    await setup(page);
    await page.goto(BASE_URL);
    await expectSprintSurface(page);

    // Single-key, non-colliding create shortcut. Blur first so focus is on a
    // neutral element (the shortcut yields while typing in a field).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press('c');
    await expect(page.getByRole('dialog', { name: /add task/i })).toBeVisible();
    // It does not also open the palette — the two bindings no longer collide.
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  });
});

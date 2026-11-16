/**
 * Schedule load vs WebSocket invalidations E2E (#4655).
 *
 * A whole-project Schedule load takes seconds. Remote events that arrive while it
 * runs used to invalidate `['tasks', projectId]`, cancelling the load and starting
 * a second overlapping one. They must instead collapse into at most ONE follow-up
 * load, and the in-flight load must not be cancelled. The task list is served
 * slowly so the events deterministically land mid-load.
 */
import { test, expect, type WebSocketRoute } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-loadcollapse-0000-0000-0000-000000004655';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;
const SLOW_MS = 1500;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Load Collapse Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'lc1',
    wbs_path: '1',
    name: 'Slow task',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Schedule load collapses WS invalidations (#4655)', () => {
  test('several events during one load cause at most one extra full load', async ({ page }) => {
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
      socket = ws;
    });

    await setupAuth(page, { accessToken: 'e2e-ws-token' });
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
      statusSummary: { task_count: 1 },
    });

    // Registered after setupApiMocks, so it wins for the task LIST reads only.
    let listLoads = 0;
    await page.route(/\/api\/v1\/tasks\/\?/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      // Only the Schedule's own keyset walk: other consumers page the list differently.
      if (route.request().url().includes('pagination=keyset')) listLoads += 1;
      await new Promise((r) => setTimeout(r, SLOW_MS));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: FIXTURE_TASKS.length,
          next: null,
          previous: null,
          results: FIXTURE_TASKS,
        }),
      });
    });

    await page.goto(BASE_URL);
    await expect.poll(() => listLoads, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => socket !== undefined, { timeout: 10_000 }).toBe(true);

    // Five events, spread across the slow first load.
    for (let i = 0; i < 5; i++) {
      socket!.send(
        JSON.stringify({ event_type: 'dependency_created', payload: { id: `dep-${i}` } }),
      );
      await page.waitForTimeout(150);
    }
    expect(listLoads).toBe(1); // the in-flight load was not cancelled or stacked

    await expect(page.locator('[role="listbox"][aria-label="Schedule chart"]')).toBeVisible({
      timeout: 15_000,
    });
    // Let any follow-up load finish, then confirm no further ones appear.
    await page.waitForTimeout(SLOW_MS * 2 + 1000);
    expect(listLoads).toBeLessThanOrEqual(2);
  });
});

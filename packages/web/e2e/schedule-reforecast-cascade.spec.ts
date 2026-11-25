/**
 * A CPM cascade reaches the reforecast panel for rows this user never wrote
 * (#3041, #3160).
 *
 * The reducer, the wiring seam (`useProjectWebSocket`), the panel and the copy are
 * each covered at the vitest layer. What only a real page proves is the whole
 * path: a `task_dates_updated` frame arrives on the socket, the handler hands the
 * reducer the PRE-splice value as `previous`, a `cascade` entry opens, and the
 * "What moved and why" panel names the rows and their driver.
 *
 * No PATCH is sent at all — the session never writes these rows, which is the
 * whole claim. Without `previous` on the handler's observations a row with no open
 * local preview is skipped, so the panel never appears: that is what the spec's
 * discriminating assertions rest on.
 *
 * The tasks list mock is stateful for the same reason as in
 * `schedule-reconcile-markers.spec.ts`: the list serves the moved dates once the
 * frame has been sent, as a real server would. A stateless mock would re-serve the
 * old dates on the next 2 s refetch.
 */
import { test, expect, type WebSocketRoute } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-casc-00000000-0000-0000-0000-000000003160';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Cascade Project',
    description: '',
    start_date: '2026-09-01',
    calendar: 'default',
  },
];

function task(over: Record<string, unknown>) {
  return {
    wbs_path: '1',
    name: 'Task',
    early_start: '2026-09-01',
    early_finish: '2026-09-04',
    planned_start: '2026-09-01',
    duration: 4,
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
    ...over,
  };
}

/** Design -> Build -> Ship, all finish-to-start. Design is the only root cause. */
const BEFORE = {
  design: { start: '2026-09-01', finish: '2026-09-04' },
  build: { start: '2026-09-07', finish: '2026-09-11' },
  ship: { start: '2026-09-14', finish: '2026-09-18' },
};
/** The same three after a one-week slip: every start and finish moved. */
const AFTER = {
  design: { start: '2026-09-08', finish: '2026-09-11' },
  build: { start: '2026-09-14', finish: '2026-09-18' },
  ship: { start: '2026-09-21', finish: '2026-09-25' },
};

function rows(dates: typeof BEFORE) {
  return [
    task({
      id: 'c-design',
      wbs_path: '1',
      name: 'Design',
      early_start: dates.design.start,
      early_finish: dates.design.finish,
      planned_start: dates.design.start,
    }),
    task({
      id: 'c-build',
      wbs_path: '2',
      name: 'Build',
      duration: 5,
      predecessor_count: 1,
      early_start: dates.build.start,
      early_finish: dates.build.finish,
      planned_start: dates.build.start,
    }),
    task({
      id: 'c-ship',
      wbs_path: '3',
      name: 'Ship',
      duration: 5,
      predecessor_count: 1,
      early_start: dates.ship.start,
      early_finish: dates.ship.finish,
      planned_start: dates.ship.start,
    }),
  ];
}

const DEPENDENCIES = [
  {
    id: 'd1',
    predecessor: 'c-design',
    successor: 'c-build',
    dep_type: 'FS',
    lag: 0,
    is_critical: false,
  },
  {
    id: 'd2',
    predecessor: 'c-build',
    successor: 'c-ship',
    dep_type: 'FS',
    lag: 0,
    is_critical: false,
  },
];

/** A full `TaskDatesDelta` row — a partial one splices `undefined` into the bar geometry. */
function delta(id: string, d: { start: string; finish: string }, duration: number) {
  return {
    id,
    early_start: d.start,
    early_finish: d.finish,
    late_start: d.start,
    late_finish: d.finish,
    total_float: 0,
    free_float: 0,
    is_critical: true,
    planned_start: d.start,
    duration,
  };
}

async function setupMovedAfterFrame(page: import('@playwright/test').Page) {
  const state = { moved: false };
  await page.route('**/api/v1/tasks/**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET' && req.url().includes('/tasks/')) {
      const results = rows(state.moved ? AFTER : BEFORE);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
      });
      return;
    }
    await route.fallback();
  });
  return state;
}

test.describe('Reforecast panel — cascade onto untouched rows (#3160)', () => {
  test('a CPM frame for rows this session never wrote fills the panel, names the driver, and is announced', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECT_ID,
      tasks: rows(BEFORE),
      dependencies: DEPENDENCIES,
    });
    // Registered last so it wins — Playwright route precedence is reverse order.
    const state = await setupMovedAfterFrame(page);

    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
      socket = ws;
    });

    await page.goto(BASE_URL);
    await expect(page.getByText('Design', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'What moved and why' })).toHaveCount(0);
    await expect.poll(() => socket !== undefined, { timeout: 10_000 }).toBe(true);
    if (!socket) throw new Error('expected the project WebSocket to have connected');

    state.moved = true;
    socket.send(
      JSON.stringify({
        protocol_version: 1,
        event_type: 'task_dates_updated',
        payload: {
          count: 3,
          tasks: [
            delta('c-design', AFTER.design, 4),
            delta('c-build', AFTER.build, 5),
            delta('c-ship', AFTER.ship, 5),
          ],
        },
        seq: null,
      }),
    );

    const panel = page.getByRole('region', { name: 'What moved and why' });
    await expect(panel).toBeVisible();

    // Every row is one the session never wrote, and each is listed.
    const items = panel.getByRole('listitem');
    await expect(items).toHaveCount(3);
    // The driver is named: Design moved on its own, the rest are consequences.
    // Causes first, so the order itself is the causal chain.
    await expect(items.nth(0)).toHaveText(/^Design\s*changed on its own$/);
    await expect(items.nth(1)).toHaveText(/^Build\s*moved because Design moved$/);
    await expect(items.nth(2)).toHaveText(/^Ship\s*moved because Build moved$/);

    // Start and finish of each of the three rows: 6 dates, none of them this session's own write.
    await expect(page.getByTestId('reconcile-live')).toHaveText(
      /Schedule recomputed\. 6 dates changed\./,
    );
    // The chip counts only the planner's OWN unconfirmed edits, and there are none.
    await expect(page.getByTestId('reconcile-count')).toHaveCount(0);
  });
});

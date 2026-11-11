/**
 * E2E: WebSocket event replay handshake (ADR-0236, #321).
 *
 * Proves the client half of the replay contract in a real browser:
 *   1. The first connect carries NO `since` param (a fresh client relies on the
 *      REST load for current state).
 *   2. After processing a persisted event (one carrying a `seq`), a reconnect
 *      re-opens the socket with `?…&since=<highest seq>` so the server replays
 *      only the missed events.
 *   3. A `resync_required` frame is handled without tearing the app down.
 *
 * The server side is intercepted with page.routeWebSocket, mirroring
 * connection-status.spec.ts — the exact sequence-tracking logic is unit-tested
 * in useProjectWebSocket.test.ts; this spec locks the on-the-wire URL contract.
 */
import { test, expect, type WebSocketRoute } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const FIXTURE_PROJECT_ID = 'e2e-ws-00000000-0000-0000-0000-000000000321';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Replay Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'w1',
    wbs_path: '1',
    name: 'Alpha Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page, { accessToken: 'e2e-ws-token' });
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 1 },
  });
  // The persisted task_updated this spec pushes makes the client read that one row
  // back (GET /tasks/w1/, #2341); the default stateless route would answer it with
  // a list shape the schema guard rightly rejects.
  await setupTaskStore(page, { tasks: FIXTURE_TASKS });
}

test.describe('WebSocket event replay (#321)', () => {
  test('reconnect carries &since after a persisted event; resync is handled', async ({ page }) => {
    const urls: string[] = [];
    let firstSocket: WebSocketRoute | undefined;
    let connectCount = 0;

    await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
      connectCount += 1;
      urls.push(ws.url());
      if (connectCount === 1) {
        firstSocket = ws;
        // Push a persisted (seq-bearing) mutation so the client advances its
        // replay cursor to 1.
        void ws.send(
          JSON.stringify({
            protocol_version: 1,
            event_type: 'task_updated',
            payload: { id: 'w1', changed_fields: ['status'], version: 2, actor_id: 'other' },
            seq: 1,
          }),
        );
      } else {
        // On the reconnect, replay a missed event then a resync_required — the
        // app must apply/handle both without crashing.
        void ws.send(
          JSON.stringify({
            protocol_version: 1,
            event_type: 'task_created',
            payload: { id: 'w2' },
            seq: 2,
            replayed: true,
          }),
        );
        void ws.send(
          JSON.stringify({
            protocol_version: 1,
            event_type: 'resync_required',
            payload: { latest_seq: 2 },
            seq: null,
          }),
        );
      }
    });

    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const statusBar = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(statusBar).toContainText('Live', { timeout: 10_000 });

    // First connect must not request replay.
    expect(urls[0]).toContain('ticket=');
    expect(urls[0]).not.toContain('since=');

    // Drop the live socket → the hook reconnects.
    if (!firstSocket) throw new Error('expected the project WebSocket to have connected');
    await firstSocket.close();

    // The reconnect must request replay from the highest processed sequence.
    await expect.poll(() => connectCount, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
    expect(urls[1]).toContain('since=1');

    // The app survived the replayed event + resync_required frame.
    await expect(page.getByRole('contentinfo', { name: 'Application status' })).toBeVisible();
  });

  test('a remote plain-field task_updated splices one row via GET /tasks/{id}/ and does not re-list (#2341)', async ({
    page,
  }) => {
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
      socket = ws;
    });
    await setup(page);

    let listGets = 0;
    let detailGets = 0;
    // Registered after setupTaskStore, so it wins for the detail path only.
    await page.route(/\/api\/v1\/tasks\/w1\/(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      detailGets += 1;
      expect(new URL(route.request().url()).searchParams.get('project')).toBe(FIXTURE_PROJECT_ID);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_TASKS[0], name: 'Renamed Remotely', server_version: 3 }),
      });
    });
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/api\/v1\/tasks\/(\?|$)/.test(req.url())) listGets += 1;
    });

    await page.goto(`${BASE_URL}/schedule`);
    await expect(page.getByRole('contentinfo', { name: 'Application status' })).toContainText(
      'Live',
      { timeout: 10_000 },
    );
    await expect(page.getByText('Alpha Phase').first()).toBeVisible();
    const listBefore = listGets;

    if (!socket) throw new Error('expected the project WebSocket to have connected');
    socket.send(
      JSON.stringify({
        protocol_version: 1,
        event_type: 'task_updated',
        payload: { id: 'w1', changed_fields: ['name'], version: 3, actor_id: 'other' },
        seq: 1,
      }),
    );

    await expect(page.getByText('Renamed Remotely').first()).toBeVisible({ timeout: 10_000 });
    expect(detailGets).toBe(1);
    // Past the 300 ms invalidate debounce: a full refetch would have fired by now.
    await page.waitForTimeout(800);
    expect(listGets).toBe(listBefore);
  });
});

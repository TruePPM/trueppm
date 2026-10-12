/**
 * E2E: StatusBar WebSocket connection pill (#643).
 *
 * Intercepts the project WebSocket with page.routeWebSocket so the connection
 * lifecycle is deterministic: the first connection is accepted (→ "Live"), then
 * the server side is closed and reconnects are refused, so the pill must change
 * to a degraded state ("Reconnecting…" → "Connection lost"). This proves the
 * hook → wsConnectionStore → StatusBar wiring in a real browser; the exact
 * state transitions are unit-tested in wsConnectionStore.test.ts.
 */
import { test, expect, type WebSocketRoute } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-ws-00000000-0000-0000-0000-000000000643';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Connection Status Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'w1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 50, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(
  page: import('@playwright/test').Page,
  projectOverrides: Record<string, unknown> = {},
) {
  // The project WebSocket only connects when an access token is in memory
  // (#897 moved it out of localStorage). All API calls here are route-mocked,
  // so the lazy 401→refresh that normally re-mints the token never fires —
  // seed one explicitly so the connection can go Live.
  await setupAuth(page, { accessToken: 'e2e-ws-token' });
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS.map((p) => ({ ...p, ...projectOverrides })),
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 1 },
  });
}

test.describe('StatusBar connection pill (#643)', () => {
  test('goes Live on connect, then degrades when the socket drops', async ({ page }) => {
    let firstSocket: WebSocketRoute | undefined;
    let connectCount = 0;

    // Accept the first connection (client fires `open` → live); refuse every
    // reconnect so the pill escalates instead of bouncing back to Live.
    await page.routeWebSocket('**/ws/v1/projects/**', async (ws) => {
      connectCount += 1;
      if (connectCount === 1) {
        firstSocket = ws;
      } else {
        await ws.close();
      }
    });

    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const statusBar = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(statusBar).toContainText('Live', { timeout: 10_000 });

    // Simulate the server dropping the live connection.
    const socket = firstSocket;
    if (!socket) throw new Error('expected the project WebSocket to have connected');
    await socket.close();

    // The pill must stop claiming "Live" and surface a degraded state.
    await expect(statusBar).toContainText(/Reconnecting…|Connection lost/, { timeout: 12_000 });
    await expect(statusBar).not.toContainText('Live');
  });

  // #4375 — the server refuses below-Member roles. Before the fix the client did
  // not know, retried every ≤30 s forever (a ticket mint + handshake each time),
  // ran the 30 s full-schedule fallback poll, and showed "Connection lost".
  test('a Viewer never dials the socket, keeps the schedule, and does not poll at 30 s', async ({
    page,
  }) => {
    await page.clock.install();
    let socketAttempts = 0;
    await page.routeWebSocket('**/ws/v1/projects/**', async (ws) => {
      socketAttempts += 1;
      await ws.close({ code: 4003 });
    });
    let ticketPosts = 0;
    let taskReads = 0;
    page.on('request', (req) => {
      const url = req.url();
      if (req.method() === 'POST' && url.includes('/api/v1/ws/ticket/')) ticketPosts += 1;
      if (req.method() === 'GET' && /\/api\/v1\/tasks\/(\?|$)/.test(url)) taskReads += 1;
    });

    await setup(page, { can_subscribe_live: false, my_role: 1 });
    await page.goto(`${BASE_URL}/schedule`);

    const statusBar = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(page.getByText('Alpha Phase').first()).toBeVisible({ timeout: 10_000 });
    await expect(statusBar).toContainText('No live updates');
    const readsAfterLoad = taskReads;
    // Guard against a vacuous count: the pattern must have matched the initial load.
    expect(readsAfterLoad).toBeGreaterThan(0);

    // Two of the old 30 s fallback windows, and two of the old 30 s backoff caps.
    await page.clock.runFor(60_000);

    await expect(page.getByText('Alpha Phase').first()).toBeVisible();
    await expect(statusBar).toContainText('No live updates');
    await expect(statusBar).not.toContainText(/Connection lost|Reconnecting|Disconnected/);
    expect(ticketPosts).toBe(0);
    expect(socketAttempts).toBe(0);
    expect(taskReads).toBe(readsAfterLoad);
  });

  test('a 4003 refusal on connect is terminal: refused, and no reconnect', async ({ page }) => {
    await page.clock.install();
    let socketAttempts = 0;
    // Verdict unknown/true but the server refuses anyway (e.g. demoted between the
    // project read and the dial, or evicted later): accept-then-close 4003.
    await page.routeWebSocket('**/ws/v1/projects/**', async (ws) => {
      socketAttempts += 1;
      await ws.close({ code: 4003 });
    });
    let ticketPosts = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/api/v1/ws/ticket/')) ticketPosts += 1;
    });

    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const statusBar = page.getByRole('contentinfo', { name: 'Application status' });
    await expect(statusBar).toContainText('No live updates', { timeout: 10_000 });
    const attemptsAfterRefusal = socketAttempts;
    const ticketsAfterRefusal = ticketPosts;
    expect(attemptsAfterRefusal).toBeGreaterThanOrEqual(1);

    await page.clock.runFor(60_000);

    expect(socketAttempts).toBe(attemptsAfterRefusal);
    expect(ticketPosts).toBe(ticketsAfterRefusal);
    await expect(statusBar).toContainText('No live updates');
  });
});

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
import { test, expect, type WebSocketRoute } from '@playwright/test';
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

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
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
    await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
      connectCount += 1;
      if (connectCount === 1) {
        firstSocket = ws;
      } else {
        ws.close();
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
});

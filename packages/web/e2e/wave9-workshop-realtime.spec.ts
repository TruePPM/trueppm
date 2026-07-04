/**
 * Wave 9 — Board Workshop mode realtime collaboration E2E (#1311, ADR-0046).
 *
 * The workshop start/end lifecycle (toggle → banner → End → confirm/cancel) is
 * covered by `wave9-workshop.spec.ts`. This spec covers the *realtime* layer —
 * the `useWorkshopSocket` channel and the live-collaboration banner — which is
 * where workshop mode earns its value:
 *
 *   Golden path
 *     - Socket opens when the session becomes active.
 *     - A participant_joined frame refreshes the banner's participant strip
 *       (join → "1 online" + avatar); a participant_left frame clears it.
 *     - The elapsed timer actually increments once per second while live.
 *   Error / lifecycle path
 *     - A mid-session socket drop degrades gracefully: the board and banner
 *       stay mounted (no error-boundary teardown) and the hook reconnects.
 *
 * WebSocket mocking reuses the `page.routeWebSocket` pattern established by
 * `connection-status.spec.ts`: the board opens two sockets (the general project
 * board channel and, in workshop mode, the workshop channel), both matching
 * `**​/ws/v1/projects/**`. A single route handler branches on the URL —
 * accepting the general channel silently and capturing the `/workshop/` channel
 * so the test can push frames and simulate a drop. Participant presence is
 * driven the way production drives it: a socket frame invalidates the
 * `workshopSession` query, which refetches `GET /workshop/current/`, so the
 * mock returns a mutable participant list that the frames toggle.
 */
import { test, expect, type WebSocketRoute } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import type { WorkshopParticipant } from '../src/types';

const PROJECT_ID = 'e2e-workshop-rt-0000-0000-0000-000000001311';
const BASE_URL = `/projects/${PROJECT_ID}`;
const SESSION_ID = 'ws-rt-session-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Workshop Realtime Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'wrt1', wbs_path: '1', name: 'Discovery Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
  {
    id: 'wrt2', wbs_path: '1.1', name: 'Frame the problem',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    duration: 10, percent_complete: 60, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'wrt1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
];

const PARTICIPANT_BOB: WorkshopParticipant = {
  id: 2,
  user_id: 'user-bob-0000',
  display_name: 'Bob Builder',
  joined_at: new Date().toISOString(),
  left_at: null,
  color_index: 3,
};

/** Mutable server-state closure shared by the HTTP mocks and the WS harness. */
interface Harness {
  /** The captured `/workshop/` WebSocketRoute (undefined until it connects). */
  workshopSocket(): WebSocketRoute | undefined;
  /** How many times the workshop channel has (re)connected. */
  connectCount(): number;
  /** Overwrite the participant list the next `workshop/current/` refetch returns. */
  setParticipants(next: WorkshopParticipant[]): void;
}

/**
 * Register auth, API mocks, and the WebSocket route handler. The workshop
 * session HTTP endpoints are backed by mutable closure state so a socket frame
 * (which invalidates the session query) can surface a fresh participant list.
 */
async function setup(page: import('@playwright/test').Page): Promise<Harness> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 2 },
    overview: { total_tasks: 2 },
  });

  let sessionActive = false;
  let participants: WorkshopParticipant[] = [];
  const activeSession = () => ({
    id: SESSION_ID,
    project_id: PROJECT_ID,
    started_by_id: 'e2e-user',
    started_at: new Date().toISOString(),
    ended_at: null,
    participants,
  });

  // POST start → session becomes active with an (initially empty) roster.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
    sessionActive = true;
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(activeSession()),
    });
  });
  // GET current → the live roster; the socket-driven invalidate refetches this.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (sessionActive) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(activeSession()),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'No active session.' }),
    });
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/end/`, (route) => {
    sessionActive = false;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...activeSession(), ended_at: new Date().toISOString() }),
    });
  });

  // The board opens the general project channel on mount and the workshop
  // channel once a session is active — both match this glob. Accept the general
  // one silently (mock mode) and capture the workshop one so the test can push
  // frames and simulate a drop. Reassigned on every (re)connect.
  let workshopSocket: WebSocketRoute | undefined;
  let connectCount = 0;
  await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
    if (ws.url().includes('/workshop/')) {
      workshopSocket = ws;
      connectCount += 1;
    }
    // General channel: no connectToServer() → Playwright keeps it in mock mode
    // (client sees `open`), which is all the StatusBar pill needs. No frames.
  });

  return {
    workshopSocket: () => workshopSocket,
    connectCount: () => connectCount,
    setParticipants: (next) => {
      participants = next;
    },
  };
}

/**
 * Open the More⋯ overflow popover, click Start workshop session, then dismiss
 * the popover so it doesn't intercept later clicks. Mirrors the helper in
 * `wave9-workshop.spec.ts`.
 */
async function startWorkshop(page: import('@playwright/test').Page) {
  const moreButton = page.getByRole('button', { name: /more board controls/i });
  await moreButton.click();
  await page.getByRole('button', { name: /start workshop session/i }).click();
  await moreButton.click();
}

test.describe('Workshop mode — realtime collaboration', () => {
  test('participant join/leave frames sync to the banner over the workshop socket', async ({
    page,
  }) => {
    const harness = await setup(page);

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Discovery Phase')).toBeVisible({ timeout: 10_000 });

    await startWorkshop(page);

    // Banner mounts once the session is active, and the workshop socket opens.
    const banner = page.getByRole('status', { name: /workshop/i });
    await expect(banner).toBeVisible();
    await expect.poll(() => Boolean(harness.workshopSocket()), { timeout: 10_000 }).toBe(true);

    // No participants yet — the "N online" indicator is suppressed at zero.
    await expect(banner.getByText(/online/i)).toHaveCount(0);

    // Participant B joins: flip the roster the refetch will return, THEN push the
    // frame (production order — the frame only triggers a refetch, it carries no
    // roster). The banner must reflect the new participant.
    harness.setParticipants([PARTICIPANT_BOB]);
    await harness.workshopSocket()!.send(JSON.stringify({ event_type: 'participant_joined' }));

    await expect(banner.getByText('1 online')).toBeVisible({ timeout: 10_000 });
    await expect(banner.locator('[title="Bob Builder"]')).toBeVisible();

    // Participant B leaves: roster row gains a left_at, so the active count drops
    // to zero and the indicator disappears again.
    harness.setParticipants([{ ...PARTICIPANT_BOB, left_at: new Date().toISOString() }]);
    await harness.workshopSocket()!.send(JSON.stringify({ event_type: 'participant_left' }));

    await expect(banner.getByText(/online/i)).toHaveCount(0, { timeout: 10_000 });
  });

  test('elapsed session timer increments while the workshop is live', async ({ page }) => {
    await setup(page);

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Discovery Phase')).toBeVisible({ timeout: 10_000 });

    await startWorkshop(page);

    const banner = page.getByRole('status', { name: /workshop/i });
    await expect(banner).toBeVisible();

    // The timer span exposes its live value on aria-label ("Session elapsed
    // time: 0:00"). It ticks once per second via setInterval, so the label must
    // change within a couple of seconds.
    const timer = banner.getByLabel(/session elapsed time/i);
    const initial = await timer.getAttribute('aria-label');
    expect(initial).toMatch(/session elapsed time:/i);
    await expect
      .poll(() => timer.getAttribute('aria-label'), { timeout: 5_000 })
      .not.toBe(initial);
  });

  test('a mid-session socket drop keeps the board alive and reconnects', async ({ page }) => {
    const harness = await setup(page);

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Discovery Phase')).toBeVisible({ timeout: 10_000 });

    await startWorkshop(page);

    const banner = page.getByRole('status', { name: /workshop/i });
    await expect(banner).toBeVisible();
    await expect.poll(() => Boolean(harness.workshopSocket()), { timeout: 10_000 }).toBe(true);
    expect(harness.connectCount()).toBe(1);

    // Server drops the workshop channel mid-session.
    await harness.workshopSocket()!.close();

    // Graceful degradation: the board and banner stay mounted — the drop must not
    // trip the root error boundary or unmount the workshop UI.
    await expect(banner).toBeVisible();
    await expect(page.getByText('Discovery Phase')).toBeVisible();

    // The hook backs off (1s) and reconnects the channel.
    await expect
      .poll(() => harness.connectCount(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);

    // Board is still intact after the reconnect.
    await expect(banner).toBeVisible();
    await expect(page.getByText('Discovery Phase')).toBeVisible();
  });
});

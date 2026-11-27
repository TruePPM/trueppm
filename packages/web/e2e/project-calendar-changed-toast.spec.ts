import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * project_calendar_changed names the editor (#3245).
 *
 * A shared-calendar edit reschedules every project bound to it, including ones whose
 * own members did nothing. The broadcast carries the editor's label so a viewer sees
 * a name instead of dates moving by themselves; the editor's own echo is silent.
 * Mounted on Project Settings because any route under the project shell opens the
 * project socket.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-calchg-00000000-0000-0000-0000-000000003245';

const FIXTURE_ME = {
  can_access_admin_settings: true,
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Orion',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300, // ADMIN
  role_label: 'Project Admin',
};

const FIXTURE_LABEL = {
  id: 'label-bug',
  name: 'bug',
  color: 'rose',
  position: 0,
  server_version: 1,
  task_count: 3,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);

  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([ADMIN_MEMBERSHIP]) }),
  );
}

async function openLive(page: Page) {
  await setup(page);
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: [FIXTURE_LABEL], count: 1, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/ws/ticket/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'e2e-ticket', expires_in: 30 }),
    }),
  );
  let socket: import('@playwright/test').WebSocketRoute | null = null;
  await page.routeWebSocket('**/ws/v1/projects/**', (ws) => {
    socket = ws;
  });
  await page.goto(`/projects/${PROJECT_ID}/settings#labels`);
  await expect(
    page.getByRole('region', { name: 'Labels', exact: true }).getByTestId('label-row-label-bug'),
  ).toBeVisible();
  await expect(page.getByRole('contentinfo', { name: 'Application status' })).toContainText(
    'Live',
    { timeout: 10_000 },
  );
  if (!socket) throw new Error('expected the project WebSocket to have connected');
  // Each frame needs a fresh seq: the client's seq gate drops a repeated one as a replay.
  let seq = 0;
  return (payload: Record<string, unknown>) =>
    (socket as import('@playwright/test').WebSocketRoute).send(
      JSON.stringify({
        protocol_version: 1,
        event_type: 'project_calendar_changed',
        payload,
        seq: ++seq,
      }),
    );
}

const NOTICE = "Dana Ortiz changed this project's working-time calendar. Dates may move.";

test.describe('project_calendar_changed names the editor (#3245)', () => {
  test("a peer's shared-calendar edit shows a notice naming them", async ({ page }) => {
    const send = await openLive(page);
    send({ id: PROJECT_ID, actor: 'Dana Ortiz', actor_id: '42' });
    await expect(page.getByRole('status').getByText(NOTICE)).toBeVisible();
  });

  test("the editor's own echo shows no notice", async ({ page }) => {
    const send = await openLive(page);
    send({ id: PROJECT_ID, actor: 'Alice', actor_id: ME_ID });
    // A later, distinguishable notice proves the socket delivered both frames, so the
    // absence of the first is not just a frame that never arrived.
    send({ id: PROJECT_ID, actor: 'Dana Ortiz', actor_id: '42' });
    await expect(page.getByRole('status').getByText(NOTICE)).toBeVisible();
    await expect(page.getByText(/^Alice changed this project/)).toHaveCount(0);
  });
});

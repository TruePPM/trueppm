import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Labels (#1089).
 *
 * Golden path: the label catalog renders from GET /projects/:id/labels/.
 * Error path (#3542): a failed GET must read as broken, not as "No labels
 * yet" — `labels` defaults to `[]` on error, which otherwise reads
 * identically to a genuinely empty catalog.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-labels-00000000-0000-0000-0000-000000001089';

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

test.describe('Project Settings → Labels (#1089)', () => {
  test('golden path — renders the label catalog from the API', async ({ page }) => {
    await setup(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [FIXTURE_LABEL], count: 1, next: null, previous: null }),
      }),
    );

    await page.goto(`/projects/${PROJECT_ID}/settings#labels`);

    const labels = page.getByRole('region', { name: 'Labels', exact: true });
    await expect(labels.getByTestId('label-row-label-bug')).toBeVisible();
  });

  // Before the fix, `labels` defaulted to `[]` on a failed GET, which read
  // identically to "No labels yet" — a lie on a 500, not a stall, but the
  // user still had no error and no way forward.
  test('a failed labels GET surfaces Retry, not "No labels yet"', async ({ page }) => {
    await setup(page);
    let serverRecovered = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (r) => {
      // The query client retries a failed GET once before settling into
      // `isError` (src/lib/queryClient.ts).
      if (!serverRecovered) {
        return r.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'boom' }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [FIXTURE_LABEL], count: 1, next: null, previous: null }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/settings#labels`);

    const labels = page.getByRole('region', { name: 'Labels', exact: true });
    await expect(labels.getByText("Couldn't load labels.")).toBeVisible();
    await expect(labels.getByText(/No labels yet/i)).not.toBeVisible();

    serverRecovered = true;
    await labels.getByRole('button', { name: 'Retry' }).click();
    await expect(labels.getByTestId('label-row-label-bug')).toBeVisible();
  });

  // #2847: label_created/updated/deleted were broadcast to nobody, so a peer's
  // new label never reached this open catalog until a reload. The list mock is
  // stateful — the broadcast below is the only thing that can make the client
  // read the second row.
  test("a peer's label_created reaches the open catalog without a reload", async ({ page }) => {
    await setup(page);
    let catalog = [FIXTURE_LABEL];
    await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: catalog,
          count: catalog.length,
          next: null,
          previous: null,
        }),
      }),
    );
    // Mint the WS ticket so the project socket can open (ADR-0141) —
    // setupCatchAll() would otherwise 404 it and the socket never goes Live.
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
    const labels = page.getByRole('region', { name: 'Labels', exact: true });
    await expect(labels.getByTestId('label-row-label-bug')).toBeVisible();
    await expect(page.getByRole('contentinfo', { name: 'Application status' })).toContainText(
      'Live',
      { timeout: 10_000 },
    );
    if (!socket) throw new Error('expected the project WebSocket to have connected');

    catalog = [
      FIXTURE_LABEL,
      { id: 'label-ux', name: 'ux', color: 'blue', position: 1, server_version: 1, task_count: 0 },
    ];
    (socket as import('@playwright/test').WebSocketRoute).send(
      JSON.stringify({
        protocol_version: 1,
        event_type: 'label_created',
        payload: { id: 'label-ux' },
        seq: 1,
      }),
    );

    await expect(labels.getByTestId('label-row-label-ux')).toBeVisible();
  });
});

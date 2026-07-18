import { test, expect } from './fixtures/coverage';

/**
 * Jira connect flow (#1421, ADR-0313) — the PAT-based, in-page wizard that fills
 * the #1420 seam on /me/settings/connected-accounts.
 *
 * There is no OAuth redirect in OSS: connecting ships the user's API token to
 * `PUT /me/connections/jira/`. The spec walks the full flow with mocked
 * endpoints: Connect → credentials → configure → connected (Active + recently
 * pulled) → Sync now → Disconnect → back to Connect.
 */

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

const FIXTURE_ME = {
  id: 'u-alice',
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const CREDENTIALS = [
  {
    provider: 'generic',
    name: 'Generic',
    exists: false,
    base_url: '',
    created_at: null,
    updated_at: null,
    last_used_at: null,
    expires_at: null,
    requires_credential: false,
  },
];

function connectionSummary(connected: boolean, lastSynced: string | null) {
  return {
    name: 'Jira',
    exists: connected,
    base_url: connected ? 'https://acme.atlassian.net' : '',
    account_email: connected ? 'alice@example.com' : '',
    status: connected ? 'connected' : 'not_connected',
    last_synced_at: lastSynced,
    jql: '',
    project_keys: [],
  };
}

const JIRA_ITEMS = {
  count: 1,
  next: null,
  previous: null,
  results: [
    {
      id: 'item-1',
      source_key: 'jira',
      external_id: 'RIV-482',
      external_url: 'https://acme.atlassian.net/browse/RIV-482',
      title: 'API gateway returns 502 under load',
      external_status: 'In progress',
      display_bucket: 'in_progress',
      last_synced_at: null,
    },
  ],
};

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          accessToken: 'e2e-token',
          refreshToken: 'e2e-refresh',
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);
  // Mutable connection state driven by the PUT / sync / DELETE handlers.
  const state = { connected: false, lastSynced: null as string | null };

  // Catch-all registered FIRST so the specific handlers below (registered later)
  // win — Playwright matches routes in reverse registration order.
  await page.route('**/api/v1/**', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );

  await page.route('**/api/v1/me/credentials/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(CREDENTIALS) }),
  );

  await page.route('**/api/v1/me/external-items/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(state.connected ? JIRA_ITEMS : { count: 0, next: null, previous: null, results: [] }),
    }),
  );

  // Trigger a pull → 202 and stamp last_synced_at so the card leaves the
  // "first sync in progress" state on the next connection read.
  await page.route('**/api/v1/me/connections/*/sync/', (route: Route) => {
    state.lastSynced = '2026-05-20T14:00:00Z';
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: pj({ queued: true }),
    });
  });

  // GET summary / PUT connect / DELETE disconnect.
  await page.route('**/api/v1/me/connections/*/', (route: Route) => {
    const method = route.request().method();
    if (method === 'PUT') {
      state.connected = true;
      state.lastSynced = null; // first sync not landed yet
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(connectionSummary(true, state.lastSynced)),
      });
    }
    if (method === 'DELETE') {
      state.connected = false;
      state.lastSynced = null;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(connectionSummary(state.connected, state.lastSynced)),
    });
  });
}

test.describe('Jira connect flow (#1421)', () => {
  test('connect → configure → connected → sync → disconnect', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    const jira = page.locator('#source-jira');
    await expect(jira.getByRole('heading', { name: 'Jira' })).toBeVisible();

    // 1 · Connect opens the PAT credential wizard (no OAuth redirect).
    await jira.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Connect Jira' })).toBeVisible();
    await expect(dialog.getByText(/Read-only access/i)).toBeVisible();

    await dialog.getByLabel('Site URL').fill('https://acme.atlassian.net');
    await dialog.getByLabel('Account email').fill('alice@example.com');
    await dialog.getByLabel('API token').fill('atlassian-api-token');
    await dialog.getByRole('button', { name: 'Continue' }).click();

    // 2 · Configure — assigned-to-me is the default; start the import.
    await expect(dialog.getByRole('button', { name: 'Start importing' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Start importing' }).click();

    // 3 · Connected — Active + linked account, and the pulled item preview.
    await expect(jira.getByText('Active', { exact: true })).toBeVisible();
    await expect(jira.getByText(/Linked as alice@example\.com/i)).toBeVisible();
    await expect(jira.getByText('RIV-482')).toBeVisible();
    await expect(
      jira.getByRole('link', { name: /Open RIV-482 in Jira/i }),
    ).toBeVisible();

    // 4 · Sync now triggers a pull and stays connected.
    await jira.getByRole('button', { name: 'Sync now' }).click();
    await expect(jira.getByText('Active', { exact: true })).toBeVisible();

    // 5 · Disconnect requires confirmation, then returns to the Connect state.
    await jira.getByRole('button', { name: 'Disconnect' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Disconnect Jira?');
    await confirm.getByRole('button', { name: 'Disconnect' }).click();

    // `exact` — a substring "Connect" also matches "Disconnect"/"Keep connected".
    await expect(jira.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await expect(jira.getByText('Active', { exact: true })).toHaveCount(0);
  });

  test('a rejected credential surfaces inline and stays on the credential step', async ({
    page,
  }) => {
    await setup(page);
    // Override the PUT to reject the credential (bad token) with the real 422 shape.
    await page.route('**/api/v1/me/connections/*/', (route: Route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'Could not verify the credential with jira.',
            code: 'source_verification_failed',
            reason: 'unauthorized',
          }),
        });
      }
      return route.fallback();
    });
    await page.goto('/me/settings/connected-accounts');

    const jira = page.locator('#source-jira');
    await jira.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Site URL').fill('https://acme.atlassian.net');
    await dialog.getByLabel('Account email').fill('alice@example.com');
    await dialog.getByLabel('API token').fill('wrong-token');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Start importing' }).click();

    // Error is surfaced and the wizard is back on the credential step.
    await expect(dialog.getByRole('alert')).toContainText(/Could not verify the credential/i);
    await expect(dialog.getByLabel('Site URL')).toBeVisible();
  });
});

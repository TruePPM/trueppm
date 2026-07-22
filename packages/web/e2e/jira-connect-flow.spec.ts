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

function connectionSummary(
  connected: boolean,
  lastSynced: string | null,
  deployment: 'cloud' | 'server' = 'cloud',
) {
  const isServer = deployment === 'server';
  return {
    name: 'Jira',
    exists: connected,
    base_url: connected
      ? isServer
        ? 'https://jira.corp.example/jira'
        : 'https://acme.atlassian.net'
      : '',
    deployment,
    // Server/DC has no account email (Bearer PAT), so it stays blank there.
    account_email: connected && !isServer ? 'alice@example.com' : '',
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
  const state = {
    connected: false,
    lastSynced: null as string | null,
    deployment: 'cloud' as 'cloud' | 'server',
  };

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
      // Echo the deployment the dialog sent so the connected card reflects the
      // right variant (Cloud shows the linked email; Server/DC does not).
      const body = (route.request().postDataJSON() ?? {}) as { deployment?: 'cloud' | 'server' };
      state.deployment = body.deployment === 'server' ? 'server' : 'cloud';
      state.connected = true;
      state.lastSynced = null; // first sync not landed yet
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(connectionSummary(true, state.lastSynced, state.deployment)),
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
      body: pj(connectionSummary(state.connected, state.lastSynced, state.deployment)),
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

  test('Server / Data Center connect uses a PAT (no email) and reaches connected', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    const jira = page.locator('#source-jira');
    await jira.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog');

    // Switch to Data Center / Server — Account email disappears, the token field
    // becomes "Personal access token", and the allow-list expectation is set.
    await dialog.getByText('Data Center / Server').click();
    await expect(dialog.getByLabel('Account email')).toHaveCount(0);
    await expect(dialog.getByText(/operator must allow-list this host/i)).toBeVisible();

    await dialog.getByLabel('Site URL').fill('https://jira.corp.example/jira');
    await dialog.getByLabel('Personal access token').fill('dc-pat-token');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Start importing' }).click();

    // Connected — Active, and the self-hosted host shown (no linked email).
    await expect(jira.getByText('Active', { exact: true })).toBeVisible();
    await expect(jira.getByText(/jira\.corp\.example\/jira/)).toBeVisible();
  });

  test('a Server host the operator has not allow-listed is rejected inline', async ({ page }) => {
    await setup(page);
    // The backend rejects a non-allow-listed self-hosted host with a 400 whose
    // detail names the operator setting (#2270 / #902). The dialog surfaces it
    // verbatim on the credential step — it is expected policy, not a bug.
    await page.route('**/api/v1/me/connections/*/', (route: Route) => {
      if (route.request().method() === 'PUT') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail:
              "Host URL 'jira.corp.example' is not an allowed host for the 'jira' provider. " +
              'A self-hosted instance must be added to TRUEPPM_INTEGRATION_ALLOWED_HOSTS by an operator.',
            code: 'base_url_not_allowed',
          }),
        });
      }
      return route.fallback();
    });
    await page.goto('/me/settings/connected-accounts');

    const jira = page.locator('#source-jira');
    await jira.getByRole('button', { name: 'Connect' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Data Center / Server').click();
    await dialog.getByLabel('Site URL').fill('https://jira.corp.example');
    await dialog.getByLabel('Personal access token').fill('dc-pat-token');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Start importing' }).click();

    // The operator-allow-list detail is surfaced and the wizard stays put.
    await expect(dialog.getByRole('alert')).toContainText(/TRUEPPM_INTEGRATION_ALLOWED_HOSTS/);
    await expect(dialog.getByLabel('Site URL')).toBeVisible();
  });
});

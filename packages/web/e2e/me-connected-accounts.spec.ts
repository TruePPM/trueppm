import { test, expect } from '@playwright/test';

/**
 * /me/settings/connected-accounts — golden path + revoke + anchor-scroll deep link.
 *
 * The page lists /api/v1/me/credentials/ rows under one section per
 * registered TASK_LINK_PROVIDERS provider, with Connect / Rotate / Revoke
 * flows inline. The encrypted PAT is never returned from the server, so
 * the spec asserts on metadata + state and stubs the upsert + revoke
 * round-trips.
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

interface CredentialRow {
  provider: string;
  name: string;
  exists: boolean;
  base_url: string;
  created_at: string | null;
  updated_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  requires_credential: boolean;
}

function defaultCredentials(): CredentialRow[] {
  return [
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
    {
      provider: 'github',
      name: 'GitHub',
      exists: false,
      base_url: '',
      created_at: null,
      updated_at: null,
      last_used_at: null,
      expires_at: null,
      requires_credential: true,
    },
    {
      provider: 'gitlab',
      name: 'GitLab',
      exists: false,
      base_url: '',
      created_at: null,
      updated_at: null,
      last_used_at: null,
      expires_at: null,
      requires_credential: true,
    },
  ];
}

interface ConnectionRow {
  name: string;
  exists: boolean;
  base_url: string;
  account_email: string;
  status: string;
  last_synced_at: string | null;
  jql: string;
  project_keys: string[];
}

function notConnected(name: string): ConnectionRow {
  return {
    name,
    exists: false,
    base_url: '',
    account_email: '',
    status: 'not_connected',
    last_synced_at: null,
    jql: '',
    project_keys: [],
  };
}

async function setup(
  page: Page,
  initial: CredentialRow[] = defaultCredentials(),
  connections: Record<string, ConnectionRow> = {},
) {
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
  let state: CredentialRow[] = JSON.parse(JSON.stringify(initial));

  // Playwright matches routes in reverse registration order, so the
  // catch-all has to be registered FIRST — otherwise it shadows the
  // specific handlers below and the credentials list comes back as `[]`.
  await page.route('**/api/v1/**', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );

  await page.route('**/api/v1/me/credentials/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(state) }),
  );

  // External task-source connection state (#1420, GET /me/connections/<source>/).
  // Registered after the catch-all so it wins (Playwright matches in reverse).
  await page.route('**/api/v1/me/connections/*/', (route: Route) => {
    const match = new URL(route.request().url()).pathname.match(/connections\/([^/]+)\//);
    const source = match ? match[1] : '';
    const body = connections[source] ?? notConnected(source);
    return route.fulfill({ status: 200, contentType: 'application/json', body: pj(body) });
  });

  await page.route('**/api/v1/me/credentials/*/', (route: Route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/credentials\/([^/]+)\//);
    const provider = match ? match[1] : '';
    const method = route.request().method();
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      const idx = state.findIndex((row) => row.provider === provider);
      if (idx >= 0) {
        state[idx] = {
          ...state[idx],
          exists: true,
          base_url: body.base_url ?? '',
          created_at: state[idx].created_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: pj(state) });
    }
    if (method === 'DELETE') {
      const idx = state.findIndex((row) => row.provider === provider);
      if (idx >= 0) {
        state[idx] = {
          ...state[idx],
          exists: false,
          base_url: '',
          created_at: null,
          updated_at: null,
          last_used_at: null,
          expires_at: null,
        };
      }
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: pj(state) });
  });
}

test.describe('Connected Accounts page', () => {
  test('lists every registered provider with Connect on the unconnected ones', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
    // Scope provider headings to the credentials list — the "Available sources"
    // section below has its own GitHub card that would otherwise collide (#1420).
    const credentials = page.getByRole('list', { name: 'Integration providers' });
    await expect(credentials.getByRole('heading', { name: 'GitLab' })).toBeVisible();
    await expect(credentials.getByRole('heading', { name: 'GitHub' })).toBeVisible();
    await expect(credentials.getByRole('heading', { name: 'Generic' })).toBeVisible();

    // GitLab + GitHub require credentials → Connect button.
    const gitlabCard = page.locator('#provider-gitlab');
    await expect(gitlabCard.getByRole('button', { name: 'Connect' })).toBeVisible();
    const githubCard = page.locator('#provider-github');
    await expect(githubCard.getByRole('button', { name: 'Connect' })).toBeVisible();

    // Generic does not — show "no credential needed" copy instead.
    const genericCard = page.locator('#provider-generic');
    await expect(genericCard.getByText(/No credential needed/i)).toBeVisible();
  });

  test('connects GitHub via the dialog and flips the section to Connected', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    const githubCard = page.locator('#provider-github');
    await githubCard.getByRole('button', { name: 'Connect' }).click();
    await page.getByLabel('Personal access token').fill('ghp-fake-e2e');
    await page.getByRole('dialog').getByRole('button', { name: 'Connect' }).click();

    // Exact match: the page also renders a "Connected:" <dt> label once
    // created_at is set, which would collide with a substring match.
    await expect(githubCard.getByText('Connected', { exact: true })).toBeVisible();
    await expect(githubCard.getByRole('button', { name: 'Rotate' })).toBeVisible();
    await expect(githubCard.getByRole('button', { name: 'Revoke' })).toBeVisible();
  });

  test('revoke requires confirmation and flips the section back to Not connected', async ({ page }) => {
    const initial = defaultCredentials();
    const githubIdx = initial.findIndex((r) => r.provider === 'github');
    initial[githubIdx] = {
      ...initial[githubIdx],
      exists: true,
      created_at: '2026-04-15T10:00:00Z',
      updated_at: '2026-04-15T10:00:00Z',
    };
    await setup(page, initial);
    await page.goto('/me/settings/connected-accounts');

    const githubCard = page.locator('#provider-github');
    await githubCard.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('Revoke GitHub credential?');

    // Keep credential should dismiss without revoking.
    await page.getByRole('button', { name: 'Keep credential' }).click();
    await expect(githubCard.getByText('Connected', { exact: true })).toBeVisible();

    // Confirm revoke this time.
    await githubCard.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(githubCard.getByText('Not connected', { exact: true })).toBeVisible();
  });

  test('deep link with #github anchor scrolls to the GitHub section', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts#github');
    const githubCard = page.locator('#provider-github');
    await expect(githubCard).toBeVisible();
    // The fragment-scroll target stays mounted; we just assert the
    // identifier resolves so a future copy-link affordance round-trips.
    await expect(githubCard).toHaveAttribute('id', 'provider-github');
  });
});

test.describe('Available sources section (#1420)', () => {
  test('lists external sources with a gated "Coming soon" affordance, no dead button', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    const section = page.getByRole('region', { name: 'Available sources' });
    await expect(section).toBeVisible();
    // Trust framing is present.
    await expect(
      page.getByRole('group', { name: /Trust guarantees/i }),
    ).toBeVisible();

    const sources = page.getByRole('list', { name: 'External task sources' });
    await expect(sources.getByRole('heading', { name: 'Jira' })).toBeVisible();
    await expect(sources.getByRole('heading', { name: 'GitHub' })).toBeVisible();

    // Jira is available-but-not-connected → an interactive Connect button (#1421).
    await expect(
      page.locator('#source-jira').getByRole('button', { name: 'Connect' }),
    ).toBeVisible();
    // GitHub is coming_soon → non-interactive "Coming soon" pill (dead-click guard).
    const github = page.locator('#source-github');
    await expect(github.getByText('Coming soon')).toBeVisible();
    await expect(github.getByRole('button')).toHaveCount(0);
    await expect(github.getByRole('link')).toHaveCount(0);
  });

  test('shows an Active state with the linked account when a source is connected', async ({
    page,
  }) => {
    await setup(page, defaultCredentials(), {
      jira: {
        name: 'Jira',
        exists: true,
        base_url: 'https://acme.atlassian.net',
        account_email: 'alice@example.com',
        status: 'connected',
        last_synced_at: '2026-05-20T14:00:00Z',
        jql: '',
        project_keys: [],
      },
    });
    await page.goto('/me/settings/connected-accounts');

    const jiraCard = page.locator('#source-jira');
    await expect(jiraCard.getByText('Active', { exact: true })).toBeVisible();
    await expect(jiraCard.getByText(/Linked as alice@example\.com/i)).toBeVisible();
  });

  test('shows a Reconnect banner when the connection is auth_failed and reopens the connect wizard (#1910)', async ({
    page,
  }) => {
    await setup(page, defaultCredentials(), {
      jira: {
        name: 'Jira',
        exists: true,
        base_url: 'https://acme.atlassian.net',
        account_email: 'alice@example.com',
        status: 'auth_failed',
        last_synced_at: '2026-05-20T14:00:00Z',
        jql: '',
        project_keys: [],
      },
    });
    await page.goto('/me/settings/connected-accounts');

    const jiraCard = page.locator('#source-jira');
    const banner = jiraCard.getByRole('status');
    await expect(banner).toContainText(/needs reauthorization/i);

    // The banner takes precedence over the staleness note — one signal, not two.
    await expect(jiraCard.getByText(/^Last synced/i)).toHaveCount(0);

    // "Reconnect" reopens the same PAT wizard used for the initial Connect.
    await jiraCard.getByRole('button', { name: 'Reconnect' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Connect Jira' })).toBeVisible();
  });

  test('shows a stale "Last synced … ago" note for an old sync with no reconnect banner (#1910)', async ({
    page,
  }) => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await setup(page, defaultCredentials(), {
      jira: {
        name: 'Jira',
        exists: true,
        base_url: 'https://acme.atlassian.net',
        account_email: 'alice@example.com',
        status: 'connected',
        last_synced_at: threeDaysAgo,
        jql: '',
        project_keys: [],
      },
    });
    await page.goto('/me/settings/connected-accounts');

    const jiraCard = page.locator('#source-jira');
    await expect(jiraCard.getByText(/^Last synced 3d ago$/)).toBeVisible();
    await expect(jiraCard.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
  });
});

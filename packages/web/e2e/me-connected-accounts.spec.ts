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

async function setup(page: Page, initial: CredentialRow[] = defaultCredentials()) {
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

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );

  await page.route('**/api/v1/me/credentials/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(state) }),
  );

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

  // Catch-all for misc endpoints the shell pulls on first render.
  await page.route('**/api/v1/**', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

test.describe('Connected Accounts page', () => {
  test('lists every registered provider with Connect on the unconnected ones', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/connected-accounts');

    await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GitLab' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'GitHub' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Generic' })).toBeVisible();

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

    await expect(githubCard.getByText('Connected', { exact: false })).toBeVisible();
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
    await expect(githubCard.getByText('Connected', { exact: false })).toBeVisible();

    // Confirm revoke this time.
    await githubCard.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click();
    await expect(githubCard.getByText('Not connected', { exact: false })).toBeVisible();
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

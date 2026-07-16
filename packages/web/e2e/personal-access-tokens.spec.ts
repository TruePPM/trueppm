import { test, expect } from '@playwright/test';

/**
 * /me/settings/api-tokens — Personal Access Tokens (#648, ADR-0214).
 *
 * The page reads the paginated /api/v1/me/api-tokens/ list and mutates it via
 * POST (one-time raw-token reveal) and DELETE (revoke). The raw token is never
 * returned again, so the golden path asserts the reveal appears once and the new
 * token lands in the list; the edge cases cover revoke and the 10-of-10 cap.
 *
 * Every endpoint the page reads is mocked with its real shape, plus /auth/me/
 * and the token-refresh route, so the data-driven route never trips the
 * session-expired modal (CLAUDE.md catch-all guidance).
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

interface TokenRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  is_revoked: boolean;
  is_expired: boolean;
}

function makeToken(name: string, overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: `tok-${name}`,
    name,
    token_prefix: 'tppm_abc',
    scopes: ['legacy:full'],
    created_at: '2026-06-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    is_revoked: false,
    is_expired: false,
    ...overrides,
  };
}

function paginate(rows: TokenRow[]): string {
  return JSON.stringify({ count: rows.length, next: null, previous: null, results: rows });
}

async function setup(page: Page, initial: TokenRow[] = []) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const state: TokenRow[] = JSON.parse(JSON.stringify(initial));

  // Catch-all FIRST (Playwright matches in reverse registration order) — a 401
  // guard so no unmocked request trips the session-expired modal. Returns a bare
  // array (iterable): the shell reads several array endpoints, and an object-shaped
  // body here makes a `[...(r ?? [])]` in the shell throw and tears down the app
  // (CLAUDE.md catch-all note). The paginated /me/api-tokens/ route below is
  // registered later, so it still wins for the page's own list read.
  await page.route('**/api/v1/**', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/auth/token/refresh/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access: 'e2e-token' }) }),
  );

  // List endpoint.
  await page.route('**/api/v1/me/api-tokens/', (route: Route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: paginate(state) });
    }
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      const row = makeToken(body.name, {
        id: `tok-${state.length + 1}`,
        token_prefix: 'tppm_new',
        expires_at: body.expires_at ?? null,
        // Echo the requested scope so the reveal picks the right panel
        // (mcp:read → McpConnectPanel; legacy:full → plain reveal).
        scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['legacy:full'],
      });
      state.push(row);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...row, token: 'tppm_the_only_reveal_0123456789abcdef' }),
      });
    }
    return route.fallback();
  });

  // Detail endpoint (revoke).
  await page.route('**/api/v1/me/api-tokens/*/', (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const url = new URL(route.request().url());
    const match = url.pathname.match(/api-tokens\/([^/]+)\//);
    const id = match ? decodeURIComponent(match[1]) : '';
    const idx = state.findIndex((row) => row.id === id);
    if (idx >= 0) {
      state[idx] = { ...state[idx], is_revoked: true, revoked_at: new Date().toISOString() };
    }
    return route.fulfill({ status: 204, body: '' });
  });
}

test.describe('Personal access tokens page', () => {
  test('golden path: create → reveal once → appears in the list', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/api-tokens');

    await expect(page.getByRole('heading', { name: 'Personal access tokens' })).toBeVisible();
    await expect(page.getByText(/No personal access tokens yet/i)).toBeVisible();

    await page.getByRole('button', { name: 'Create token' }).click();
    const dialog = page.getByRole('dialog', { name: /Create personal access token/i });
    await dialog.getByLabel('Name').fill('Power BI export');
    await dialog.getByRole('button', { name: 'Create token' }).click();

    // One-time reveal.
    await expect(page.getByText(/only time you.*see this token/i)).toBeVisible();
    await expect(page.getByLabel('New personal access token')).toHaveValue(
      'tppm_the_only_reveal_0123456789abcdef',
    );
    await page.getByRole('button', { name: 'Done' }).click();

    // The new token is now in the list.
    await expect(page.getByText('Power BI export')).toBeVisible();
  });

  test('mcp:read: choosing "Read-only for AI assistants" reveals the config snippet', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/me/settings/api-tokens');

    await expect(page.getByRole('heading', { name: 'Personal access tokens' })).toBeVisible();
    await page.getByRole('button', { name: 'Create token' }).click();
    const dialog = page.getByRole('dialog', { name: /Create personal access token/i });
    await dialog.getByLabel('Name').fill('Claude Desktop');
    await dialog.getByRole('radio', { name: /Read-only for AI assistants/i }).check();

    // mcp:read requires an expiry — pick a future date via the date input.
    await dialog.getByLabel(/Expiration/i).fill('2030-01-01');
    await dialog.getByRole('button', { name: 'Create token' }).click();

    // The reused McpConnectPanel renders the copy-paste config block with the
    // raw token and the trueppm-mcp command.
    const snippet = page.getByRole('group', { name: /claude_desktop_config\.json snippet/i });
    await expect(snippet).toBeVisible();
    await expect(snippet).toContainText('trueppm-mcp');
    await expect(snippet).toContainText('tppm_the_only_reveal_0123456789abcdef');
    await expect(page.getByRole('button', { name: 'Copy config' })).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Claude Desktop')).toBeVisible();
  });

  test('revoke: confirm removes the Revoke affordance', async ({ page }) => {
    await setup(page, [makeToken('CI token', { id: 'tok-ci' })]);
    await page.goto('/me/settings/api-tokens');

    await expect(page.getByText('CI token')).toBeVisible();
    await page.getByRole('button', { name: 'Revoke' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Revoke this token?');
    await dialog.getByRole('button', { name: 'Revoke token' }).click();

    // Row flips to Revoked and loses its Revoke button.
    await expect(page.getByText('Revoked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke' })).toHaveCount(0);
  });

  test('cap reached: Create is disabled at 10 active tokens', async ({ page }) => {
    const ten = Array.from({ length: 10 }, (_, i) => makeToken(`tok-${i}`, { id: `tok-${i}` }));
    await setup(page, ten);
    await page.goto('/me/settings/api-tokens');

    await expect(page.getByLabel('10 of 10 active tokens')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create token' })).toBeDisabled();
  });

  // #2023 — the shared personal-settings subnav renders on every /me/settings/*
  // page (previously api-tokens had none) and cross-navigates.
  test('subnav: lists all four personal-settings pages and cross-navigates', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings/api-tokens');

    const nav = page.getByRole('navigation', { name: 'Personal settings sections' });
    await expect(nav.getByRole('link', { name: 'General' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Notifications' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Connected accounts' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Personal access tokens' })).toBeVisible();

    // Client-side navigation to a sibling page (assert the URL, not the
    // destination's data render, to stay independent of that page's mocks).
    await nav.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/me\/settings\/notifications$/);
  });

  // #2023 — bare /me/settings has no page of its own; it redirects to General
  // rather than falling through to the 404 catch-all.
  test('bare /me/settings redirects to General', async ({ page }) => {
    await setup(page);
    await page.goto('/me/settings');
    await expect(page).toHaveURL(/\/me\/settings\/general$/);
  });
});

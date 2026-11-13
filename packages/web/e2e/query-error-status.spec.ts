/**
 * Status-aware read-failure state (#3874, #3621).
 *
 * A 403 on a settings read must not offer Retry (it fails identically forever);
 * a 429 must say it is throttled and retry itself; a 500 keeps the generic
 * message with Retry. Every endpoint the page reads is mocked with its real shape.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function setup(
  page: Page,
  workspaceResponse: { status: number; headers?: Record<string, string> },
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(
      json({
        id: 'u1',
        username: 'alice',
        display_name: 'Alice',
        initials: 'AL',
        email: 'alice@truescope.io',
        workspace_role: 300,
        can_access_admin_settings: true,
      }),
    ),
  );
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({
      status: workspaceResponse.status,
      headers: workspaceResponse.headers,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'refused' }),
    }),
  );
}

// The settings shell renders every workspace section on one scroll, and all of them
// read the same /workspace/ endpoint — so scope each assertion to one section.
const section = (page: Page) => page.getByLabel('Methodology defaults', { exact: true });

test.describe('QueryErrorState distinguishes why a read failed', () => {
  test('403: says access was refused and offers no Retry', async ({ page }) => {
    await setup(page, { status: 403 });
    await page.goto('/settings/methodology');
    await expect(section(page).getByText(/don't have access to this/i)).toBeVisible();
    await expect(section(page).getByRole('button', { name: /retry/i })).toHaveCount(0);
  });

  test('429: says it is throttled and offers Retry now', async ({ page }) => {
    await setup(page, { status: 429, headers: { 'retry-after': '30' } });
    await page.goto('/settings/methodology');
    await expect(section(page).getByText(/Too many requests\. Retrying in \d+s/)).toBeVisible();
    await expect(section(page).getByRole('button', { name: 'Retry now' })).toBeVisible();
  });

  test('500: keeps the generic message and Retry', async ({ page }) => {
    await setup(page, { status: 500 });
    await page.goto('/settings/methodology');
    await expect(section(page).getByText(/couldn't load workspace settings/i)).toBeVisible();
    await expect(section(page).getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

/**
 * Session-expired banner E2E (#352, escape hatch #1922).
 *
 * Verifies that a 401 from any API request, when the refresh-token call also
 * fails, surfaces the modal banner with a working "Sign in" CTA. The key
 * regression this guards against: the previous build silently dropped the
 * user onto /login with no explanation, so users could not tell that their
 * session had timed out (and any stale cache they were looking at was just
 * that — stale).
 *
 * The second test covers the read-only escape hatch (#1922): the modal was
 * previously an unescapable focus trap, so a user whose session expired could
 * not even look at content the app already had cached in memory before
 * re-authenticating. It exercises the full flow: expire → view cached content
 * → attempt a write → re-auth prompt.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-session-00000000-0000-0000-0000-000000000001';
const PROJECT = {
  id: PROJECT_ID,
  name: 'Session Escape Hatch Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
};

test.describe('Session expired banner', () => {
  test('renders the dialog when /api/v1 returns 401 with no recovery, and Sign in navigates to /login', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);

    // Every authenticated API call returns 401, including the token refresh.
    // The interceptor exhausts its single retry, calls expireSession(), and
    // the SessionExpiredBanner mounts.
    await page.route('**/api/v1/auth/token/refresh/', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.route('**/api/v1/projects/**', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );

    // Land on a real project route so the 401 fires inside AppShell
    // (where SessionExpiredBanner is mounted), not the catch-all 404.
    await page.goto('/projects/e2e-session/overview');

    const dialog = page.getByRole('dialog', { name: /Your session expired/ });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('button', { name: 'Sign in' })).toBeFocused();

    await dialog.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test('escape hatch: view cached content read-only, then a blocked write re-prompts sign-in (#1922)', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID });

    // The refresh cookie is already invalid and the write endpoint is
    // "expired" from the start — reads succeed (setupApiMocks defaults) so
    // the page loads real cached content, but the moment a write is
    // attempted it 401s, the interceptor's refresh retry also 401s, and the
    // session flips to expired.
    await page.route('**/api/v1/auth/token/refresh/', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(PROJECT),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Real cached content is on the page before anything expires.
    await expect(page.getByText(PROJECT.name).first()).toBeVisible({ timeout: 10_000 });

    // Open the "Update Status" write dialog and change the selection so
    // "Save status" is armed.
    await page.getByRole('button', { name: 'Update Status' }).click();
    const statusDialog = page.getByRole('dialog', { name: /Update project status/ });
    await expect(statusDialog).toBeVisible();
    await statusDialog.getByRole('button', { name: 'On track' }).click();

    // First save attempt is a real network round-trip: PATCH 401s, the
    // refresh retry 401s, and the session expires — surfacing the blocking
    // re-auth modal on top of the still-open status dialog.
    await statusDialog.getByRole('button', { name: 'Save status' }).click();
    const gate = page.getByRole('dialog', { name: /Your session expired/ });
    await expect(gate).toBeVisible({ timeout: 10_000 });
    await expect(gate.getByRole('button', { name: 'Sign in' })).toBeFocused();

    // Escape hatch: release the trap and keep looking at cached content.
    await gate.getByRole('button', { name: /Continue viewing/ }).click();
    await expect(gate).not.toBeVisible();

    // Scoped by accessible name — the Overview page's own "no attention
    // items" empty state also uses role="status", so an unscoped locator
    // would be a strict-mode collision.
    const readOnlyBanner = page.getByRole('status', { name: /Session expired/ });
    await expect(readOnlyBanner).toBeVisible();
    await expect(readOnlyBanner).toContainText(/viewing cached content read-only/);
    const readOnlySignIn = readOnlyBanner.getByRole('button', { name: /Sign in again/ });
    await expect(readOnlySignIn).toBeFocused();

    // Cached content is genuinely reachable now — no full-screen scrim.
    await expect(page.getByText(PROJECT.name).first()).toBeVisible();

    // Attempting another write while read-only must NOT fire an unauthenticated
    // request — the apiClient interceptor blocks it synchronously — and must
    // re-open the blocking sign-in prompt rather than failing silently or
    // looping. The status dialog is still open behind the (now-dismissed)
    // scrim with "On track" still selected, so Save is still armed.
    await statusDialog.getByRole('button', { name: 'Save status' }).click();

    await expect(gate).toBeVisible({ timeout: 10_000 });
    await expect(gate.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await expect(readOnlyBanner).not.toBeVisible();

    // From here Sign in is still the only way out.
    await gate.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

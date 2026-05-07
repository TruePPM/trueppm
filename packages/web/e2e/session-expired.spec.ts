/**
 * Session-expired banner E2E (#352).
 *
 * Verifies that a 401 from any API request, when the refresh-token call
 * also fails, surfaces the modal banner with a working "Sign in" CTA. The
 * key regression this guards against: the previous build silently dropped
 * the user onto /login with no explanation, so users could not tell that
 * their session had timed out (and any stale cache they were looking at
 * was just that — stale).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupCatchAll } from './fixtures';

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
    await expect(dialog.getByRole('button', { name: /Sign in/ })).toBeFocused();

    await dialog.getByRole('button', { name: /Sign in/ }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

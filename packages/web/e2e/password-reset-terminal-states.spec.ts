import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * Password-reset terminal screens reached by direct URL (#3549).
 *
 * `password-reset.spec.ts` reaches "sent" and "expired" only through the flow. These
 * routes are also entered cold — a refresh, a bookmark, a stale email link — so each is
 * asserted from a fresh page load: the heading and the recovery affordance. All three
 * are public and read nothing on load; the catch-all only guards against a 401 loop.
 */

test.describe('Password reset — terminal states by direct URL', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
  });

  test('/forgot-password/sent with no router state shows the generic confirmation', async ({
    page,
  }) => {
    await page.goto('/forgot-password/sent');
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    // No address survives a cold load (it rides router state, never the URL), so the copy
    // must not name one.
    await expect(page.getByText(/if an account exists for that address/i)).toBeVisible();
    await expect(page.getByText(/30 minutes/)).toBeVisible();
  });

  test('/forgot-password/sent Resend with no address returns to the request form', async ({
    page,
  }) => {
    await page.goto('/forgot-password/sent');
    await page.getByRole('button', { name: /resend/i }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  });

  test('/reset-password/done confirms success and offers sign-in', async ({ page }) => {
    await page.goto('/reset-password/done');
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expect(page.getByText(/signed out your other sessions/i)).toBeVisible();
    await page.getByRole('link', { name: 'Continue to sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('/reset-password/expired offers a new link and that link reaches the request form', async ({
    page,
  }) => {
    await page.goto('/reset-password/expired');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByText(/valid for 30 minutes/i)).toBeVisible();
    await page.getByRole('link', { name: 'Request a new link' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';

/**
 * Self-service password reset E2E (issue 765, ADR-0209).
 *
 * The five screens are public (no auth) and make no reads on load — the only
 * network calls are the POST to the request endpoint (Screen 1 / resend) and the
 * POST to the confirm endpoint (Screen 3). Each is intercepted with route mocking
 * so the flow runs against the production build with no live backend. We mock every
 * endpoint each page touches with its real response shape (never the catch-all).
 *
 * Coverage: the golden path (request → sent screen) and the expired-link screen
 * (confirm returns `invalid_token` → expired screen).
 */

const RESET_REQUEST_URL = '**/api/v1/auth/password/reset/';
const RESET_CONFIRM_URL = '**/api/v1/auth/password/reset/confirm/';

test.describe('Password reset', () => {
  test('Forgot? on the login page links to the reset flow', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  });

  test('golden path: requesting a link advances to the "check your email" screen', async ({
    page,
  }) => {
    // Request endpoint always returns 200 (no user enumeration).
    await page.route(RESET_REQUEST_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: 'If an account exists for that address, a password reset link is on its way.',
        }),
      }),
    );

    await page.goto('/forgot-password');

    // The static SSO hint is always present and never a per-account signal.
    await expect(page.getByText(/uses single sign-on/i)).toBeVisible();

    await page.getByLabel('Work email').fill('anna.khoury@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page).toHaveURL(/\/forgot-password\/sent$/);
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    // The address is shown redacted (first char + masked local part), never in full.
    await expect(page.getByText(/a•+@example\.com/)).toBeVisible();
    await expect(page.getByText(/30 minutes/)).toBeVisible();
  });

  test('expired link: confirm returning invalid_token routes to the expired screen', async ({
    page,
  }) => {
    await page.route(RESET_CONFIRM_URL, (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'invalid_token',
          detail: 'This password reset link is invalid or has expired.',
        }),
      }),
    );

    await page.goto('/reset-password/confirm/dummyuid/dummy-token');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();

    // Fill a password that satisfies the client-side requirements so the submit
    // button enables (the server is what rejects it as expired).
    const strong = 'Str0ng-Passw0rd!';
    await page.getByLabel('New password', { exact: true }).fill(strong);
    await page.getByLabel('Confirm new password').fill(strong);

    const submit = page.getByRole('button', { name: 'Update password' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page).toHaveURL(/\/reset-password\/expired$/);
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Request a new link' })).toBeVisible();
  });

  test('weak password: confirm returning weak_password shows inline messages', async ({ page }) => {
    await page.route(RESET_CONFIRM_URL, (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'weak_password',
          detail: 'Password does not meet the requirements.',
          messages: ['This password is too common.'],
        }),
      }),
    );

    await page.goto('/reset-password/confirm/dummyuid/dummy-token');
    const pw = 'Passw0rd-123!';
    await page.getByLabel('New password', { exact: true }).fill(pw);
    await page.getByLabel('Confirm new password').fill(pw);
    await page.getByRole('button', { name: 'Update password' }).click();

    // Stays on the confirm screen and surfaces the server message inline.
    await expect(page).toHaveURL(/\/reset-password\/confirm\//);
    await expect(page.getByText('This password is too common.')).toBeVisible();
  });
});

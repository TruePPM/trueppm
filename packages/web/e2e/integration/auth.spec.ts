import { test, expect } from '@playwright/test';

/**
 * Integration — Auth flow.
 *
 * Exercises the real Django auth endpoint (no mocks): login, token
 * persistence across reload, and the invalid-credentials error path.
 *
 * Credentials are provided by seed_integration_fixtures management command.
 */

const EMAIL = process.env['INTEGRATION_USER_EMAIL'] ?? 'ci@trueppm.test';
const PASSWORD = process.env['INTEGRATION_USER_PASSWORD'] ?? 'ci-integration-pw';

test.describe('Integration — Auth flow', () => {
  test('unauthenticated visit redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('valid credentials log in and redirect to app shell', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    // App shell navigation is present — confirms we are past the auth gate.
    await expect(page.getByRole('navigation', { name: 'Project list' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('tokens persist across page reload', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });

    // Real JWT tokens in localStorage should survive a hard reload.
    await page.reload();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 10_000 });
  });

  test('invalid credentials show an error and stay on /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password', { exact: true }).fill('definitely-wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    await expect(page.getByRole('alert')).toContainText('Invalid email or password', {
      timeout: 10_000,
    });
  });
});

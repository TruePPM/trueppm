import { test, expect } from '@playwright/test';

/**
 * Authentication E2E flows — login form happy path and error handling.
 *
 * These tests cover the critical "unauthenticated user can log in" flow
 * that smoke.spec.ts and gantt.spec.ts bypass by seeding localStorage.
 *
 * The auth token endpoint is intercepted with Playwright route mocking so
 * the test runs against the production build without a live Django backend.
 */

const AUTH_TOKEN_URL = '**/api/v1/auth/token/';

test.describe('Login flow', () => {
  test.beforeEach(async ({ page }) => {
    // Start from an unauthenticated state — no localStorage seed.
    await page.goto('/');
  });

  test('unauthenticated visit redirects to /login', async ({ page }) => {
    // RequireAuth should redirect any unauthenticated request to /login.
    await expect(page).toHaveURL(/\/login/, { timeout: 5_000 });
  });

  test('login page renders username and password fields', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('sign-in button is disabled with empty fields', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  test('successful login redirects to the app shell', async ({ page }) => {
    await page.route(AUTH_TOKEN_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access: 'mock-access-token', refresh: 'mock-refresh-token' }),
      }),
    );
    // Stub the projects list so the app shell can render after redirect.
    await page.route('**/api/v1/projects/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    );

    await page.goto('/login');
    await page.getByLabel('Username').fill('sarah');
    await page.getByLabel('Password').fill('correct-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Should land on the app shell (not /login).
    await expect(page).not.toHaveURL(/\/login/, { timeout: 5_000 });
    await expect(page.getByRole('navigation', { name: 'Project list' })).toBeVisible();
  });

  test('invalid credentials shows error message', async ({ page }) => {
    await page.route(AUTH_TOKEN_URL, (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
    );

    await page.goto('/login');
    await page.getByLabel('Username').fill('sarah');
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText('Invalid username or password');
    // Must stay on /login after failure.
    await expect(page).toHaveURL(/\/login/);
  });

  test('network error shows generic error message', async ({ page }) => {
    await page.route(AUTH_TOKEN_URL, (route) => route.abort('failed'));

    await page.goto('/login');
    await page.getByLabel('Username').fill('sarah');
    await page.getByLabel('Password').fill('any-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toContainText('unexpected error');
  });
});

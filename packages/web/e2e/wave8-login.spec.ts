import { test, expect } from '@playwright/test';

/**
 * Wave 8 — Login screen redesign (#215).
 *
 * Covers the two-column layout, marketing panel, SSO stub, and remember-me
 * checkbox. Auth flow happy-path and error-path are covered in auth.spec.ts.
 */

const AUTH_TOKEN_URL = '**/api/v1/auth/token/';

test.describe('Wave 8 — Login screen', () => {
  test('renders two-column layout with brand and hero copy', async ({ page }) => {
    await page.goto('/login');

    // Brand chip + wordmark
    await expect(page.getByText('tP')).toBeVisible();
    await expect(page.getByText('TruePPM').first()).toBeVisible();

    // Hero copy
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByText('Sign in to keep your launch on schedule.')).toBeVisible();
  });

  test('email field accepts email input and password field is obscured', async ({ page }) => {
    await page.goto('/login');

    const emailInput = page.getByLabel('Email');
    const passwordInput = page.getByLabel('Password');

    await expect(emailInput).toHaveAttribute('type', 'email');
    await expect(passwordInput).toHaveAttribute('type', 'password');
  });

  test('remember-me checkbox is present and toggleable', async ({ page }) => {
    await page.goto('/login');

    const checkbox = page.getByLabel('Keep me signed in for 30 days');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();
  });

  test('Forgot? link is present below the password input', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
  });

  test('Tab order goes Email → Password → Forgot? → Keep me signed in → Sign in (Forgot? does not interrupt the credentials)', async ({ page }) => {
    await page.goto('/login');

    // Fill the form so the Sign in button isn't disabled (disabled buttons
    // aren't focusable, which would mask whether tab actually reached them).
    const email = page.getByLabel('Email');
    await email.fill('user@example.com');
    await page.getByLabel('Password').fill('password123');

    await email.focus();
    await expect(email).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();

    // The link sits below the password input — Forgot? comes AFTER the
    // password in the tab order, not between Email and Password.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByLabel(/Keep me signed in/)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeFocused();
  });

  test('SSO button shows enterprise tooltip on click', async ({ page }) => {
    await page.goto('/login');

    const ssoButton = page.getByRole('button', { name: 'Continue with SSO' });
    await expect(ssoButton).toBeVisible();

    await ssoButton.click();
    await expect(page.getByRole('tooltip')).toContainText('SSO available in Enterprise tier');
  });

  test('marketing panel shows headline and build info', async ({ page }) => {
    await page.goto('/login');

    // The panel is hidden on narrow viewports — test at desktop width.
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(page.getByRole('heading', { name: 'Schedules that hold under pressure.' })).toBeVisible();
    // Status pill
    await expect(page.getByText(/CPM v.*live/)).toBeVisible();
    // Footer build info
    await expect(page.getByText(/build .* · status: operational/)).toBeVisible();
  });

  test('marketing panel is hidden below md breakpoint', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/login');

    // The panel has `hidden md:flex` — it should not be visible on mobile
    const panel = page.getByText('Schedules that hold under pressure.');
    await expect(panel).toBeHidden();
  });

  test('successful login posts remember_me flag when checkbox is checked', async ({ page }) => {
    let capturedBody: Record<string, unknown> = {};

    await page.route(AUTH_TOKEN_URL, async (route) => {
      capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access: 'mock-access', refresh: 'mock-refresh' }),
      });
    });
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
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
          at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
          last_saved: null, recalculated_at: null,
        }),
      }),
    );

    await page.goto('/login');
    await page.getByLabel('Keep me signed in for 30 days').check();
    await page.getByLabel('Email').fill('anna@example.com');
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 5_000 });
    expect(capturedBody['remember_me']).toBe(true);
  });
});

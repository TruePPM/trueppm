import { test, expect } from './fixtures/coverage';

/**
 * Public invite-accept E2E (#2035).
 *
 * The page is public (no auth) and makes no reads on load — the only network call
 * is the POST to the accept endpoint. We intercept it with route mocking so the
 * flow runs against the production build with no live backend, mocking the one
 * endpoint the page touches with its real response shape (never the catch-all).
 *
 * Coverage: the golden path (create account → redirected to a pre-filled sign-in
 * with a success banner, no dead-end) and an error state (a weak password is
 * surfaced inline while the user stays on the page).
 */

const ACCEPT_URL = '**/api/v1/workspace/invites/accept/';
const STRONG_PASSWORD = 'Str0ng-Passw0rd!';

test.describe('Invite acceptance', () => {
  test('golden path: creating an account redirects to a pre-filled sign-in', async ({ page }) => {
    await page.route(ACCEPT_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Invitation accepted.', username: 'anna_khoury' }),
      }),
    );

    await page.goto('/invite/accept?token=valid-token');
    await expect(page.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();

    await page.getByLabel('Username').fill('anna_khoury');
    await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);

    const submit = page.getByRole('button', { name: 'Create account & join' });
    await expect(submit).toBeEnabled();
    await submit.click();

    // No dead-end: we land on the sign-in form, it already knows the username, and
    // a success banner confirms the account is ready.
    await expect(page).toHaveURL(/\/login\?welcome=1&u=anna_khoury/);
    await expect(page.getByText('Your account is ready. Sign in to get started.')).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveValue('anna_khoury');
  });

  test('error state: a weak password is surfaced inline and the user stays put', async ({
    page,
  }) => {
    await page.route(ACCEPT_URL, (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'This password is too common.' }),
      }),
    );

    await page.goto('/invite/accept?token=valid-token');
    await page.getByLabel('Username').fill('anna_khoury');
    await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
    await page.getByRole('button', { name: 'Create account & join' }).click();

    await expect(page).toHaveURL(/\/invite\/accept/);
    await expect(page.getByText('This password is too common.')).toBeVisible();
  });

  test('invalid link: arriving without a token shows a helpful terminal state', async ({ page }) => {
    await page.goto('/invite/accept');
    await expect(
      page.getByRole('heading', { name: "This invitation link isn't valid" }),
    ).toBeVisible();
  });
});

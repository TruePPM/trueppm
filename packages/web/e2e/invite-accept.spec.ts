import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

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
    // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
    // falling through and 401ing, which trips the token-refresh session
    // teardown and races the page render (#2366). Routes below win.
    await setupCatchAll(page);

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

  test('invalid link: arriving without a token shows a helpful terminal state', async ({
    page,
  }) => {
    await page.goto('/invite/accept');
    await expect(
      page.getByRole('heading', { name: "This invitation link isn't valid" }),
    ).toBeVisible();
  });

  // The backend answers expired, already-used and revoked tokens with ONE generic 400
  // (no token enumeration), so the page cannot tell them apart — the contract is that
  // every one of them lands on the same terminal "not valid" state with the form gone.
  for (const [scenario, detail] of [
    ['expired', 'Invalid or expired invitation.'],
    ['already used', 'Invalid or expired invitation.'],
    ['revoked', 'Invalid or expired invitation.'],
  ] as const) {
    test(`error state: a ${scenario} token ends in the terminal invalid-link state`, async ({
      page,
    }) => {
      await setupCatchAll(page);
      await page.route(ACCEPT_URL, (route) =>
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail }),
        }),
      );

      await page.goto('/invite/accept?token=stale-token');
      await page.getByLabel('Username').fill('anna_khoury');
      await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
      await page.getByRole('button', { name: 'Create account & join' }).click();

      await expect(
        page.getByRole('heading', { name: "This invitation link isn't valid" }),
      ).toBeVisible();
      // Terminal: no form left to retry with, and no navigation to sign-in.
      await expect(page.getByLabel('Username')).toHaveCount(0);
      await expect(page).toHaveURL(/\/invite\/accept/);
    });
  }

  test('error state: a taken username is surfaced under the username field', async ({ page }) => {
    await setupCatchAll(page);
    await page.route(ACCEPT_URL, (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'That username is already taken.' }),
      }),
    );

    await page.goto('/invite/accept?token=valid-token');
    await page.getByLabel('Username').fill('anna_khoury');
    await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
    await page.getByRole('button', { name: 'Create account & join' }).click();

    await expect(page.getByText('That username is already taken. Try another.')).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
  });

  test('error state: a rate-limited accept asks the user to wait and stays on the form', async ({
    page,
  }) => {
    await setupCatchAll(page);
    await page.route(ACCEPT_URL, (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Request was throttled.' }),
      }),
    );

    await page.goto('/invite/accept?token=valid-token');
    await page.getByLabel('Username').fill('anna_khoury');
    await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
    await page.getByRole('button', { name: 'Create account & join' }).click();

    await expect(
      page.getByText('Too many attempts. Please wait a minute and try again.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/invite\/accept/);
  });
});

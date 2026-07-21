import { test, expect, type Page, type Route } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Trash + restore for soft-deleted projects (#1113, ADR-0202).
 *
 * Golden path: a soft-deleted project appears in Workspace → Trash and can be
 * restored, firing the restore endpoint and a success toast. Plus the empty state.
 */

const ME_ID = 'user-alice';
const TRASH_PROJECT_ID = 'e2e-trash-0000-0000-0000-000000001113';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const pj = (data: unknown) => JSON.stringify(data);

function trashRow() {
  return {
    id: TRASH_PROJECT_ID,
    name: 'Downtown Retrofit',
    code: 'DTR',
    deleted_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    deleted_by: 'user-bob',
    deleted_by_name: 'Bob Martin',
    days_remaining: 27,
    retention_days: 30,
    my_role: 400,
    can_restore: true,
  };
}

async function setupAuth(page: Page) {
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
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
}

test.describe('Workspace Trash (#1113)', () => {
  test('lists a soft-deleted project and restores it', async ({ page }) => {
    await setupAuth(page);

    let restoreCalled = false;
    // Trash list: the row is present until restore fires, then it's gone.
    await page.route('**/api/v1/projects/trash/', (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(restoreCalled ? [] : [trashRow()]),
      }),
    );
    await page.route(
      `**/api/v1/projects/${TRASH_PROJECT_ID}/restore/`,
      async (route: Route) => {
        restoreCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ id: TRASH_PROJECT_ID, name: 'Downtown Retrofit', code: 'DTR' }),
        });
      },
    );

    await page.goto('/settings/trash');

    // Gate on the page-rendered signal before interacting with the row.
    await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
    await expect(page.getByText('Downtown Retrofit')).toBeVisible();
    await expect(page.getByText(/Deleted by Bob Martin/)).toBeVisible();
    await expect(page.getByText(/auto-deletes in 27 days/)).toBeVisible();

    const restoreBtn = page.getByRole('button', { name: 'Restore' });
    await expect(restoreBtn).toBeEnabled();
    await restoreBtn.click();

    // Restore endpoint fired, success toast shown, and the row is gone (refetch → []).
    await expect.poll(() => restoreCalled).toBe(true);
    await expect(page.getByText('"Downtown Retrofit" restored')).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();
  });

  test('shows the empty state when Trash has no projects', async ({ page }) => {
    await setupAuth(page);
    await page.route('**/api/v1/projects/trash/', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
    );

    await page.goto('/settings/trash');
    await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();
  });

  // Reachability (#2184): the workspace-rail Trash link is admin-gated, so a
  // non-workspace-admin needs the always-available UserMenu entry to restore a
  // project they deleted.
  test('Trash is reachable from the account menu without workspace-admin access', async ({
    page,
  }) => {
    await setupAuth(page);
    await page.route('**/api/v1/projects/trash/', (route: Route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
    );

    await page.goto('/');
    // Open the account menu (accessible name: "Account — <name>").
    await page.getByRole('button', { name: /^Account/ }).click();
    const trashLink = page.getByRole('link', { name: 'Trash', exact: true });
    await expect(trashLink).toBeVisible();
    await trashLink.click();

    await expect(page.getByRole('heading', { name: 'Trash', exact: true })).toBeVisible();
    await expect(page.getByText('Trash is empty')).toBeVisible();
  });
});

test.describe('Not found (#2184)', () => {
  test('an unknown authed path keeps the shell and offers a way back', async ({ page }) => {
    await setupAuth(page);

    await page.goto('/this-path-does-not-exist');

    // The shell chrome is still painted (the old bare 404 rendered outside it).
    await expect(page.getByRole('button', { name: /^Account/ })).toBeVisible();
    // A focusable recovery action — not a dead end.
    const goToWork = page.getByRole('button', { name: 'Go to My Work' });
    await expect(goToWork).toBeVisible();
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeVisible();
    // Focus was moved to the heading on mount (rule 224) so keyboard users reach
    // the CTAs without blind-Tabbing from <body>.
    await expect(page.getByRole('heading', { name: /page not found/i })).toBeFocused();
  });
});

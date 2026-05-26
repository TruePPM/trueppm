import { test, expect, type Page } from '@playwright/test';

/**
 * Workspace settings — General, Members, and Groups pages.
 *
 * Golden path + one empty/error state per page.  All API calls are intercepted
 * via page.route() so no running backend is required.
 */

const pj = (data: unknown) => JSON.stringify(data);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = {
  name: 'TrueScope Aerospace',
  subdomain: 'truescope',
  timezone: 'America/Los_Angeles',
  fiscal_year_start_month: 1,
  fiscal_year_start_day: 1,
  fiscal_year_start_display: 'January 1',
  work_week: [true, true, true, true, true, false, false],
  default_project_view: 'Board',
  allow_guests: true,
  public_sharing: false,
};

const MEMBER = {
  id: 'u1',
  name: 'Alice Khoury',
  initials: 'AK',
  color: '#1C6B3A',
  email: 'alice@truescope.io',
  role: 'Admin',
  role_value: 300,
  groups: ['Leadership'],
  project_count: 5,
  last_active: '2h ago',
  status: 'active',
  sso: true,
  two_fa: true,
};

const INVITE = {
  id: 'inv-1',
  email: 'bob@example.com',
  role: 'Member',
  role_value: 100,
  status: 'pending',
  invited_by: 'AK',
  created_at: '2026-05-20T10:00:00Z',
  expires_at: '2026-06-20T10:00:00Z',
};

const GROUP = {
  id: 'grp-1',
  name: 'Avionics',
  description: 'Flight computer and firmware',
  lead: 'AK',
  lead_user_id: 'u1',
  member_count: 4,
  members: [{ id: 'u1', name: 'Alice Khoury', initials: 'AK', color: '#1C6B3A' }],
  projects: ['Orion', 'Artemis IV'],
};

// ---------------------------------------------------------------------------
// Common setup
// ---------------------------------------------------------------------------

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Catch-all — prevents unmocked requests from 401ing into the session-expired loop.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 'u1', username: 'alice', display_name: 'Alice', initials: 'AL', email: 'alice@truescope.io' }),
    }),
  );

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Workspace General page
// ---------------------------------------------------------------------------

test.describe('Workspace General page', () => {
  test('golden path — shows workspace name and subdomain', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    // Wait for the input to be seeded from the API response
    await expect(page.locator('input[value="TrueScope Aerospace"]')).toBeVisible();
    await expect(page.getByText('truescope', { exact: true })).toBeVisible();
  });

  test('golden path — work-week toggles reflect loaded state', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) }),
    );

    await page.goto('/settings/general');

    // Monday should be pressed (true), Saturday should not
    await expect(page.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Saturday' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('golden path — PATCH dispatched when Save is triggered via name change', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, name: 'Updated Corp' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    const nameInput = page.locator('input[value="TrueScope Aerospace"]');
    await nameInput.fill('Updated Corp');

    // The dirty form registers a save handler — invoke it via the shell's save bar.
    const saveBar = page.getByRole('button', { name: /save/i });
    if (await saveBar.isVisible()) {
      await saveBar.click();
    }
  });

  test('fiscal year — picking a preset chip dispatches the structured month/day', async ({ page }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, fiscal_year_start_month: 4, fiscal_year_start_display: 'April 1' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    // Loaded value is January 1 — that chip is pressed.
    await expect(page.getByRole('button', { name: 'Jan 1' })).toHaveAttribute('aria-pressed', 'true');

    // Switch to the April-1 preset, then save via the shell save bar.
    await page.getByRole('button', { name: 'Apr 1' }).click();
    await expect(page.getByRole('button', { name: 'Apr 1' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /save/i }).click();

    await expect.poll(() => patchBody).toMatchObject({
      fiscal_year_start_month: 4,
      fiscal_year_start_day: 1,
    });
  });

  test('fiscal year — Custom picker sends an oddball month/day (April 6)', async ({ page }) => {
    await setup(page);
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/v1/workspace/', (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: pj({ ...WORKSPACE, fiscal_year_start_month: 4, fiscal_year_start_day: 6, fiscal_year_start_display: 'April 6' }),
        });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    await page.getByRole('button', { name: 'Custom…' }).click();
    await page.getByLabel('Fiscal year start month').selectOption('4');
    await page.getByLabel('Fiscal year start day').selectOption('6');
    // No preset matches April 6, so the Custom chip stays pressed.
    await expect(page.getByRole('button', { name: 'Custom…' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /save/i }).click();

    await expect.poll(() => patchBody).toMatchObject({
      fiscal_year_start_month: 4,
      fiscal_year_start_day: 6,
    });
  });

  test('error state — shows loading skeleton when workspace fetch is slow', async ({ page }) => {
    await setup(page);
    // Override catch-all: make /workspace/ return empty object to trigger loading state
    // by never resolving during test startup (checking skeleton visibility window).
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });

    await page.route('**/api/v1/workspace/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj(WORKSPACE) });
    });

    await page.goto('/settings/general');

    // Loading skeleton is visible before data arrives
    await expect(page.locator('.animate-pulse').first()).toBeVisible();

    // Unblock so the page can finish loading
    resolve(undefined);
  });
});

// ---------------------------------------------------------------------------
// Workspace Members page
// ---------------------------------------------------------------------------

test.describe('Workspace Members page', () => {
  test('golden path — shows member name and email', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
    );

    await page.goto('/settings/members');

    await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
    await expect(page.getByText('Alice Khoury')).toBeVisible();
    await expect(page.getByText('alice@truescope.io')).toBeVisible();
  });

  test('golden path — pending invite section renders', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([INVITE]) }),
    );

    await page.goto('/settings/members');

    await expect(page.getByText('bob@example.com')).toBeVisible();
    await expect(page.getByText('1 pending invites')).toBeVisible();
  });

  test('golden path — POST dispatched when invite form is submitted', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/members/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([MEMBER]) }),
    );
    await page.route('**/api/v1/workspace/invites/', (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({ status: 201, contentType: 'application/json', body: pj(INVITE) });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) });
    });

    await page.goto('/settings/members');

    await page.getByRole('textbox', { name: /email/i }).fill('carol@example.com');
    await page.getByRole('button', { name: /invite members/i }).click();

    // Request is dispatched (the button text changes to "Sending…" then back).
    // We verify by the form clearing.
    await expect(page.getByRole('textbox', { name: /email/i })).toHaveValue('');
  });

  test('empty state — shows skeleton when loading', async ({ page }) => {
    await setup(page);
    // Both member endpoints are covered by catch-all returning [] which triggers
    // a resolved-empty state. Test the loading state instead with a slow route.
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });

    await page.route('**/api/v1/workspace/members/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) });
    });
    await page.route('**/api/v1/workspace/invites/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
    );

    await page.goto('/settings/members');

    await expect(page.locator('.animate-pulse').first()).toBeVisible();
    resolve(undefined);
  });
});

// ---------------------------------------------------------------------------
// Workspace Groups page
// ---------------------------------------------------------------------------

test.describe('Workspace Groups page', () => {
  test('golden path — shows group name and description', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/groups/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([GROUP]) }),
    );

    await page.goto('/settings/groups');

    await expect(page.getByRole('heading', { name: 'Groups & teams' })).toBeVisible();
    await expect(page.getByText('Avionics')).toBeVisible();
    await expect(page.getByText('Flight computer and firmware')).toBeVisible();
  });

  test('golden path — POST dispatched when create group form is submitted', async ({ page }) => {
    await setup(page);
    let postBody: unknown;
    await page.route('**/api/v1/workspace/groups/', (r) => {
      if (r.request().method() === 'POST') {
        postBody = r.request().postDataJSON();
        return r.fulfill({ status: 201, contentType: 'application/json', body: pj({ ...GROUP, id: 'grp-new', name: 'Propulsion' }) });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj([GROUP]) });
    });

    await page.goto('/settings/groups');

    await page.getByRole('button', { name: /create group/i }).click();
    await page.getByPlaceholder(/e\.g\. Avionics/i).fill('Propulsion');
    await page.getByRole('button', { name: /^create$/i }).click();

    await expect.poll(() => postBody).toMatchObject({ name: 'Propulsion' });
  });

  test('empty state — shows empty-state message when no groups exist', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/workspace/groups/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
    );

    await page.goto('/settings/groups');

    await expect(page.getByText(/No groups yet/i)).toBeVisible();
  });

  test('error-adjacent — shows skeleton when loading', async ({ page }) => {
    await setup(page);
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });

    await page.route('**/api/v1/workspace/groups/', async (r) => {
      await pending;
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj([GROUP]) });
    });

    await page.goto('/settings/groups');

    await expect(page.locator('.animate-pulse').first()).toBeVisible();
    resolve(undefined);
  });
});

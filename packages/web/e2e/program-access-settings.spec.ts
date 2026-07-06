import { test, expect } from '@playwright/test';

/**
 * Program Settings → Access E2E (#525).
 *
 * Verifies the Settings Access page is wired to the real program-members API:
 * - Members are listed from the GET response.
 * - The Add-member panel toggles only for Owners.
 * - The remove flow requires a confirm click before the DELETE fires.
 * - Non-Owners see no role picker and no remove button.
 */

const ME_ID = 'user-alice';
const OTHER_ID = 'user-sofia';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000525';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  code: '',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 2,
};

const OWNER_MEMBERSHIP = {
  id: 'mem-1',
  server_version: 1,
  program: PROGRAM_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 400,
  role_label: 'Project Admin',
};

const MEMBER_MEMBERSHIP = {
  id: 'mem-2',
  server_version: 1,
  program: PROGRAM_ID,
  user: OTHER_ID,
  user_detail: { id: OTHER_ID, username: 'sofia.p', email: 'sofia@example.com' },
  role: 100,
  role_label: 'Team Member',
};

type Page = import('@playwright/test').Page;

interface Captures {
  deleted?: string;
}

async function setup(page: Page, captures: Captures, opts: { myRole?: number } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);
  const program = { ...FIXTURE_PROGRAM, my_role: opts.myRole ?? 400 };

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [program], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(program) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  // Member-by-id (PATCH/DELETE) must register BEFORE the list route — Playwright
  // matches by last-registered, and the list URL exactly matches the trailing-
  // slash form so it wins when registered last.
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/members/*/`,
    async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      const id = url
        .replace(/\?.*$/, '')
        .split('/')
        .filter(Boolean)
        .pop();
      if (method === 'DELETE') {
        captures.deleted = id ?? undefined;
        await route.fulfill({ status: 204, contentType: 'application/json', body: '' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    },
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([OWNER_MEMBERSHIP, MEMBER_MEMBERSHIP]),
    }),
  );
}

test.describe('Program Settings → Access', () => {
  test('Owner sees real members and the Add-member toggle', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);

    await expect(page.getByRole('heading', { name: /^Access/ })).toBeVisible();
    // Use partial-match regexes because the username is rendered next to a
    // "(you)" inline annotation.
    await expect(page.getByText('alice', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/sofia\.p/)).toBeVisible();
    await expect(page.getByText(/2 members/)).toBeVisible();

    // The hardcoded "Anika Krishnan" from the stub must be gone.
    await expect(page.getByText('Anika Krishnan')).toHaveCount(0);

    // Stub banner must not render once wired.
    await expect(page.getByTestId('stub-page-banner')).toHaveCount(0);

    const addBtn = page.getByRole('button', { name: /Add member/i });
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.getByRole('heading', { name: /^Add a member$/i })).toBeVisible();
  });

  test('add-member flow POSTs the selected user + role and shows the new row', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);

    // Stateful member list + POST handler. Registered AFTER setup so it wins the
    // exact `.../members/` URL (Playwright LIFO). The bare add-member test only
    // asserted the panel heading — it never filled, submitted, or registered a
    // POST handler, so the headline write of the Access page could ship broken
    // and stay green (issue 1512).
    const NEW_USER = {
      id: 'user-mira',
      username: 'mira.k',
      display_name: 'Mira Kapoor',
      initials: 'MK',
    };
    const members: Array<Record<string, unknown>> = [OWNER_MEMBERSHIP, MEMBER_MEMBERSHIP];
    let postBody: { user?: string; role?: number } | null = null;

    await page.route('**/api/v1/users/search/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NEW_USER]) }),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, async (route) => {
      if (route.request().method() === 'POST') {
        postBody = route.request().postDataJSON() as { user?: string; role?: number };
        members.push({
          id: 'mem-3',
          server_version: 1,
          program: PROGRAM_ID,
          user: NEW_USER.id,
          user_detail: { id: NEW_USER.id, username: NEW_USER.username, email: 'mira@example.com' },
          role: postBody.role ?? 100,
          role_label: 'Team Member',
        });
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(members[members.length - 1]),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(members),
      });
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);
    await page.getByRole('button', { name: /Add member/i }).click();
    await expect(page.getByRole('heading', { name: /^Add a member$/i })).toBeVisible();

    await page.getByRole('combobox', { name: /Search by username or email/i }).fill('mira');
    await page.getByRole('option', { name: /Mira Kapoor/ }).click();
    await page
      .getByRole('region', { name: 'Add a member' })
      .getByRole('button', { name: /^Add$/ })
      .click();

    // The POST carried the selected user id and a concrete role…
    await expect.poll(() => postBody?.user).toBe(NEW_USER.id);
    expect(typeof postBody?.role).toBe('number');
    // …and the refetched list renders the new member as a row.
    await expect(page.getByText(/mira\.k/)).toBeVisible();
    await expect(page.getByText(/3 members/)).toBeVisible();
  });

  test('a failed add-member surfaces an inline alert and keeps the selection (#1518)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setup(page, captures);

    const NEW_USER = {
      id: 'user-mira',
      username: 'mira.k',
      display_name: 'Mira Kapoor',
      initials: 'MK',
    };
    await page.route('**/api/v1/users/search/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([NEW_USER]) }),
    );
    // POST fails with a 500; GET falls through to setup's member-list handler so
    // the roster keeps rendering. Registered AFTER setup so it wins the exact
    // `.../members/` URL (Playwright LIFO).
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"detail":"boom"}',
        });
      }
      return route.fallback();
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);
    await page.getByRole('button', { name: /Add member/i }).click();
    await expect(page.getByRole('heading', { name: /^Add a member$/i })).toBeVisible();

    await page.getByRole('combobox', { name: /Search by username or email/i }).fill('mira');
    await page.getByRole('option', { name: /Mira Kapoor/ }).click();
    await page
      .getByRole('region', { name: 'Add a member' })
      .getByRole('button', { name: /^Add$/ })
      .click();

    // The failed create surfaces an inline alert, retains the picked user (the
    // selection is cleared only on success), and re-enables the Add button so the
    // user can retry — no crash, no lost selection. Scope the alert to the
    // Add-a-member region: the settings page carries other advisory alerts.
    const addRegion = page.getByRole('region', { name: 'Add a member' });
    await expect(addRegion.getByRole('alert')).toContainText(/Failed to add member/i);
    await expect(page.getByRole('combobox', { name: /Search by username or email/i })).toHaveValue(
      'mira.k',
    );
    await expect(addRegion.getByRole('button', { name: /^Add$/ })).toBeEnabled();
    // The roster is unchanged — the phantom member never appears.
    await expect(page.getByText(/mira\.k/)).toHaveCount(0);
  });

  test('remove flow requires a confirm click before issuing DELETE', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);

    await page.getByRole('button', { name: /Remove sofia.p/i }).click();
    expect(captures.deleted).toBeUndefined();
    await page.getByRole('button', { name: /^Confirm$/ }).click();
    await expect.poll(() => captures.deleted).toBe('mem-2');
  });

  test('Team Member caller sees no Add-member button and no remove controls', async ({ page }) => {
    const captures: Captures = {};
    await setup(page, captures, { myRole: 100 });
    await page.goto(`/programs/${PROGRAM_ID}/settings/access`);

    await expect(page.getByRole('heading', { name: /^Access/ })).toBeVisible();
    await expect(page.getByText('alice', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Add member/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Remove/i })).toHaveCount(0);
  });
});

import { test, expect } from '@playwright/test';

/**
 * Project Settings → Team E2E (ADR-0078, #927).
 *
 * Golden path: navigate to Settings → Team → roster renders with facet switches.
 * Assign: toggling a facet with no prior holder PATCHes immediately.
 * Reassign: toggling a facet another member holds shows a confirm; Reassign PATCHes.
 * Read-only: a plain member sees disabled switches and no role select.
 */

const PROJECT_ID = 'e2e-team-00000000-0000-0000-0000-000000000927';
const TEAM_ID = 'team-1';
const ME_ID = 'user-alice';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Team Test Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_TEAM = {
  id: TEAM_ID,
  project: PROJECT_ID,
  name: 'Default Team',
  short_id: 'T01',
  is_default: true,
  member_count: 2,
};

type TeamMemberFixture = {
  id: string;
  user: string;
  user_detail: { id: string; username: string; email: string };
  role: 'member' | 'admin';
  role_label: string;
  is_scrum_master: boolean;
  is_product_owner: boolean;
};

const aliceRow = (role: 'member' | 'admin'): TeamMemberFixture => ({
  id: 'tm-alice',
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role,
  role_label: role === 'admin' ? 'Admin' : 'Member',
  is_scrum_master: false,
  is_product_owner: false,
});

const bobRow = (over: Partial<TeamMemberFixture> = {}): TeamMemberFixture => ({
  id: 'tm-bob',
  user: 'user-bob',
  user_detail: { id: 'user-bob', username: 'bob', email: 'bob@example.com' },
  role: 'member',
  role_label: 'Member',
  is_scrum_master: false,
  is_product_owner: false,
  ...over,
});

type Page = import('@playwright/test').Page;

interface SetupOpts {
  /** Project role ordinal reported via members/?self=true. 300 = ADMIN (can edit). */
  selfRole?: number;
  roster?: TeamMemberFixture[];
}

async function setup(page: Page, opts: SetupOpts = {}) {
  const { selfRole = 300, roster = [aliceRow('admin'), bobRow()] } = opts;

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

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );

  // self=true → role check for canEdit; list view is unused by this tab.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) => {
    const url = r.request().url();
    if (url.includes('self=true')) {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj([{ id: 'mem-alice', role: selfRole }]),
      });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) });
  });

  await page.route(`**/api/v1/projects/${PROJECT_ID}/teams/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_TEAM]) }),
  );
  await page.route(`**/api/v1/teams/${TEAM_ID}/members/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(roster) }),
  );
}

test.describe('Team Settings — golden path', () => {
  test('roster renders alice and bob with facet switches', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/team`);
    await expect(page.getByRole('switch', { name: 'Scrum Master: bob' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Product Owner: bob' })).toBeVisible();
    await expect(page.locator('li').filter({ hasText: 'alice' }).first()).toBeVisible();
  });
});

test.describe('Team Settings — facet assignment', () => {
  test('toggling Scrum Master with no prior holder PATCHes immediately', async ({ page }) => {
    await setup(page);

    let patchBody: unknown;
    await page.route(`**/api/v1/teams/${TEAM_ID}/members/tm-bob/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(bobRow({ is_scrum_master: true })),
        });
      }
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/team`);
    await page.getByRole('switch', { name: 'Scrum Master: bob' }).click();
    await expect.poll(() => patchBody).toEqual({ is_scrum_master: true });
  });

  test('toggling a facet another member holds confirms a reassignment', async ({ page }) => {
    await setup(page, {
      roster: [aliceRow('admin'), bobRow(), {
        id: 'tm-carol',
        user: 'user-carol',
        user_detail: { id: 'user-carol', username: 'carol', email: 'carol@example.com' },
        role: 'member',
        role_label: 'Member',
        is_scrum_master: true,
        is_product_owner: false,
      }],
    });

    let patchDispatched = false;
    await page.route(`**/api/v1/teams/${TEAM_ID}/members/tm-bob/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchDispatched = true;
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(bobRow({ is_scrum_master: true })),
        });
      }
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/team`);
    await page.getByRole('switch', { name: 'Scrum Master: bob' }).click();

    // Confirm appears; no PATCH yet.
    await expect(page.getByText(/carol is currently Scrum Master/i)).toBeVisible();
    expect(patchDispatched).toBe(false);

    await page.getByRole('button', { name: 'Reassign' }).click();
    await expect.poll(() => patchDispatched).toBe(true);
  });
});

test.describe('Team Settings — read-only', () => {
  test('a plain member sees disabled switches and no role select', async ({ page }) => {
    await setup(page, { selfRole: 100, roster: [aliceRow('member'), bobRow()] });
    await page.goto(`/projects/${PROJECT_ID}/settings/team`);
    await expect(page.getByRole('switch', { name: 'Scrum Master: bob' })).toBeDisabled();
    await expect(page.getByRole('combobox')).toHaveCount(0);
  });
});

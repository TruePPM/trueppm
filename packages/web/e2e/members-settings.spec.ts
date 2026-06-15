import { test, expect } from '@playwright/test';

/**
 * Project Settings → Members E2E (#144).
 *
 * Golden path: navigate to Settings tab → Members sub-tab renders member list.
 * OWNER-only controls: role picker visible for Team Member, hidden for non-OWNER viewer.
 * Role change: PATCH dispatched on role picker change.
 * Remove member: DELETE dispatched on Remove click.
 * Invite: search typeahead + select + Add dispatches POST.
 * Leave: self-remove with confirmation dialog; sole-owner guard shows "Can't leave".
 */

const PROJECT_ID = 'e2e-members-00000000-0000-0000-0000-000000000144';
const ME_ID = 'user-alice';
const BOB_ID = 'user-bob';
const MEM_ALICE_ID = 'mem-alice';
const MEM_BOB_ID = 'mem-bob';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Members Test Project',
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

const FIXTURE_MEMBERS = [
  {
    id: MEM_ALICE_ID, server_version: 1,
    project: PROJECT_ID, user: ME_ID,
    user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
    role: 400, role_label: 'Project Admin',
    joined_at: '2026-04-12T12:00:00Z', role_changed_at: null,
    other_active_project_count: 0, other_active_project_names: [],
  },
  {
    // bob's role was changed after joining — exercises the access-evidence
    // "Role changed" line (#590). bob is also on 2 other active projects, with
    // names visible to the viewer — exercises the resource-load badge (#598).
    id: MEM_BOB_ID, server_version: 1,
    project: PROJECT_ID, user: BOB_ID,
    user_detail: { id: BOB_ID, username: 'bob', email: 'bob@example.com' },
    role: 100, role_label: 'Team Member',
    joined_at: '2026-04-12T12:00:00Z', role_changed_at: '2026-05-01T12:00:00Z',
    other_active_project_count: 2, other_active_project_names: ['Apollo', 'Gemini'],
  },
];

const FIXTURE_SEARCH_RESULTS = [
  { id: 'user-carol', username: 'carol', email: 'carol@example.com', display_name: 'Carol', initials: 'CA' },
];

type Page = import('@playwright/test').Page;

async function setup(page: Page, { ownerCount = 1 }: { ownerCount?: number } = {}) {
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
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({
      task_count: 0, critical_path_count: 0, monte_carlo_p80: null,
      at_risk_count: 0, critical_count: 0,
    }) }),
  );
  await page.route('**/api/v1/projects/*/attention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/my-tasks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );

  // Members endpoint — distinguish ?self=true (role check) from list view
  const owners = ownerCount > 1
    ? [FIXTURE_MEMBERS[0], { ...FIXTURE_MEMBERS[0], id: 'mem-carol', user: 'user-carol', user_detail: { id: 'user-carol', username: 'carol', email: 'carol@example.com' }, role: 400, role_label: 'Project Admin' }]
    : [FIXTURE_MEMBERS[0]];
  const allMembers = [...owners.slice(0, ownerCount), FIXTURE_MEMBERS[1]];

  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) => {
    const url = r.request().url();
    if (url.includes('self=true')) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: pj([{ id: MEM_ALICE_ID, role: 400 }]) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: pj(allMembers) });
  });

  await page.route('**/api/v1/users/search/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_SEARCH_RESULTS) }),
  );
}

// ---------------------------------------------------------------------------
// Golden path — Settings tab + member list
// ---------------------------------------------------------------------------

test.describe('Members Settings — golden path', () => {
  test('project view bar is suppressed on settings routes (ADR-0128 §C)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // The grouped project ViewTabs self-suppresses on settings routes — the
    // SettingsShell carries its own chrome (rule 123 / ADR-0128 §C), so the
    // view row's `nav[aria-label="View"]` is not mounted here.
    await expect(page.getByRole('navigation', { name: 'View' })).toHaveCount(0);
  });

  test('settings shell chrome identifies the active project', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // Wayfinding in settings is the SettingsShell rail + context pill, not a
    // tab (rule 123): the sections nav is present and the pill names the project.
    await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
    await expect(page.getByText('Members Test Project').first()).toBeVisible();
  });

  test('member list renders alice and bob', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // Two <p> elements per row contain 'alice' (username + email), so scope to row.
    await expect(page.locator('li').filter({ hasText: 'alice' }).first()).toBeVisible();
    await expect(page.locator('li').filter({ hasText: 'bob' }).first()).toBeVisible();
  });

  test('shows (you) label next to current user', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByText('(you)')).toBeVisible();
  });

  test('shows access-evidence join date and role-change date (#590)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // alice has never changed role since joining → join date only.
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await expect(aliceRow.getByText(/Joined/)).toBeVisible();
    await expect(aliceRow.getByText(/Role changed/)).toHaveCount(0);
    // bob's role changed after joining → both lines present.
    const bobRow = page.locator('li').filter({ hasText: 'bob' }).first();
    await expect(bobRow.getByText(/Joined/)).toBeVisible();
    await expect(bobRow.getByText(/Role changed/)).toBeVisible();
  });

  test('OWNER badge shown for alice (Project Admin, non-editable)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByText('Project Admin')).toBeVisible();
  });

  test('shows the other-active-projects badge with names tooltip (#598)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // bob is on 2 other active projects, with names visible to the viewer.
    const bobRow = page.locator('li').filter({ hasText: 'bob' }).first();
    const badge = bobRow.getByText('+2 other projects');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', 'Also on: Apollo, Gemini');
    // alice carries no other active projects → no badge on her row.
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await expect(aliceRow.getByText(/other project/)).toHaveCount(0);
  });

  test('invite form visible to OWNER', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByRole('heading', { name: /add member/i })).toBeVisible();
  });

  test('shows "must have account" hint in invite form', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByText(/must have an existing TruePPM account/i)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Role change
// ---------------------------------------------------------------------------

test.describe('Members Settings — role change', () => {
  test('PATCH dispatched when role picker changes for bob', async ({ page }) => {
    await setup(page);

    let patchBody: unknown;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/${MEM_BOB_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchBody = r.request().postDataJSON();
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...FIXTURE_MEMBERS[1], role: 200, role_label: 'Resource Manager' }) });
      }
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    // Bob's row has the role picker (Team Member, role=100)
    const bobRow = page.locator('li').filter({ hasText: 'bob' }).first();
    await bobRow.getByRole('combobox').selectOption('200');

    await expect.poll(() => patchBody).toEqual({ role: 200 });
  });
});

// ---------------------------------------------------------------------------
// Remove member
// ---------------------------------------------------------------------------

test.describe('Members Settings — remove member', () => {
  test('DELETE dispatched when Remove is clicked for bob', async ({ page }) => {
    await setup(page);

    let deleteDispatched = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/${MEM_BOB_ID}/`, (r) => {
      if (r.request().method() === 'DELETE') {
        deleteDispatched = true;
        return r.fulfill({ status: 204 });
      }
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    const bobRow = page.locator('li').filter({ hasText: 'bob' }).first();
    await bobRow.getByRole('button', { name: /remove bob/i }).click();

    await expect.poll(() => deleteDispatched).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------

test.describe('Members Settings — invite form', () => {
  test('search dropdown appears after typing 2+ characters', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await page.getByRole('combobox', { name: /search/i }).fill('ca');
    await expect(page.getByRole('option', { name: /carol/i })).toBeVisible();
  });

  test('Add button disabled before user is selected', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByRole('button', { name: /^add$/i })).toBeDisabled();
  });

  test('POST dispatched after selecting user and clicking Add', async ({ page }) => {
    await setup(page);

    let postBody: unknown;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (r) => {
      if (r.request().method() === 'POST') {
        postBody = r.request().postDataJSON();
        return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
          id: 'mem-carol', server_version: 1, project: PROJECT_ID, user: 'user-carol',
          user_detail: { id: 'user-carol', username: 'carol', email: 'carol@example.com' },
          role: 100, role_label: 'Team Member',
          joined_at: '2026-05-24T12:00:00Z', role_changed_at: null,
        }) });
      }
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await page.getByRole('combobox', { name: /search/i }).fill('ca');
    await page.getByRole('option', { name: /carol/i }).click();
    await page.getByRole('button', { name: /^add$/i }).click();

    await expect.poll(() => postBody).toMatchObject({ user: 'user-carol', role: 100 });
  });
});

// ---------------------------------------------------------------------------
// Leave project
// ---------------------------------------------------------------------------

test.describe('Members Settings — leave project', () => {
  test('sole owner sees "Can\'t leave" instead of Leave button', async ({ page }) => {
    // ownerCount=1 → alice is sole owner
    await setup(page, { ownerCount: 1 });
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    await expect(page.getByText("Can't leave")).toBeVisible();
  });

  test('non-sole owner sees Leave button that opens confirmation', async ({ page }) => {
    // ownerCount=2 → two owners, alice can leave
    await setup(page, { ownerCount: 2 });
    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await aliceRow.getByRole('button', { name: /leave project/i }).click();
    await expect(aliceRow.getByText('Leave project?')).toBeVisible();
  });

  test('Cancel in leave dialog dismisses without DELETE', async ({ page }) => {
    await setup(page, { ownerCount: 2 });

    let deleteDispatched = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/${MEM_ALICE_ID}/`, (r) => {
      if (r.request().method() === 'DELETE') deleteDispatched = true;
      return r.continue();
    });

    await page.goto(`/projects/${PROJECT_ID}/settings/members`);
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await aliceRow.getByRole('button', { name: /leave project/i }).click();
    await aliceRow.getByRole('button', { name: /cancel/i }).click();

    await expect(aliceRow.getByText('Leave project?')).not.toBeVisible();
    expect(deleteDispatched).toBe(false);
  });
});

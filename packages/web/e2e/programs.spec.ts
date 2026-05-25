import { test, expect } from '@playwright/test';

/**
 * Programs E2E (#502, ADR-0070).
 *
 * Covers:
 *  - /programs empty state + "Create your first program" CTA opens the modal
 *  - Modal creates a program and navigates to /programs/{id}/projects
 *  - Members tab renders the auto-OWNER membership row
 *  - Backlog tab renders the backlog workspace (#742; detailed coverage lives
 *    in program-backlog.spec.ts)
 *  - Sidebar PROGRAMS section lists the user's programs after creation
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000502';
const MEMBERSHIP_ID = 'e2e-prog-mem-alice';

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
  methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 1,
};

const FIXTURE_MEMBERSHIP = {
  id: MEMBERSHIP_ID,
  server_version: 1,
  program: PROGRAM_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 400,
  role_label: 'Project Admin',
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, { existingPrograms = [] as (typeof FIXTURE_PROGRAM)[] } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          accessToken: 'e2e-token',
          refreshToken: 'e2e-refresh',
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);
  let programs = [...existingPrograms];

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
  await page.route('**/api/v1/me/work/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], due_today_count: 0 }),
    }),
  );

  await page.route('**/api/v1/programs/', (r) => {
    if (r.request().method() === 'POST') {
      programs = [...programs, FIXTURE_PROGRAM];
      return r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: programs, count: programs.length, next: null, previous: null }),
    });
  });

  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([FIXTURE_MEMBERSHIP]),
    }),
  );
}

test.describe('Programs — empty state and creation', () => {
  test('shows hero empty state with CTA', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await expect(page.getByText(/Programs group related projects/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Create your first program/i })).toBeVisible();
  });

  test('create modal includes the cascading-access onboarding hint', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await page.getByRole('button', { name: /Create your first program/i }).click();
    await expect(
      page.getByText(/Project access is managed separately on each project/i),
    ).toBeVisible();
  });

  test('creating a program navigates to its Projects tab', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');
    await page.getByRole('button', { name: /Create your first program/i }).click();
    await page.getByLabel(/^name/i).fill('Phase 2 Modernization');
    await page.getByRole('button', { name: /Create program/i }).click();
    await expect(page).toHaveURL(`/programs/${PROGRAM_ID}/projects`);
  });
});

test.describe('Programs — shell tabs', () => {
  test('Backlog tab renders the backlog workspace (empty)', async ({ page }) => {
    // No backlog-items are mocked here (catch-all returns []), so the workspace
    // shows its empty state. Populated behavior is covered in program-backlog.spec.ts.
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/backlog`);
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    await expect(page.getByText('The program backlog is empty')).toBeVisible();
  });

  test('Projects tab shows empty state for an empty program', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await expect(page.getByText(/No projects in this program yet/i)).toBeVisible();
    await expect(page.getByText(/These projects belong to the program/i)).toBeVisible();
  });

  test('Projects tab shows both New project and Add existing buttons (admin)', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    // Scope to the toolbar so we don't hit the sidebar or empty-state copies.
    const toolbar = page.getByRole('toolbar', { name: /program projects actions/i });
    await expect(toolbar.getByRole('button', { name: /^New project$/i })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: /^Add existing$/i })).toBeVisible();
  });

  test('New project button creates a project assigned to the program', async ({ page }) => {
    const NEW_PROJECT_ID = 'e2e-new-project-uuid-0001';
    let capturedBody: Record<string, unknown> | null = null;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });

    // Override the default /projects/ stub so POST records the body and
    // returns a created project. GET continues to return an empty list —
    // navigation happens immediately so the cache invalidation is a follow-up.
    await page.route('**/api/v1/projects/', (r) => {
      if (r.request().method() === 'POST') {
        capturedBody = r.request().postDataJSON() as Record<string, unknown>;
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: NEW_PROJECT_ID,
            server_version: 1,
            name: capturedBody.name,
            description: capturedBody.description ?? '',
            start_date: capturedBody.start_date,
            calendar: null,
            methodology: capturedBody.methodology ?? 'HYBRID',
            program: capturedBody.program ?? null,
          }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results: [], count: 0, next: null, previous: null }),
      });
    });

    // Stub the project overview endpoints the navigated-to page will fetch
    // so the redirect doesn't 404 in the test environment.
    await page.route(`**/api/v1/projects/${NEW_PROJECT_ID}/`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: NEW_PROJECT_ID,
          server_version: 1,
          name: 'Tower A Buildout',
          description: '',
          start_date: '2026-05-18',
          methodology: 'HYBRID',
          program: PROGRAM_ID,
        }),
      }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    // Scope to the toolbar so the sidebar's "New project" button (no programId) is not picked.
    await page
      .getByRole('toolbar', { name: /program projects actions/i })
      .getByRole('button', { name: /^New project$/i })
      .click();
    await page.getByLabel(/^name/i).fill('Tower A Buildout');
    await page.getByRole('button', { name: /next/i }).click(); // step 1 → 2
    await page.getByRole('button', { name: /next/i }).click(); // step 2 → 3
    await page.getByRole('button', { name: /create project/i }).click();

    await expect(page).toHaveURL(`/projects/${NEW_PROJECT_ID}/overview`);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.program).toBe(PROGRAM_ID);
    expect(capturedBody!.name).toBe('Tower A Buildout');
  });

  test('Members tab shows the auto-OWNER row', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/members`);
    const aliceRow = page.locator('li').filter({ hasText: 'alice' }).first();
    await expect(aliceRow).toBeVisible();
    await expect(aliceRow.getByText('(you)')).toBeVisible();
    // The role badge in the row uses the role label as exact text.
    await expect(aliceRow.getByText('Project Admin', { exact: true })).toBeVisible();
  });
});

test.describe('Programs — ungrouped projects (#697, ADR-0083)', () => {
  const STANDALONE_ID = 'e2e-standalone-uuid-00000697';

  const FIXTURE_UNGROUPED = {
    id: STANDALONE_ID,
    name: 'Neptune Cryo Rig',
    code: 'NEP',
    health: 'ON_TRACK',
    percent_complete: 38,
    member_count: 4,
  };

  test('renders the ungrouped section below the program cards', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    // The ungrouped GET carries a query string the setup `**/projects/` glob
    // does not match — a regex route handles it and takes precedence.
    await page.route(/\/api\/v1\/projects\/\?.*program__isnull=true/, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [FIXTURE_UNGROUPED],
          count: 1,
          next: null,
          previous: null,
        }),
      }),
    );

    await page.goto('/programs');
    await expect(page.getByRole('heading', { name: /^Ungrouped projects$/i })).toBeVisible();
    await expect(page.getByText('1 need a home')).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: 'Neptune Cryo Rig' });
    await expect(row).toBeVisible();
    await expect(row.getByText('NEP', { exact: true })).toBeVisible();
    await expect(row.getByText('38%')).toBeVisible();
    await expect(row.getByText('4 members')).toBeVisible();
  });

  test('moves a standalone project into a program, then the section self-hides', async ({
    page,
  }) => {
    let ungrouped: Array<typeof FIXTURE_UNGROUPED> = [FIXTURE_UNGROUPED];
    let patchedProgram: unknown = null;

    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.route(/\/api\/v1\/projects\/\?.*program__isnull=true/, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: ungrouped,
          count: ungrouped.length,
          next: null,
          previous: null,
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${STANDALONE_ID}/`, (r) => {
      if (r.request().method() === 'PATCH') {
        patchedProgram = (r.request().postDataJSON() as Record<string, unknown>).program;
        ungrouped = []; // now grouped → drops out of the ungrouped list
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: STANDALONE_ID, server_version: 2, program: PROGRAM_ID }),
        });
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: STANDALONE_ID }),
      });
    });

    await page.goto('/programs');
    const row = page.getByRole('listitem').filter({ hasText: 'Neptune Cryo Rig' });
    await row.getByRole('button', { name: /Move to program/i }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: /Phase 2 Modernization/i }).click();
    await dialog.getByRole('button', { name: /^Move project$/i }).click();

    // Dialog closes and the section self-hides once the list is empty.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /^Ungrouped projects$/i })).toHaveCount(0);
    expect(patchedProgram).toBe(PROGRAM_ID);
  });
});

test.describe('Programs — sidebar entry', () => {
  test('PROGRAMS section lists the program after creation', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    const sidebar = page.locator('aside[aria-label="Projects"]');
    await expect(sidebar).toBeVisible();
    // Sidebar PROGRAMS section header (rule 36 uppercase).
    await expect(sidebar.getByRole('heading', { name: 'Programs' })).toBeVisible();
    // The program link rendered inside the PROGRAMS list.
    await expect(
      sidebar.getByRole('link', { name: 'Phase 2 Modernization' }).first(),
    ).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';

/**
 * Programs E2E (#502, ADR-0070).
 *
 * Covers:
 *  - /programs empty state + "Create your first program" CTA opens the modal
 *  - Modal creates a program and navigates to /programs/{id}/projects
 *  - Members tab renders the auto-OWNER membership row
 *  - Backlog tab renders the stub copy ("coming next" + ADR link)
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
  my_role: 4,
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
  role: 4,
  role_label: 'Project Admin',
};

type Page = import('@playwright/test').Page;

async function setup(
  page: Page,
  { existingPrograms = [] as typeof FIXTURE_PROGRAM[] } = {},
) {
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
    await expect(
      page.getByRole('button', { name: /Create your first program/i }),
    ).toBeVisible();
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
    await page
      .getByLabel(/^name/i)
      .fill('Phase 2 Modernization');
    await page.getByRole('button', { name: /Create program/i }).click();
    await expect(page).toHaveURL(`/programs/${PROGRAM_ID}/projects`);
  });
});

test.describe('Programs — shell tabs', () => {
  test('Backlog tab shows the "coming next" stub', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/backlog`);
    await expect(
      page.getByRole('heading', { name: /The program backlog is coming next/i }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Read the design \(ADR-0069\)/i })).toBeVisible();
  });

  test('Projects tab shows empty state for an empty program', async ({ page }) => {
    await setup(page, { existingPrograms: [FIXTURE_PROGRAM] });
    await page.goto(`/programs/${PROGRAM_ID}/projects`);
    await expect(page.getByText(/No projects in this program yet/i)).toBeVisible();
    await expect(
      page.getByText(/These projects belong to the program/i),
    ).toBeVisible();
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

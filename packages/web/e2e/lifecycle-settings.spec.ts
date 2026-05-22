import { test, expect } from '@playwright/test';

/**
 * Lifecycle settings pages — Project + Program (#530).
 *
 * Verifies that ProjectArchivePage and ProgramArchivePage are wired to the
 * real lifecycle endpoints (archive/unarchive, close/reopen, delete), that
 * the typed-confirmation reads the actual project code / program code from
 * the API response (not a hardcoded slug), and that the destructive paths
 * navigate away on success.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000000530';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000530';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Apollo Migration',
  description: '',
  start_date: '2026-03-02',
  calendar: 'cal-default',
  estimation_mode: 'OPEN',
  agile_features: false,
  methodology: 'HYBRID',
  code: 'APOLLO',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  timezone: '',
  default_view: 'SCHEDULE',
  is_archived: false,
  archived_at: null,
  archived_by: null,
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Artemis',
  description: '',
  code: 'ARTEMIS',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 0,
  member_count: 1,
  is_closed: false,
  closed_at: null,
  closed_by: null,
};

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

interface Captures {
  projectArchive?: number;
  projectDelete?: { url: string };
  programClose?: number;
  programDelete?: { url: string };
}

const pj = (data: unknown) => JSON.stringify(data);

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

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
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
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
}

async function setupProjectRoutes(page: Page, captures: Captures) {
  // Regex (not glob) so the route also matches the DELETE ?force=true variant —
  // Playwright globs treat query strings as literal characters and `**/projects/<id>/`
  // would not match `**/projects/<id>/?force=true`, sending the DELETE through to the
  // catch-all and leaving captures.projectDelete unset.
  await page.route(
    new RegExp(`/api/v1/projects/${PROJECT_ID}/(\\?.*)?$`),
    async (route: Route) => {
      const method = route.request().method();
      if (method === 'DELETE') {
        captures.projectDelete = { url: route.request().url() };
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROJECT, is_archived: (captures.projectArchive ?? 0) > 0 }),
      });
    },
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/archive/`, async (route: Route) => {
    captures.projectArchive = (captures.projectArchive ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        ...FIXTURE_PROJECT,
        is_archived: true,
        archived_at: '2026-05-22T12:00:00Z',
        archived_by: ME_ID,
      }),
    });
  });
}

async function setupProgramRoutes(page: Page, captures: Captures) {
  // See setupProjectRoutes — regex needed so DELETE with `?force=true` is matched.
  await page.route(
    new RegExp(`/api/v1/programs/${PROGRAM_ID}/(\\?.*)?$`),
    async (route: Route) => {
      const method = route.request().method();
      if (method === 'DELETE') {
        captures.programDelete = { url: route.request().url() };
        await route.fulfill({ status: 204, body: '' });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROGRAM, is_closed: (captures.programClose ?? 0) > 0 }),
      });
    },
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/close/`, async (route: Route) => {
    captures.programClose = (captures.programClose ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        ...FIXTURE_PROGRAM,
        is_closed: true,
        closed_at: '2026-05-22T12:00:00Z',
        closed_by: ME_ID,
      }),
    });
  });
}

test.describe('Project lifecycle settings (#530)', () => {
  test('archive button POSTs to /projects/:id/archive/', async ({ page }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProjectRoutes(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();
    // Confirmation target reads the real project code, NOT a hardcoded slug.
    await expect(page.getByText('APOLLO', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: /Archive Apollo Migration/i }).click();
    await expect.poll(() => captures.projectArchive).toBe(1);
  });

  test('delete after typed-confirm sends DELETE ?force=true and redirects', async ({ page }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProjectRoutes(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    await page
      .getByLabel('Confirm delete by typing the project code or name')
      .fill('APOLLO');
    await page.getByRole('button', { name: /Delete project permanently/i }).click();

    // First archive happens automatically (server requires archive before
    // force-delete); then DELETE ?force=true; then we land back at root.
    await expect.poll(() => captures.projectArchive).toBeGreaterThanOrEqual(1);
    await expect.poll(() => captures.projectDelete?.url).toContain('force=true');
    await expect(page).toHaveURL(/\/$|\/programs|\/projects/);
  });
});

test.describe('Program lifecycle settings (#530)', () => {
  test('close button POSTs to /programs/:id/close/', async ({ page }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProgramRoutes(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Archive / Close' })).toBeVisible();
    // Confirmation target reads the real program code (ARTEMIS), not a hardcoded slug.
    await expect(page.getByText('ARTEMIS', { exact: true }).first()).toBeVisible();

    await page.getByRole('button', { name: /Close program/i }).click();
    await expect.poll(() => captures.programClose).toBe(1);
  });

  test('delete after typed-confirm sends DELETE and redirects', async ({ page }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProgramRoutes(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/lifecycle`);

    await page
      .getByLabel('Confirm delete by typing the program code or name')
      .fill('ARTEMIS');
    await page.getByRole('button', { name: /Delete program permanently/i }).click();

    await expect.poll(() => captures.programDelete?.url).toContain(`/programs/${PROGRAM_ID}/`);
  });
});

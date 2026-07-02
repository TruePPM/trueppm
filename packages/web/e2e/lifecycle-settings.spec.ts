import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

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
  projectTransfer?: { body: unknown };
  projectExport?: number;
  programClose?: number;
  programDelete?: { url: string };
  programTransfer?: { body: unknown };
  programSplit?: { body: unknown };
}

const NEW_SUB_ID = 'e2e-subprogram-00000000-0000-0000-0000-000000000967';
const PROGRAM_PROJECTS = [
  {
    id: 'proj-apollo',
    name: 'Apollo',
    description: '',
    start_date: '2026-03-02',
    methodology: 'HYBRID',
    program: PROGRAM_ID,
  },
  {
    id: 'proj-beacon',
    name: 'Beacon',
    description: '',
    start_date: '2026-03-02',
    methodology: 'HYBRID',
    program: PROGRAM_ID,
  },
];

const TARGET_USER_ID = 'user-bob';
const PROJECT_MEMBERS = [
  { id: 'pm-1', user_detail: { id: ME_ID, username: 'alice' }, role: 400 },
  { id: 'pm-2', user_detail: { id: TARGET_USER_ID, username: 'bob' }, role: 100 },
];
const PROGRAM_MEMBERS = [
  { id: 'gm-1', user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' }, role: 400 },
  { id: 'gm-2', user_detail: { id: TARGET_USER_ID, username: 'bob', email: 'bob@example.com' }, role: 100 },
];

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

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(PROJECT_MEMBERS) });
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/transfer/`, async (route: Route) => {
    captures.projectTransfer = { body: route.request().postDataJSON() };
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) });
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/export/`, async (route: Route) => {
    captures.projectExport = (captures.projectExport ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Content-Disposition': 'attachment; filename="APOLLO.json"' },
      body: pj({
        schema_version: '1.0',
        program: { slug: 'apollo', name: 'Apollo Migration', methodology: 'HYBRID' },
        projects: [{ slug: 'apollo', name: 'Apollo Migration', methodology: 'HYBRID' }],
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj(PROGRAM_MEMBERS) });
  });
  // The split dialog reads the program's projects to redistribute them.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(PROGRAM_PROJECTS),
    });
  });
  await page.route(
    `**/api/v1/programs/${PROGRAM_ID}/transfer-sponsorship/`,
    async (route: Route) => {
      captures.programTransfer = { body: route.request().postDataJSON() };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(FIXTURE_PROGRAM),
      });
    },
  );
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
    // force-delete); then DELETE ?force=true; then we navigate to root, whose
    // RootRedirect resolves the role-based landing (ADR-0129) — for this user
    // that is My Work, so /me/work is a valid post-delete destination too.
    await expect.poll(() => captures.projectArchive).toBeGreaterThanOrEqual(1);
    await expect.poll(() => captures.projectDelete?.url).toContain('force=true');
    await expect(page).toHaveURL(/\/$|\/programs|\/projects|\/me\/work/);
  });

  test('transfer ownership picks a member and POSTs to /projects/:id/transfer/ (#967)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProjectRoutes(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();
    await page.getByRole('button', { name: 'Transfer ownership…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Transfer ownership' });
    await expect(dialog).toBeVisible();

    // Confirm is gated until a new owner is chosen.
    await expect(dialog.getByRole('button', { name: /Confirm transfer/i })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Assign' }).click();
    await dialog.getByRole('option', { name: 'bob' }).click();

    await dialog.getByRole('button', { name: /Confirm transfer/i }).click();
    await expect
      .poll(() => captures.projectTransfer?.body)
      .toEqual({ new_owner_user_id: TARGET_USER_ID });
  });

  test('export project downloads a JSON seed from /projects/:id/export/ (#967)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProjectRoutes(page, captures);
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Lifecycle' })).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export project…' }).click(),
    ]);

    await expect.poll(() => captures.projectExport).toBe(1);
    // Filename derives from the project code (APOLLO), via the export hook.
    expect(download.suggestedFilename()).toBe('APOLLO.json');
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

  test('transfer sponsorship picks a sponsor and POSTs to /transfer-sponsorship/ (#967)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProgramRoutes(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Archive / Close' })).toBeVisible();
    await page.getByRole('button', { name: 'Transfer sponsorship…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Transfer sponsorship' });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole('button', { name: /Confirm transfer/i })).toBeDisabled();

    // Two pickers render (new sponsor + optional new PM); pick the sponsor only.
    await dialog.getByRole('button', { name: 'Assign' }).first().click();
    await dialog.getByRole('option', { name: 'bob' }).click();

    await dialog.getByRole('button', { name: /Confirm transfer/i }).click();
    await expect
      .poll(() => captures.programTransfer?.body)
      .toEqual({ new_owner_user_id: TARGET_USER_ID });
  });

  test('split redistributes projects and POSTs grouped splits to /split/ (#967)', async ({
    page,
  }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProgramRoutes(page, captures);
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/split/`, async (route: Route) => {
      captures.programSplit = { body: route.request().postDataJSON() };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          program: { ...FIXTURE_PROGRAM, is_closed: true },
          sub_programs: [{ ...FIXTURE_PROGRAM, id: NEW_SUB_ID, name: 'Alpha', code: 'ALPHA' }],
        }),
      });
    });
    await page.goto(`/programs/${PROGRAM_ID}/settings/lifecycle`);

    await expect(page.getByRole('heading', { name: 'Archive / Close' })).toBeVisible();
    await page.getByRole('button', { name: 'Split program…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Split into sub-programs' });
    await expect(dialog).toBeVisible();

    // Confirm is gated until the sub-program is named.
    const confirm = dialog.getByRole('button', { name: 'Split program' });
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel('Sub-program 1 name').fill('Alpha');
    await dialog.getByLabel('Assign project Apollo to').selectOption('sub-0');

    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect
      .poll(() => captures.programSplit?.body)
      .toEqual({ splits: [{ name: 'Alpha', project_ids: ['proj-apollo'] }] });
  });

  test('split surfaces a server 400 inline and keeps the dialog open (#967)', async ({ page }) => {
    const captures: Captures = {};
    await setupAuth(page);
    await setupProgramRoutes(page, captures);
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/split/`, async (route: Route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: pj({ detail: 'A program can be split into at most 50 sub-programs.' }),
      });
    });
    await page.goto(`/programs/${PROGRAM_ID}/settings/lifecycle`);

    await page.getByRole('button', { name: 'Split program…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Split into sub-programs' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Sub-program 1 name').fill('Alpha');
    await dialog.getByRole('button', { name: 'Split program' }).click();

    await expect(
      dialog.getByText('A program can be split into at most 50 sub-programs.'),
    ).toBeVisible();
    // The dialog stays open so the user can correct the input.
    await expect(dialog).toBeVisible();
  });
});

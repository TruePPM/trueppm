import { test, expect } from '@playwright/test';

/**
 * Program Settings → General E2E (#523).
 *
 * Verifies the page is wired to the real `/api/v1/programs/:id/` endpoint:
 * - Initial values seed from the GET response (name, description, code,
 *   methodology, health, visibility, lead_detail).
 * - Editing a field arms the save bar.
 * - Clicking Save issues a PATCH carrying the changed fields.
 * - Discard reverts to the seeded snapshot.
 */

const ME_ID = 'user-alice';
const LEAD_ID = 'user-lead';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000523';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_LEAD_DETAIL = {
  id: LEAD_ID,
  username: 'anika.k',
  email: 'anika@example.com',
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  code: 'PH2',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: LEAD_ID,
  lead_detail: FIXTURE_LEAD_DETAIL,
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 2,
  member_count: 1,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, captures: { patch?: Record<string, unknown> }) {
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
      body: pj({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, async (route) => {
    if (route.request().method() === 'PATCH') {
      captures.patch = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...FIXTURE_PROGRAM, ...captures.patch }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(FIXTURE_PROGRAM),
    });
  });
}

test.describe('Program Settings → General', () => {
  test('seeds fields from the API and PATCHes edited values on save', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    await expect(page.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');
    await expect(page.getByLabel('Program code')).toHaveValue('PH2');
    await expect(page.getByLabel('Description')).toHaveValue('Q3 platform rebuild');

    // Lead block renders the username from lead_detail (no hardcoded "Anika Krishnan").
    await expect(page.getByText('anika.k')).toBeVisible();
    await expect(page.getByText('Anika Krishnan')).toHaveCount(0);

    // Edit the name and flip health to At risk.
    await page.getByLabel('Program name').fill('Phase 2 Rebuilt');
    await page.getByRole('button', { name: 'At risk' }).click();

    // Save bar arms — click "Save changes" (provided by SettingsShell).
    await page.getByRole('button', { name: /Save changes/i }).click();

    // PATCH issued with the consolidated payload (waits for the route handler
    // to populate captures.patch).
    await expect.poll(() => captures.patch).toBeDefined();
    expect(captures.patch).toMatchObject({
      name: 'Phase 2 Rebuilt',
      health: 'AT_RISK',
    });
  });

  // #776: settings is a focused mode — ProgramShell suppresses its program header
  // and the Overview/Backlog/Projects/Members tab strip on settings routes, so the
  // shared SettingsShell (and its SCOPE switcher) mounts top-aligned, identical to
  // the workspace and project scopes. Without this the SCOPE switcher jumped ~100px
  // when switching scope, forcing the user to re-find the controls.
  test('suppresses the program tab strip so the settings shell is top-aligned', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
    // The program working chrome is gone on the settings route.
    await expect(page.getByRole('navigation', { name: 'Program sections' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Backlog' })).toHaveCount(0);
    // The settings shell still rendered its nav (a program-settings-only item).
    await expect(page.getByRole('link', { name: 'Risk policy' })).toBeVisible();
  });

  // #776: the context pill is a switcher — from one program's settings you can
  // jump straight to another program's settings (preserving the sub-page),
  // instead of having no path to it.
  test('context pill switches to another program\'s settings', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);

    const PROGRAM_2 = 'e2e-program-00000000-0000-0000-0000-000000000524';
    const pj = (d: unknown) => JSON.stringify(d);
    const FIXTURE_PROGRAM_2 = {
      ...FIXTURE_PROGRAM,
      id: PROGRAM_2,
      name: 'Phase 3 Rollout',
      code: 'PH3',
      health: 'ON_TRACK',
    };
    // Two programs → the switcher renders (registered after setup so it wins).
    await page.route('**/api/v1/programs/', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [FIXTURE_PROGRAM, FIXTURE_PROGRAM_2], count: 2, next: null, previous: null }),
      }),
    );
    await page.route(`**/api/v1/programs/${PROGRAM_2}/`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM_2) }),
    );

    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);
    await expect(page.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');

    // Open the switcher and pick the other program.
    await page.getByRole('button', { name: /Switch program/ }).click();
    await expect(page.getByRole('menu', { name: 'Switch program' })).toBeVisible();
    await page.getByRole('menuitemradio', { name: /Phase 3 Rollout/ }).click();

    // Navigated to program 2's settings, same sub-page (general).
    await page.waitForURL(`**/programs/${PROGRAM_2}/settings/general`);
    await expect(page.getByLabel('Program name')).toHaveValue('Phase 3 Rollout');
    await expect(page.getByRole('button', { name: /Current program: Phase 3 Rollout/ })).toBeVisible();
  });

  test('discard reverts edited fields to the seeded snapshot', async ({ page }) => {
    const captures: { patch?: Record<string, unknown> } = {};
    await setup(page, captures);
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    await expect(page.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');

    await page.getByLabel('Program name').fill('Should Be Discarded');
    await expect(page.getByLabel('Program name')).toHaveValue('Should Be Discarded');

    // The in-page Discard button reverts immediately (no confirmation modal —
    // ConfirmDiscardDialog only gates pending-nav scenarios in SettingsShell).
    await page.getByRole('button', { name: /^Discard$/ }).click();

    await expect(page.getByLabel('Program name')).toHaveValue('Phase 2 Modernization');
    expect(captures.patch).toBeUndefined();
  });
});

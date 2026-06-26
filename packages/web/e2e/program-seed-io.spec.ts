import { test, expect, type Page } from '@playwright/test';

/**
 * Program JSON import E2E (#615).
 *
 * Drives the real /programs UI against mocked API routes: the "Import from
 * JSON" affordance uploads a seed file, lands the user on the imported program
 * (golden path), and surfaces the server's line-level error report when the
 * seed is rejected (error state).
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-seed-00000000-0000-0000-0000-000000000613';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  max_project_role: 400,
  workspace_role: null,
  can_access_admin_settings: false,
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Atlas Platform Launch',
  description: '',
  code: 'atlas',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  color: null,
  lead: null,
  created_by: ME_ID,
  created_at: '2026-06-06T00:00:00Z',
  updated_at: '2026-06-06T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 3,
  member_count: 1,
};

const pj = (o: unknown) => JSON.stringify(o);

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
  // Catch-all fallback so no shell endpoint reaches a real backend, where the
  // fixture token would 401 and raise the session-expired modal. Registered
  // first → Playwright (last-registered-wins) lets the specific routes win.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
  // Ungrouped-projects section + any other index fetches resolve empty.
  await page.route('**/api/v1/projects/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null, due_today_count: 0 }),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
}

const SAMPLE_SEED = Buffer.from(JSON.stringify({ schema_version: '1.0' }));

test.describe('Program JSON import', () => {
  test('imports a seed file and lands on the new program', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/import/', (r) =>
      r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
    );
    await page.goto('/programs');

    await page
      .getByRole('button', { name: /Import from JSON/i })
      .first()
      .click();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'atlas.json',
      mimeType: 'application/json',
      buffer: SAMPLE_SEED,
    });

    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview`));
  });

  test('surfaces the server validation errors when the seed is rejected', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/import/', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: pj({ detail: ['$.program.name: required and missing'] }),
      }),
    );
    await page.goto('/programs');

    await page
      .getByRole('button', { name: /Import from JSON/i })
      .first()
      .click();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{}'),
    });

    await expect(page.getByText(/Could not import this file/i)).toBeVisible();
    await expect(page.getByText(/program\.name: required and missing/i)).toBeVisible();
  });
});

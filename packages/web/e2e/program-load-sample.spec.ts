import { test, expect, type Page } from '@playwright/test';

/**
 * "Load demo data" E2E (#375).
 *
 * From the empty Programs index, one click loads the bundled sample program and
 * drops the user onto it.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-sample-00000000-0000-0000-0000-000000000375';

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
  name: 'Atlas Platform Launch',
  description: '',
  code: 'atlas-platform-launch',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  color: '#2E5AAC',
  lead: null,
  created_by: ME_ID,
  created_at: '2026-06-06T00:00:00Z',
  updated_at: '2026-06-06T00:00:00Z',
  my_role: 400,
  my_role_label: 'Project Admin',
  project_count: 3,
  member_count: 15,
  is_sample: true,
  is_closed: false,
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
  await page.route('**/api/v1/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ results: [], count: 0, next: null, previous: null }),
    }),
  );
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

test.describe('Load demo data', () => {
  test('loads the sample program and lands on it', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/load-sample/', (r) =>
      r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
    );
    await page.goto('/programs');

    await page.getByRole('button', { name: /Load demo data/i }).click();

    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview`));
  });
});

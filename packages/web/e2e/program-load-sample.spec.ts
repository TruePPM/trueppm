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
  await page.route('**/api/v1/programs/samples/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([
        {
          key: 'atlas-platform-launch',
          title: 'Atlas Platform Launch',
          description: 'Hybrid-large.',
        },
        { key: 'aurora-mobile-app', title: 'Aurora Mobile App', description: 'Agile-only.' },
      ]),
    }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  // The program overview also fetches the rollup; the catch-all above would
  // otherwise return the program shape, and `Object.entries(rollup.kpis)`
  // throws on the missing `kpis`, crashing the page before the banner renders.
  // Registered last so it wins over the catch-all for this specific path.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        aggregation_policy: 'average',
        policy_available: true,
        project_count: 3,
        program_health: 'on_track',
        kpis: {},
      }),
    }),
  );
}

test.describe('Load demo data', () => {
  test('picks a sample and lands on the loaded program', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/load-sample/', (r) =>
      r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
    );
    await page.goto('/programs');

    // The empty state shows the loader both in the header and the hero; the
    // header button comes first in DOM order. With more than one bundled sample,
    // the button opens a picker.
    await page.getByRole('button', { name: /Load demo data/i }).first().click();
    await page.getByRole('menuitem', { name: /Atlas Platform Launch/i }).click();

    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview`));
  });

  test('remove-sample confirm warns that user changes are also deleted (#1053)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    // The sample banner is owner-visible (my_role 400); revealing its confirm
    // step must spell out that the teardown also removes the evaluator's edits.
    await page.getByRole('button', { name: /Remove sample data/i }).click();
    await expect(page.getByText(/including any changes you made/i)).toBeVisible();
    await expect(page.getByText(/your own projects are not affected/i)).toBeVisible();
  });
});

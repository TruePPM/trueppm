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
  max_project_role: 400,
  workspace_role: null,
  can_access_admin_settings: false,
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
  // Catch-all fallback so no shell endpoint (notifications, active sprints,
  // presence, …) reaches a real backend, where the fixture token would 401 and
  // raise the session-expired modal that blocks every click. Registered first,
  // so Playwright (last-registered-wins) lets the specific routes below win.
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

  test('the sample projects appear in the sidebar without a manual refresh', async ({ page }) => {
    await setup(page);

    // Stateful projects endpoint: empty until the sample is loaded, then it
    // returns the sample's projects. This models the real backend, where
    // load-sample creates a program *and* its projects in one transaction.
    // The project is registered with `program: null` so it lands in the
    // always-visible standalone "Projects" sidebar section, isolating the
    // refetch behavior from program-group expand/collapse state.
    let sampleLoaded = false;
    const SAMPLE_PROJECT = {
      id: 'e2e-sample-proj-00000000-0000-0000-0000-000000000001',
      name: 'Atlas Core Platform',
      description: '',
      start_date: '2026-06-06',
      calendar: 'cal-1',
      methodology: 'HYBRID',
      program: null,
    };
    await page.route('**/api/v1/projects/**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          results: sampleLoaded ? [SAMPLE_PROJECT] : [],
          count: sampleLoaded ? 1 : 0,
          next: null,
          previous: null,
          due_today_count: 0,
        }),
      }),
    );
    await page.route('**/api/v1/programs/load-sample/', (r) => {
      sampleLoaded = true;
      r.fulfill({ status: 201, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) });
    });

    await page.goto('/programs');

    const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
    const projectRow = nav.getByRole('button', { name: 'Atlas Core Platform, health unknown' });

    // Not present before the sample is loaded.
    await expect(projectRow).toHaveCount(0);

    // The invalidation triggers a *second* GET /projects/ — the one that runs
    // after the sample is loaded (so the mock returns the new project). Wait on
    // it explicitly rather than racing the async refetch + re-render against a
    // fixed assertion timeout.
    const refetch = page.waitForResponse(
      (res) =>
        res.url().includes('/api/v1/projects/') &&
        res.request().method() === 'GET' &&
        sampleLoaded,
    );

    await page.getByRole('button', { name: /Load demo data/i }).first().click();
    await page.getByRole('menuitem', { name: /Atlas Platform Launch/i }).click();
    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview`));

    // The mutation invalidates ['projects'], so the sidebar refetches and shows
    // the new project — no page.reload() here is the whole point of the test.
    await refetch;
    await expect(projectRow).toBeVisible();
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

import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → Projects E2E (#524).
 *
 * Verifies the page is wired to the real `/api/v1/programs/:id/projects/`
 * endpoint and surfaces loading, empty, and populated states — and that
 * the "Preview — not yet saved" stub banner no longer renders.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000524';

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
  project_count: 2,
  member_count: 1,
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, projects: Array<Record<string, unknown>>) {
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

  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(projects) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

test.describe('Program Settings → Projects', () => {
  test('renders real projects from the API and no stub banner', async ({ page }) => {
    await setup(page, [
      {
        id: 'pr-1',
        name: 'Artemis IV Lift',
        description: '',
        start_date: '2026-01-01',
        methodology: 'WATERFALL',
        program: PROGRAM_ID,
      },
      {
        id: 'pr-2',
        name: 'Launch Control Software',
        description: '',
        start_date: '2026-01-01',
        methodology: 'AGILE',
        program: PROGRAM_ID,
      },
    ]);

    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByText('Artemis IV Lift')).toBeVisible();
    await expect(page.getByText('Launch Control Software')).toBeVisible();
    await expect(page.getByText(/2 projects/)).toBeVisible();
    // Admin (role 400) gets the bulk-edit matrix: an action bar + per-row selection.
    await expect(page.getByTestId('bulk-fields-action-bar')).toBeVisible();
    await expect(page.getByLabel('Select Artemis IV Lift')).toBeVisible();

    // The hardcoded fixture row from the stub page must not appear.
    await expect(page.getByText('Ground Support Equipment')).toHaveCount(0);

    // The stub banner must not render on a wired page.
    await expect(page.getByTestId('stub-page-banner')).toHaveCount(0);
  });

  test('admin bulk-sets a field on the selected projects (issue 1233)', async ({ page }) => {
    await setup(page, [
      { id: 'pr-1', name: 'Artemis IV Lift', description: '', start_date: '2026-01-01', methodology: 'WATERFALL', program: PROGRAM_ID },
      { id: 'pr-2', name: 'Launch Control Software', description: '', start_date: '2026-01-01', methodology: 'AGILE', program: PROGRAM_ID },
    ]);
    let posted: { ids: string[]; fields: Record<string, unknown> } | null = null;
    await page.route(`**/api/v1/programs/${PROGRAM_ID}/bulk-project-fields/`, async (route) => {
      posted = route.request().postDataJSON() as { ids: string[]; fields: Record<string, unknown> };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ updated: posted.ids.map((id) => ({ id, server_version: 2 })), fields: Object.keys(posted.fields) }),
      });
    });

    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // Select one project, stage a methodology value, apply. The settings page is the
    // consolidated SettingsShell (rule 195) — all sections mount at once, so the
    // General section's own Methodology radiogroup also has an "Agile" radio. Scope to
    // the bulk action bar to avoid the strict-mode collision.
    await page.getByLabel('Select Artemis IV Lift').check();
    const bar = page.getByTestId('bulk-fields-action-bar');
    await bar.getByRole('radio', { name: 'Agile' }).click();
    await page.getByTestId('bulk-fields-apply').click();

    await expect.poll(() => posted).not.toBeNull();
    expect(posted!.ids).toEqual(['pr-1']);
    expect(posted!.fields).toEqual({ methodology: 'AGILE' });
  });

  test('shows empty state when the program has no projects', async ({ page }) => {
    await setup(page, []);
    await page.goto(`/programs/${PROGRAM_ID}/settings/projects`);

    await expect(page.getByText(/No projects in this program yet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Add project/i })).toBeVisible();
  });
});

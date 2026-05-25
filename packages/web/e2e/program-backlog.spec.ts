import { test, expect } from '@playwright/test';

/**
 * Program backlog E2E (#742).
 *
 * The backlog UI is fixture-backed until ADR-0069's endpoints land (#737), so
 * the data comes from the client-side fixture, not the API. These tests only
 * stub the surrounding program endpoints (auth, edition, program detail) and
 * then drive the real UI: search → select → pull → undo (golden path), and the
 * no-results recovery state.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000000742';

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
  name: 'Artemis Program',
  description: 'Crewed lift program',
  code: 'ARTM',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400, // Owner (ROLE_OWNER) — can create / pull / delete
  my_role_label: 'Project Admin',
  project_count: 4,
  member_count: 4,
};

type Page = import('@playwright/test').Page;

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

  const pj = (data: unknown) => JSON.stringify(data);

  // Default everything to empty so unmocked calls don't 401-loop.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROGRAM) }),
  );

  await page.goto(`/programs/${PROGRAM_ID}/backlog`);
}

test.describe('Program backlog', () => {
  test('golden path — search, select, pull, undo', async ({ page }) => {
    await setup(page);

    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    const row = page.getByRole('button', { name: 'BI-003: Telemetry channel B (redundant link)' });
    await expect(row).toBeVisible();

    // Search narrows the match counter.
    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('Telemetry');
    await expect(page.getByText('1 of 9')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();

    // Select → detail pane.
    await row.click();
    await expect(
      page.getByRole('heading', { name: 'Telemetry channel B (redundant link)' }),
    ).toBeVisible();

    // Enter the pull flow and confirm to Avionics.
    await page.getByRole('button', { name: 'Pull to project…' }).click();
    await expect(page.getByText('Target project')).toBeVisible();
    await page.getByRole('radio', { name: /Avionics/ }).click();
    await page.getByRole('button', { name: 'Pull to Avionics' }).click();

    // Optimistic success toast with an undo affordance.
    await expect(page.getByText('Pulled to Avionics.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  test('no-results state offers recovery', async ({ page }) => {
    await setup(page);

    await page.getByRole('searchbox', { name: 'Search backlog' }).fill('quasar');
    await expect(page.getByText('Nothing matches "quasar"')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible();
  });
});

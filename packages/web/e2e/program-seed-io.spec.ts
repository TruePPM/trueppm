import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

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
  my_role_label: 'Program Admin',
  project_count: 3,
  member_count: 1,
};

// GET /programs/:id/rollup/ (ADR-0088, #713) — object-shaped, distinct from the
// Program resource above. The broad `**/programs/${PROGRAM_ID}/**` route below
// also matches this path; without a dedicated route the rollup GET resolves to
// FIXTURE_PROGRAM (no `kpis` key), and ProgramOverviewPage's
// `Object.entries(rollup.kpis)` throws into the root error boundary — a crash
// the golden-path test doesn't notice because its only assertion is the URL,
// which navigation already satisfies before the crash (issue 1572 / #1190 class).
const FIXTURE_ROLLUP = {
  aggregation_policy: 'worst',
  policy_available: true,
  project_count: 3,
  program_health: 'on_track',
  kpis: {},
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
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200-list body (the #1190 flake class).
  await setupCatchAll(page);
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
  // Registered AFTER the broad `**/programs/${PROGRAM_ID}/**` route above so it
  // wins (Playwright: last-registered-wins) for this more specific path.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ROLLUP) }),
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
    // Assert the overview actually rendered rather than crashing into the root
    // error boundary post-navigation (issue 1572): the heading names the
    // imported program, and the health hero (fed by the rollup fixture above)
    // confirms useProgramRollup resolved without throwing.
    await expect(page.getByRole('heading', { name: FIXTURE_PROGRAM.name })).toBeVisible();
    await expect(page.getByText('On track')).toBeVisible();
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

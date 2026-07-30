import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program JSON import E2E (#615).
 *
 * Drives the real /programs UI against mocked API routes: the "Import from
 * JSON" affordance uploads a seed file, lands the user on the imported program
 * (golden path), and surfaces the server's line-level error report when the
 * seed is rejected (error state).
 *
 * Since ADR-0726 the endpoint answers `202` with a job handle, so the button
 * polls the job to a terminal state before navigating, and a `409` naming a
 * program the seed's slug collides with becomes a confirmation (#2581).
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-seed-00000000-0000-0000-0000-000000000613';
const JOB_ID = 'e2e-seed-job-0000-0000-0000-000000002574';

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

/** The 202 envelope — the program shell already exists at `program_id`. */
const QUEUED = {
  queued: true,
  program_id: PROGRAM_ID,
  import_request_id: JOB_ID,
  replaced_program_id: null,
};

/**
 * GET /programs/{id}/import/jobs/{job}/ — object-shaped. It sits under the broad
 * `**‍/programs/${PROGRAM_ID}/**` route below, which would otherwise answer it
 * with FIXTURE_PROGRAM (no `status` key) and strand the button in "Building…".
 */
function importJob(status: 'pending' | 'running' | 'success' | 'failed', errorDetail = '') {
  return {
    id: JOB_ID,
    program: PROGRAM_ID,
    status,
    filename: 'atlas.json',
    replace: false,
    replaced_program_id: null,
    result_summary:
      status === 'success' ? { projects: 3, tasks: 12, sprints: 0, dependencies: 0 } : {},
    error_detail: errorDetail,
    expires_at: null,
    created_at: '2026-06-06T00:00:00Z',
    started_at: null,
    completed_at: null,
  };
}

/** The 409 body — what a confirmed re-import would tear down (#2581). */
const REPLACE_CONFLICT = {
  detail: 'A program you own already uses the code "atlas". Confirm to continue.',
  code: 'seed_replace_required',
  conflict: {
    program_id: 'e2e-live-0000-0000-0000-000000002581',
    name: 'Atlas Platform Launch',
    code: 'atlas',
    project_count: 3,
    task_count: 812,
  },
};

/**
 * Registered AFTER `setup()` so it beats the broad program route (Playwright is
 * last-registered-wins).
 */
async function routeImportJob(
  page: Page,
  status: 'pending' | 'running' | 'success' | 'failed',
  errorDetail = '',
) {
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/import/jobs/${JOB_ID}/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(importJob(status, errorDetail)),
    }),
  );
}

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
      r.fulfill({ status: 202, contentType: 'application/json', body: pj(QUEUED) }),
    );
    await routeImportJob(page, 'success');
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

  test('asks before replacing a colliding program, then re-sends with the token', async ({
    page,
  }) => {
    await setup(page);
    const importBodies: string[] = [];
    await page.route('**/api/v1/programs/import/', async (r) => {
      const body = r.request().postData() ?? '';
      importBodies.push(body);
      // Only the unconfirmed attempt collides.
      if (body.includes('name="replace"')) {
        await r.fulfill({ status: 202, contentType: 'application/json', body: pj(QUEUED) });
        return;
      }
      await r.fulfill({
        status: 409,
        contentType: 'application/json',
        body: pj(REPLACE_CONFLICT),
      });
    });
    await routeImportJob(page, 'success');
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

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Replace “Atlas Platform Launch”?');
    await expect(confirm).toContainText('3 projects and 812 tasks');
    await expect(confirm).toContainText(
      'Its projects move to Trash and can be restored individually as standalone projects.',
    );
    await expect(confirm).toContainText('The program itself is not recoverable.');

    await confirm.getByRole('button', { name: 'Replace program' }).click();

    await expect(page).toHaveURL(new RegExp(`/programs/${PROGRAM_ID}/overview`));
    expect(importBodies).toHaveLength(2);
    expect(importBodies[0]).not.toContain('name="replace"');
    expect(importBodies[1]).toContain('name="expected_program_id"');
    expect(importBodies[1]).toContain(REPLACE_CONFLICT.conflict.program_id);
  });

  test('cancelling the replace confirmation imports nothing', async ({ page }) => {
    await setup(page);
    let importCalls = 0;
    await page.route('**/api/v1/programs/import/', async (r) => {
      importCalls += 1;
      await r.fulfill({
        status: 409,
        contentType: 'application/json',
        body: pj(REPLACE_CONFLICT),
      });
    });
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

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();

    await expect(confirm).toBeHidden();
    await expect(page).toHaveURL(/\/programs$/);
    expect(importCalls).toBe(1);
  });

  test('surfaces the job error_detail when the background build fails', async ({ page }) => {
    await setup(page);
    await page.route('**/api/v1/programs/import/', (r) =>
      r.fulfill({ status: 202, contentType: 'application/json', body: pj(QUEUED) }),
    );
    await routeImportJob(page, 'failed', 'Seed references an unknown resource "ghost".');
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

    await expect(page.getByText('Seed references an unknown resource "ghost".')).toBeVisible();
    await expect(page).toHaveURL(/\/programs$/);
  });
});

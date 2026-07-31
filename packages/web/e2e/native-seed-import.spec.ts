import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * Native TruePPM seed import E2E (#1611, ADR-0222).
 *
 * The create-from-import dialog's "TruePPM" format tile is a real choice in the
 * standalone (Sidebar) entry: picking it swaps the accepted file type to .json
 * and imports the native canonical seed through POST /programs/import/, which
 * re-materializes a whole program. Since ADR-0726 that endpoint answers `202`
 * with a job handle and the client polls it to a terminal state.
 *
 * Golden path: pick TruePPM → upload .json → import → poll → land on the new
 * program's overview. Error path: a validation 400 surfaces the server's
 * line-level report inline. Replace path: a 409 becomes a confirmation naming
 * the program it would tear down, and confirming re-sends with the
 * compare-and-swap token (#2581).
 */

const NEW_PROGRAM_ID = 'e2e-imported-program-0000-0000-000000001611';
const JOB_ID = 'e2e-import-job-0000-0000-0000-000000002574';

/**
 * GET /programs/{id}/import/jobs/{job}/ — object-shaped, so it needs its own
 * route: the catch-all answers a paginated LIST envelope, and a component that
 * reads `status` off that gets `undefined` and never leaves the building state.
 */
function importJob(status: 'pending' | 'running' | 'success' | 'failed', errorDetail = '') {
  return {
    id: JOB_ID,
    program: NEW_PROGRAM_ID,
    status,
    filename: 'atlas.json',
    replace: false,
    replaced_program_id: null,
    result_summary: status === 'success' ? { projects: 1, tasks: 0, sprints: 0, dependencies: 0 } : {},
    error_detail: errorDetail,
    expires_at: null,
    created_at: '2026-07-30T00:00:00Z',
    started_at: null,
    completed_at: null,
  };
}

/** The 202 envelope: the program shell already exists at `program_id`. */
const QUEUED = {
  queued: true,
  program_id: NEW_PROGRAM_ID,
  import_request_id: JOB_ID,
  replaced_program_id: null,
};

/** The 409 body — what a confirmed re-import would tear down. */
const REPLACE_CONFLICT = {
  detail: 'A program you own already uses the code "atlas". Confirm to continue.',
  code: 'seed_replace_required',
  conflict: {
    program_id: 'e2e-live-program-0000-0000-000000002581',
    name: 'Atlas Platform Launch',
    code: 'atlas',
    project_count: 3,
    task_count: 812,
  },
};

// A minimal native seed body. The server is fully mocked here, so the exact
// contents are irrelevant to the assertions — the dropzone only checks the
// .json extension and size before the mocked import responds.
const SEED_JSON = JSON.stringify({
  schema_version: '1.0',
  program: { slug: 'atlas', name: 'Atlas', methodology: 'HYBRID' },
  projects: [{ slug: 'web', name: 'Web', tasks: [] }],
});

async function openImportDialog(page: import('@playwright/test').Page) {
  // Seed the auth store so the shell renders instead of redirecting to login.
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await setupCatchAll(page);
  await setupApiMocks(page);
  // Programs list — feeds both the /programs index and the sidebar section.
  await page.route('**/api/v1/programs/', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      });
    }
    return route.continue();
  });

  await page.goto('/programs');

  // The New-project / Import affordances now live behind the rail's Tier-3
  // "Browse projects and programs" switcher (#1642) — open it first.
  const browse = page.getByRole('button', { name: 'Browse projects and programs' });
  await expect(browse).toBeVisible();
  await browse.click();

  const importButton = page.getByRole('button', { name: 'Import a project from a file' });
  await expect(importButton).toBeVisible();
  await importButton.click();

  const dialog = page.getByRole('dialog', { name: 'Import a project' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('imports a native TruePPM .json seed and lands on the new program overview', async ({
  page,
}) => {
  const dialog = await openImportDialog(page);

  // Registered AFTER openImportDialog (which registers the catch-all) so these
  // more-specific routes win — Playwright checks routes last-registered first.
  // Import returns the 202 job handle; the poll lands it and the modal
  // hands the program id up so the shell navigates.
  await page.route('**/api/v1/programs/import/', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(QUEUED),
    }),
  );
  await page.route(`**/api/v1/programs/${NEW_PROGRAM_ID}/import/jobs/${JOB_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(importJob('success')),
    }),
  );

  // Pick the native TruePPM format — now a real, selectable tile.
  const truePpmTile = dialog.getByRole('radio', { name: /Native export/ });
  await truePpmTile.click();
  await expect(truePpmTile).toHaveAttribute('aria-checked', 'true');
  // The file-type section swaps to the canonical JSON seed.
  await expect(dialog.getByText('Canonical TruePPM seed')).toBeVisible();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page).toHaveURL(`/programs/${NEW_PROGRAM_ID}/overview`);
});

test('shows the server line-level validation report when a seed is rejected', async ({ page }) => {
  const dialog = await openImportDialog(page);

  // After setup, so this specific route wins over the catch-all.
  await page.route('**/api/v1/programs/import/', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        detail: ['$.projects[0].tasks[0].assignee: unknown account "ghost"'],
      }),
    }),
  );

  await dialog.getByRole('radio', { name: /Native export/ }).click();

  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText('unknown account "ghost"');
  // The user stays in the dialog and can retry with a different file.
  await expect(dialog.getByRole('button', { name: 'Try a different file' })).toBeVisible();
});

test('turns the replace 409 into a confirmation and re-sends with the compare-and-swap token', async ({
  page,
}) => {
  const dialog = await openImportDialog(page);

  const importBodies: string[] = [];
  await page.route('**/api/v1/programs/import/', async (route) => {
    const body = route.request().postData() ?? '';
    importBodies.push(body);
    // The first, unconfirmed attempt collides; the confirmed retry is accepted.
    if (body.includes('name="replace"')) {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify(QUEUED),
      });
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify(REPLACE_CONFLICT),
    });
  });
  await page.route(`**/api/v1/programs/${NEW_PROGRAM_ID}/import/jobs/${JOB_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(importJob('success')),
    }),
  );

  await dialog.getByRole('radio', { name: /Native export/ }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  // Not an error dump: a confirmation that names the program, its counts, and
  // exactly what survives.
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Replace “Atlas Platform Launch”?');
  await expect(confirm).toContainText('3 projects and 812 tasks');
  await expect(confirm).toContainText(
    'Its projects move to Trash and can be restored individually as standalone projects.',
  );
  await expect(confirm).toContainText('The program itself is not recoverable.');

  await confirm.getByRole('button', { name: 'Replace program' }).click();

  await expect(page).toHaveURL(`/programs/${NEW_PROGRAM_ID}/overview`);
  expect(importBodies).toHaveLength(2);
  expect(importBodies[0]).not.toContain('name="replace"');
  expect(importBodies[1]).toContain('name="expected_program_id"');
  expect(importBodies[1]).toContain(REPLACE_CONFLICT.conflict.program_id);
});

test('surfaces the job error_detail when the background build fails', async ({ page }) => {
  const dialog = await openImportDialog(page);

  await page.route('**/api/v1/programs/import/', (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(QUEUED),
    }),
  );
  await page.route(`**/api/v1/programs/${NEW_PROGRAM_ID}/import/jobs/${JOB_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(importJob('failed', 'Seed references an unknown resource "ghost".')),
    }),
  );

  await dialog.getByRole('radio', { name: /Native export/ }).click();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'atlas.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SEED_JSON),
  });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(dialog.getByRole('alert')).toContainText(
    'Seed references an unknown resource "ghost".',
  );
  await expect(dialog.getByRole('button', { name: 'Try a different file' })).toBeVisible();
});

import { test, expect } from '@playwright/test';

/**
 * #223 — Risk register CSV import (symmetric counterpart of the #222 export,
 * ADR-0043 addendum).
 *
 * Golden path: a Member opens the Import CSV modal from the toolbar, uploads a
 * file, and sees the result summary (imported count + skipped rows + warnings).
 * Error path: the server rejects the file (413/400) and the modal surfaces the
 * detail message. RBAC: a Viewer never sees the Import affordance.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-riski-00000000-0000-0000-0000-000000000223';
const ME_ID = 'me-00000000-0000-0000-0000-000000000001';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Risk Import Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
};

const FIXTURE_RISK = {
  id: 'risk-001',
  short_id: '00000001',
  short_id_display: 'R-001',
  qualified_id: 'RI-R-001',
  server_version: 1,
  project: PROJECT_ID,
  title: 'Existing risk',
  description: '',
  status: 'OPEN',
  probability: 3,
  impact: 3,
  severity: 9,
  owner: ME_ID,
  owner_name: 'Me Myself',
  owner_initials: 'MM',
  created_by: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  tasks: [],
  category: 'TECHNICAL',
  response: 'MITIGATE',
  mitigation_due_date: null,
  trigger: '',
  contingency: '',
};

type Page = import('@playwright/test').Page;
type Route = import('@playwright/test').Route;

/** `role` drives the membership response so RBAC gating can be exercised. */
async function setup(page: Page, opts: { role?: number; onImport?: (r: Route) => void } = {}) {
  const role = opts.role ?? 100; // MEMBER by default

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  // Benign fallback for any authenticated-shell endpoint this spec does not
  // mock explicitly. Registered FIRST so the specific routes below win.
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );

  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: ME_ID,
        username: 'me',
        display_name: 'Me Myself',
        initials: 'MM',
        email: 'me@example.com',
        max_project_role: role,
        workspace_role: null,
        can_access_admin_settings: false,
      }),
    }),
  );
  await page.route('**/api/v1/auth/token/refresh/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access: 'e2e-token' }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/me/notifications/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 1,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  // useCurrentUserRole reads members?self=true → first row's role drives the gate.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-self', role }]),
    }),
  );
  await page.route('**/api/v1/projects/*/risks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_RISK]) }),
  );
  // Import route registered AFTER the risks-list route so it takes precedence.
  await page.route('**/api/v1/projects/*/risks/import/', (r) => {
    if (opts.onImport) opts.onImport(r);
    else
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ imported: 0, skipped: 0, errors: [], warnings: [] }),
      });
  });
}

async function gotoRisks(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/risk`);
  await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Risk register — CSV import', () => {
  test('Member imports a CSV and sees the result summary', async ({ page }) => {
    await setup(page, {
      onImport: (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            imported: 2,
            skipped: 1,
            errors: [{ row: 4, field: 'Title', message: 'Title is required.' }],
            warnings: [
              { row: 3, field: 'Owner', message: 'No member matches "ghost"; left unassigned.' },
            ],
          }),
        }),
    });
    await gotoRisks(page);

    // Open the modal from the toolbar.
    await page.getByRole('button', { name: 'Import CSV' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import risks from CSV' });
    await expect(dialog).toBeVisible();

    // The Import action is disabled until a file is chosen.
    await expect(dialog.getByRole('button', { name: 'Import' })).toBeDisabled();

    // Attach a CSV via the hidden file input.
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'risks.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Title\nServer outage\nVendorDelay'),
    });
    await expect(dialog.getByText('risks.csv', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Import' }).click();

    // Result view — counts + per-row diagnostics.
    await expect(dialog.getByText(/Imported 2 risks, skipped 1\./)).toBeVisible();
    await expect(dialog.getByText(/Row 4 · Title: Title is required\./)).toBeVisible();
    await expect(dialog.getByText(/Row 3 · Owner:/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('surfaces the server error when the file is rejected', async ({ page }) => {
    await setup(page, {
      onImport: (r) =>
        r.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'File too large (limit 2 MB).' }),
        }),
    });
    await gotoRisks(page);

    await page.getByRole('button', { name: 'Import CSV' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import risks from CSV' });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'huge.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Title\nx'),
    });
    await dialog.getByRole('button', { name: 'Import' }).click();

    await expect(dialog.getByText(/File too large \(limit 2 MB\)\./)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Try a different file' })).toBeVisible();
  });

  test('a Viewer never sees the Import affordance', async ({ page }) => {
    await setup(page, { role: 0 }); // VIEWER
    await gotoRisks(page);

    // Export still shows (read action); Import does not (write-gated).
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import CSV' })).toHaveCount(0);
  });
});

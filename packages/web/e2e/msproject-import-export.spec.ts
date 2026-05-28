import { test, expect } from '@playwright/test';

/**
 * MS Project import/export E2E (#68).
 *
 * Drives the real UI against Playwright-mocked API routes: open the project
 * actions menu, import a .xml file (success + hard-error states), and export
 * the schedule. Auth + role are seeded so the admin-gated Import item shows.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  { id: FIXTURE_PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' },
];

const FIXTURE_API_TASKS = [
  { id: 't1', wbs_path: '1', name: 'Alpha Platform Upgrade', early_start: '2026-10-05', early_finish: '2026-11-14', duration: 30, percent_complete: 40, is_critical: false, is_milestone: false },
];

async function gotoSchedule(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_PROJECTS.length, next: null, previous: null, results: FIXTURE_API_PROJECTS }) }),
  );
  // Admin membership so the Import (admin-gated) menu item renders.
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ role: 300 }]) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: FIXTURE_API_TASKS.length, next: null, previous: null, results: FIXTURE_API_TASKS }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openImportModal(page: import('@playwright/test').Page) {
  await gotoSchedule(page);
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Import from MS Project…' }).click();
  await expect(page.getByRole('dialog', { name: 'Import from MS Project' })).toBeVisible();
}

const SAMPLE_XML = Buffer.from('<Project><Tasks/></Project>');

test.describe('MS Project import', () => {
  test('imports a .xml file and shows the queued confirmation', async ({ page }) => {
    await page.route('**/api/v1/projects/*/import/msproject/', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ detail: 'Import queued.', import_request_id: 'imp-1' }) }),
    );
    await openImportModal(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'plan.xml',
      mimeType: 'application/xml',
      buffer: SAMPLE_XML,
    });
    await expect(page.getByText('plan.xml', { exact: true })).toBeVisible();

    await page.getByRole('dialog', { name: 'Import from MS Project' }).getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText(/Import started\. Your tasks will appear/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog', { name: 'Import from MS Project' })).toBeHidden();
  });

  test('surfaces the server error message when the import is rejected', async ({ page }) => {
    await page.route('**/api/v1/projects/*/import/msproject/', (route) =>
      route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'File too large (99999999 bytes). Maximum: 50 MB.' }) }),
    );
    await openImportModal(page);

    await page.locator('input[type="file"]').setInputFiles({
      name: 'plan.xml',
      mimeType: 'application/xml',
      buffer: SAMPLE_XML,
    });
    await page.getByRole('dialog', { name: 'Import from MS Project' }).getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByRole('alert')).toContainText('Maximum: 50 MB');
    await expect(page.getByRole('button', { name: 'Try a different file' })).toBeVisible();
  });

  test('rejects an unsupported file extension before upload', async ({ page }) => {
    await openImportModal(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: 'plan.docx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('nope'),
    });
    await expect(page.getByRole('alert')).toContainText('.mpp, .xml only');
    // The Import button stays disabled because no valid file was selected.
    await expect(page.getByRole('dialog', { name: 'Import from MS Project' }).getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  });
});

test.describe('MS Project export', () => {
  test('exports the schedule as MS Project XML', async ({ page }) => {
    await page.route('**/api/v1/projects/*/export/msproject.xml', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/xml',
        headers: { 'content-disposition': `attachment; filename="project-${FIXTURE_PROJECT_ID}.xml"` },
        body: '<Project><Tasks/></Project>',
      }),
    );
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Project actions' }).click();
    const [response] = await Promise.all([
      page.waitForResponse('**/api/v1/projects/*/export/msproject.xml'),
      page.getByRole('menuitem', { name: 'Export to MS Project (.xml)' }).click(),
    ]);
    expect(response.status()).toBe(200);
    // No error toast should appear on a successful export.
    await expect(page.getByText('Export failed. Please try again.')).toBeHidden();
  });
});

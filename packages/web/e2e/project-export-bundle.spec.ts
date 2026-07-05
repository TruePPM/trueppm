import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Project Settings → Lifecycle → Export bundle E2E (#1266, ADR-0219).
 *
 * The async export bundle card: click "Export bundle…" → POST enqueues a job →
 * the card polls the job endpoint → once ready it offers "Download bundle". Also
 * covers the failure state (job status: failed → error alert). All backend calls
 * are mocked via page.route() so no running backend is required.
 */

const ME_ID = 'user-alice';
const PROJECT_ID = 'e2e-export-00000000-0000-0000-0000-000000001266';
const JOB_ID = 'job-00000000-0000-0000-0000-000000001266';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
};

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Atlas Migration',
  code: 'atlas',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'HYBRID',
};

const ADMIN_MEMBERSHIP = {
  id: 'mem-self',
  server_version: 1,
  project: PROJECT_ID,
  user: ME_ID,
  user_detail: { id: ME_ID, username: 'alice', email: 'alice@example.com' },
  role: 300,
  role_label: 'Project Admin',
};

type Page = import('@playwright/test').Page;

function job(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    project: PROJECT_ID,
    status,
    file_size: status === 'success' ? 4096 : null,
    error_detail: '',
    expires_at: null,
    created_at: '2026-07-05T00:00:00Z',
    started_at: null,
    completed_at: null,
    download_url:
      status === 'success' ? `/api/v1/projects/${PROJECT_ID}/export/jobs/${JOB_ID}/download/` : null,
    ...extra,
  };
}

async function setup(page: Page, jobStatus: 'success' | 'failed') {
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
      body: pj({ results: [FIXTURE_PROJECT], count: 1, next: null, previous: null }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([ADMIN_MEMBERSHIP]) }),
  );

  // POST enqueue → 202 pending. GET (sync seed) → a small JSON doc.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/export/`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: pj(job('pending')),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: pj({ ok: true }) });
  });

  // Poll + download (registered AFTER the export/ route so it wins for jobs URLs).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/export/jobs/**`, async (route) => {
    if (route.request().url().endsWith('/download/')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/gzip',
        body: Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(job(jobStatus, jobStatus === 'failed' ? { error_detail: 'disk full' } : {})),
    });
  });
}

test.describe('Project export bundle card', () => {
  test('golden path — queue then download the async bundle', async ({ page }) => {
    await setup(page, 'success');
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    const startButton = page.getByRole('button', { name: 'Export bundle…' });
    await expect(startButton).toBeVisible();
    await startButton.click();

    // Once the (first) poll resolves to success the button flips to Download.
    const downloadButton = page.getByRole('button', { name: 'Download bundle' });
    await expect(downloadButton).toBeVisible();

    // Clicking it triggers an authenticated blob download.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe('project-atlas.tar.gz');
  });

  test('failure state — a failed job surfaces an error alert', async ({ page }) => {
    await setup(page, 'failed');
    await page.goto(`/projects/${PROJECT_ID}/settings/lifecycle`);

    await page.getByRole('button', { name: 'Export bundle…' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Export failed');
  });
});

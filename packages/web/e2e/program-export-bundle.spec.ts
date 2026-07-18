import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program Settings → General → Export program bundle E2E (#1958, ADR-0219).
 *
 * The async program export bundle card: click "Export program bundle…" → POST
 * enqueues a job → the card polls the job endpoint → once ready it offers
 * "Download bundle". Also covers the failure state (job status: failed → error
 * alert). All backend calls are mocked via page.route() so no running backend
 * is required.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-progexport-00000000-0000-0000-0000-000000001958';
const JOB_ID = 'job-00000000-0000-0000-0000-000000001958';

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
  name: 'Atlas Program',
  description: 'Portfolio rebuild',
  code: 'atlas',
  methodology: 'HYBRID',
  health: 'AUTO',
  visibility: 'WORKSPACE',
  lead: null,
  lead_detail: null,
  created_by: ME_ID,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 1,
  member_count: 1,
  public_sharing: null,
  allow_guests: null,
  effective_public_sharing: false,
  effective_allow_guests: true,
  inherited_public_sharing: false,
  inherited_allow_guests: true,
};

type Page = import('@playwright/test').Page;

function job(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    program: PROGRAM_ID,
    status,
    file_size: status === 'success' ? 8192 : null,
    error_detail: '',
    expires_at: null,
    created_at: '2026-07-14T00:00:00Z',
    started_at: null,
    completed_at: null,
    download_url:
      status === 'success'
        ? `/api/v1/programs/${PROGRAM_ID}/export/jobs/${JOB_ID}/download/`
        : null,
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

  // POST enqueue → 202 pending. (GET on this exact path is the sync seed, unused here.)
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/export/`, async (route) => {
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
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/export/jobs/**`, async (route) => {
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

test.describe('Program export bundle card', () => {
  test('golden path — queue then download the async program bundle', async ({ page }) => {
    await setup(page, 'success');
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    const startButton = page.getByRole('button', { name: 'Export program bundle…' });
    await expect(startButton).toBeVisible();
    await startButton.click();

    // Once the (first) poll resolves to success the button flips to Download.
    const downloadButton = page.getByRole('button', { name: 'Download bundle' });
    await expect(downloadButton).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    expect(download.suggestedFilename()).toBe('program-atlas.tar.gz');
  });

  test('failure state — a failed job surfaces an error alert', async ({ page }) => {
    await setup(page, 'failed');
    await page.goto(`/programs/${PROGRAM_ID}/settings/general`);

    await page.getByRole('button', { name: 'Export program bundle…' }).click();

    const alert = page.getByRole('alert');
    await expect(alert.first()).toBeVisible();
    await expect(alert.first()).toContainText('Export failed');
  });
});

import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Inspect-before-you-import E2E (#2490).
 *
 * "Load demo data" writes an entire program on one click. This covers the path
 * that makes that click informed: reach the listing from the loader, see what
 * each fixture contains, and download the exact bytes the importer will read.
 */

const ME_ID = 'user-alice';
const SHA_ATLAS = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const FIXTURE_BODY = '{"schema_version":"2.0","program":{"slug":"atlas","name":"Atlas"}}';

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

const SAMPLES = [
  {
    key: 'atlas-platform-launch',
    title: 'Atlas Platform Launch',
    description: 'Hybrid-large launch program.',
    filename: 'atlas-platform-launch.json',
    available: true,
    size_bytes: 79544,
    sha256: SHA_ATLAS,
    schema_version: '2.0',
    project_count: 3,
    task_count: 88,
    resource_count: 15,
    download_url: '/api/v1/programs/samples/atlas-platform-launch/download/',
  },
  {
    key: 'aurora-mobile-app',
    title: 'Aurora Mobile App',
    description: 'Agile-only.',
    filename: 'aurora-mobile-app.json',
    available: true,
    size_bytes: 31922,
    sha256: 'b'.repeat(64),
    schema_version: '2.0',
    project_count: 1,
    task_count: 41,
    resource_count: 8,
    download_url: '/api/v1/programs/samples/aurora-mobile-app/download/',
  },
];

const pj = (o: unknown) => JSON.stringify(o);

async function setup(page: Page, { catalogFails = false } = {}) {
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
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ id: 'ws-1', name: 'TrueScope' }),
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
    catalogFails
      ? r.fulfill({ status: 500, contentType: 'application/json', body: pj({ detail: 'boom' }) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: pj(SAMPLES) }),
  );
  await page.route('**/api/v1/programs/samples/*/download/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Content-Disposition': 'attachment; filename="atlas-platform-launch.json"',
        ETag: `"${SHA_ATLAS}"`,
      },
      body: FIXTURE_BODY,
    }),
  );
}

test.describe('Demo data — inspect before you import', () => {
  test('reaches the listing from the loader and downloads a fixture', async ({ page }) => {
    await setup(page);
    await page.goto('/programs');

    // The picker answers "how much is this about to write?" in the row itself.
    await page
      .getByRole('button', { name: /Load demo data/i })
      .first()
      .click();
    await expect(page.getByText('3 projects · 88 tasks')).toBeVisible();

    // The audit path opens in a new tab so the picker survives the detour.
    const inspect = page.getByRole('menuitem', { name: /Inspect files/i });
    await expect(inspect).toHaveAttribute('target', '_blank');
    await expect(inspect).toHaveAttribute('href', '/settings/demo-data');

    // Follow it directly rather than driving a real popup — the target is the
    // assertion above; what matters here is what the destination renders.
    await page.goto('/settings/demo-data');

    await expect(page.getByRole('heading', { name: 'Demo data' })).toBeVisible();
    for (const sample of SAMPLES) {
      await expect(page.getByText(sample.title, { exact: true })).toBeVisible();
    }
    await expect(page.getByText('77.7 KB')).toBeVisible();
    await expect(page.getByText(`sha256 ${SHA_ATLAS.slice(0, 8)}…`)).toBeVisible();

    const download = page.waitForEvent('download');
    await page
      .getByRole('link', { name: 'Download' })
      .first()
      .click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('atlas-platform-launch.json');
  });

  test('names the procedural-seed asymmetry rather than implying four files is all of it', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings/demo-data');

    await expect(page.getByText(/Two demo programs are not files/)).toBeVisible();
  });

  test('shows an error state with a working retry when the catalog fails', async ({ page }) => {
    await setup(page, { catalogFails: true });
    await page.goto('/settings/demo-data');

    await expect(page.getByText("Couldn't load the sample list")).toBeVisible();

    // Unblock, then retry — the rows appear without a reload.
    await page.route('**/api/v1/programs/samples/', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: pj(SAMPLES) }),
    );
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect(page.getByText('Atlas Platform Launch', { exact: true })).toBeVisible();
  });
});

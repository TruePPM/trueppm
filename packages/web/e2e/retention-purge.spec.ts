import { test, expect } from '@playwright/test';

/**
 * Workspace Settings → Retention & purge E2E (#693, ADR-0173).
 *
 * Operator editor backed by GET/PATCH /api/v1/health/retention/, the impact
 * estimate, and the run endpoint. Covers:
 * - Golden path: 5 retention rows + schedule + recent-purges log render.
 * - Lower a window → irreversibility warning appears → Save fires a PATCH.
 * - Empty log empty-state copy.
 */

const FIXTURE_ME = {
  id: 'user-admin',
  username: 'admin',
  display_name: 'Admin',
  initials: 'AD',
  email: 'admin@example.com',
};

const POLICY = (key: string, label: string, value: number, unit = 'days', enabled = true) => ({
  key,
  label,
  note: `${label} note`,
  unit,
  value,
  enabled,
  row_count: 1234,
  bytes: 480_000_000,
});

const FIXTURE_RETENTION = {
  policies: [
    POLICY('HISTORY_RETENTION_DAYS', 'Event history', 90),
    POLICY('TASK_RUN_RETENTION_DAYS', 'Task runs', 30),
    POLICY('TRUEPPM_WEBHOOK_RETENTION_DAYS', 'Webhook deliveries', 7),
    POLICY('TRUEPPM_IMPORT_RETENTION_DAYS', 'Import requests', 7),
    POLICY('TRUEPPM_SYNC_BATCH_RETENTION_HOURS', 'Sync batches', 24, 'hours'),
  ],
  schedule: {
    frequency: 'daily',
    time_of_day_utc: '02:00:00',
    day_of_week: null,
    on_failure: 'continue',
  },
  runs: [
    {
      id: 'run-1',
      started_at: '2026-05-26T06:00:00Z',
      finished_at: '2026-05-26T06:00:04Z',
      trigger: 'scheduled',
      state: 'ok',
      tables: [{ key: 'HISTORY_RETENTION_DAYS', label: 'Event history', rows: 10, bytes: 1024, state: 'ok', error: '' }],
      rows_deleted: 12408,
      bytes_freed: 512_000_000,
      error: '',
      duration_ms: 4200,
    },
  ],
};

type Page = import('@playwright/test').Page;

async function setup(page: Page, opts: { runs?: unknown[] } = {}) {
  const pj = (data: unknown) => JSON.stringify(data);
  const state = { ...FIXTURE_RETENTION, runs: opts.runs ?? FIXTURE_RETENTION.runs };

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await page.route('**/api/v1/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_ME) }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  for (const path of ['**/api/v1/projects/', '**/api/v1/programs/']) {
    await page.route(path, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ results: [], count: 0, next: null, previous: null }),
      }),
    );
  }
  // Impact estimate for the lowered-value warning.
  await page.route('**/api/v1/health/retention/impact/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ eligible_rows: 1_600_000, eligible_bytes: 1_100_000_000 }),
    }),
  );
  // Run-now / dry-run.
  await page.route('**/api/v1/health/retention/runs/', (r) =>
    r.fulfill({ status: 202, contentType: 'application/json', body: pj({ queued: true, run_id: 'run-2' }) }),
  );
  // GET + PATCH on the base endpoint (registered last so it wins for its path).
  await page.route('**/api/v1/health/retention/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(state) }),
  );
}

test.describe('Workspace Settings → Retention & purge', () => {
  test('renders the policy table, schedule, and recent-purges log', async ({ page }) => {
    await setup(page);
    await page.goto('/settings/health/retention');

    await expect(page.getByRole('heading', { name: 'Retention & purge' })).toBeVisible();

    // All five operational tables in the policy table.
    for (const label of [
      'Event history',
      'Task runs',
      'Webhook deliveries',
      'Import requests',
      'Sync batches',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // Sync batches is not disablable.
    await expect(page.getByText('Always on')).toBeVisible();

    // Schedule card.
    await expect(page.getByRole('heading', { name: 'Purge schedule' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Daily' })).toBeChecked();

    // Recent purges log row.
    await expect(page.getByRole('heading', { name: 'Recent purges' })).toBeVisible();
    await expect(page.getByText('OK', { exact: true })).toBeVisible();
  });

  test('lowering a retention value shows the irreversibility warning and Save PATCHes', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings/health/retention');

    // Webhook deliveries retention input (label includes unit).
    const input = page.getByRole('spinbutton', { name: /Webhook deliveries retention/i });
    await input.fill('3');

    // Warning row appears once the debounced impact query resolves.
    await expect(page.getByText(/purge-eligible/i)).toBeVisible();
    await expect(page.getByText(/cannot be recovered/i)).toBeVisible();

    // Saving fires a PATCH to the retention endpoint.
    const patch = page.waitForRequest(
      (req) => req.method() === 'PATCH' && req.url().includes('/health/retention/'),
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await patch;
  });

  test('empty purge log shows the empty-state copy', async ({ page }) => {
    await setup(page, { runs: [] });
    await page.goto('/settings/health/retention');

    await expect(page.getByText('No purges recorded yet', { exact: false })).toBeVisible();
  });
});

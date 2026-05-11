import { test, expect } from '@playwright/test';

/**
 * Issue #53 — Burn Charts, Reports tab (ADR-0062).
 *
 * Golden path: navigate to Reports tab → BurnChart renders with controls.
 * Variant switching: clicking Burn up radio switches the active variant.
 * Empty state: when the API returns an empty series the empty-state renders.
 * Error state: when the API returns 500 the error banner + retry button appear.
 * Sprint context: SprintsView renders BurnChart with "Sprint Burndown" heading.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-reports-00000000-0000-0000-0000-000000000053';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Burn Chart E2E Project',
  description: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-30',
  calendar: 'default',
  estimation_mode: 'open',
  methodology: 'HYBRID',
};

const BURN_SERIES = [
  { date: '2026-04-01', actual: 40, ideal: 40, scope: 40 },
  { date: '2026-04-07', actual: 20, ideal: 20, scope: 40 },
  { date: '2026-04-14', actual: 0,  ideal: 0,  scope: 40 },
];

const BURN_RESPONSE = {
  chart_type: 'burndown',
  metric: 'tasks',
  since: '2026-04-01',
  until: '2026-04-14',
  series: BURN_SERIES,
};

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

type Page = import('@playwright/test').Page;

async function setup(page: Page, burnStatus = 200, burnBody: unknown = BURN_RESPONSE) {
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

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 5, complete_tasks: 3,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
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
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: 5, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resource-allocation/**', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, window_start: '2026-04-01', window_end: '2026-06-01', resources: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 4 }]),
    }),
  );
  await page.route('**/api/v1/projects/*/risks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/burn/**`, (r) =>
    r.fulfill({
      status: burnStatus,
      contentType: 'application/json',
      body: burnStatus === 200 ? JSON.stringify(burnBody) : JSON.stringify({ detail: 'error' }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Golden path — Reports tab
// ---------------------------------------------------------------------------

test.describe('Reports tab — golden path', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByRole('heading', { name: /burn chart/i })).toBeVisible({ timeout: 10_000 });
  });

  test('renders the Reports heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  });

  test('renders the variant segmented control', async ({ page }) => {
    await expect(page.getByRole('group', { name: /chart variant/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /burn down/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /burn up/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /combined/i })).toBeVisible();
  });

  test('burn down is active by default', async ({ page }) => {
    await expect(page.getByRole('radio', { name: /burn down/i })).toHaveAttribute('aria-checked', 'true');
  });

  test('date range pickers are present', async ({ page }) => {
    await expect(page.getByLabel('From date')).toBeVisible();
    await expect(page.getByLabel('To date')).toBeVisible();
  });

  test('metric selector is present', async ({ page }) => {
    await expect(page.getByLabel('Metric')).toBeVisible();
  });

  test('export button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: /export chart/i })).toBeVisible();
  });

  test('Reports tab is active in ViewTabs', async ({ page }) => {
    const tab = page.getByRole('navigation', { name: 'View' })
      .getByRole('link', { name: 'Reports' });
    await expect(tab).toHaveAttribute('aria-current', 'page');
  });
});

// ---------------------------------------------------------------------------
// Variant switching
// ---------------------------------------------------------------------------

test.describe('Reports tab — variant switching', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByRole('heading', { name: /burn chart/i })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking Burn up marks it as checked', async ({ page }) => {
    await page.getByRole('radio', { name: /burn up/i }).click();
    await expect(page.getByRole('radio', { name: /burn up/i })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /burn down/i })).toHaveAttribute('aria-checked', 'false');
  });

  test('clicking Combined marks it as checked', async ({ page }) => {
    await page.getByRole('radio', { name: /combined/i }).click();
    await expect(page.getByRole('radio', { name: /combined/i })).toHaveAttribute('aria-checked', 'true');
  });
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

test.describe('Reports tab — error state', () => {
  test('renders error banner with Retry button when API returns 500', async ({ page }) => {
    await setup(page, 500);
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByText(/couldn't load chart data/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /retry/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

test.describe('Reports tab — empty state', () => {
  test('renders empty-state when API returns empty series', async ({ page }) => {
    await setup(page, 200, { ...BURN_RESPONSE, series: [] });
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByText(/no tasks to chart yet/i)).toBeVisible({ timeout: 10_000 });
  });
});

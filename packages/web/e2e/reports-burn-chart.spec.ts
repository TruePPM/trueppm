import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

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

  // Catch-all 401-guard FIRST (last-registered-wins): the project shell + ⌘K
  // palette read endpoints this spec does not mock (notifications, ws ticket,
  // calendars, …) which would otherwise fall through to the real backend and
  // 401 into the session-expired modal mid-test (issue 1572 / #1190 class).
  await setupCatchAll(page);
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
      body: JSON.stringify([{ id: 'mem-1', role: 400 }]),
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

  test('clicking Burn up marks it as checked and renders both lines (#1279)', async ({ page }) => {
    await page.getByRole('radio', { name: /burn up/i }).click();
    await expect(page.getByRole('radio', { name: /burn up/i })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: /burn down/i })).toHaveAttribute('aria-checked', 'false');
    // Burnup shows the completed line and the total-scope line — surfaced by their
    // legend entries (the burndown's "Ideal" entry is gone).
    await expect(page.getByText('Completed', { exact: true })).toBeVisible();
    await expect(page.getByText('Total scope', { exact: true })).toBeVisible();
  });

  test('clicking Combined marks it as checked', async ({ page }) => {
    await page.getByRole('radio', { name: /combined/i }).click();
    await expect(page.getByRole('radio', { name: /combined/i })).toHaveAttribute('aria-checked', 'true');
  });
});

// ---------------------------------------------------------------------------
// Export menu — click/keyboard driven open/close (issue 1607)
// ---------------------------------------------------------------------------

test.describe('Reports tab — export menu', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    await expect(page.getByRole('heading', { name: /burn chart/i })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking the trigger opens the menu and reveals PNG/PDF items', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /export chart/i });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Menu items are CSS-hidden until opened.
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /download pdf/i })).toBeVisible();
  });

  test('picking Download PNG closes the menu', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /export chart/i });
    await trigger.click();
    await page.getByRole('menuitem', { name: /download png/i }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Move the pointer off the group so the group-hover enhancement does not
    // keep the (state-closed) menu visible while asserting it is hidden.
    await page.mouse.move(0, 0);
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeHidden();
  });

  test('Escape closes an open menu', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /export chart/i });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await page.mouse.move(0, 0);
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeHidden();
  });

  test('clicking outside closes an open menu', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /export chart/i });
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeVisible();
    await page.getByRole('heading', { name: 'Reports' }).click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('menuitem', { name: /download png/i })).toBeHidden();
  });
});

// ---------------------------------------------------------------------------
// Sprint-scoped burndown — the full analytical home the Board demotes to (#1983)
// ---------------------------------------------------------------------------

test.describe('Reports tab — sprint-scoped burndown (#1983)', () => {
  const SPRINT = {
    id: 'sp-reports-1',
    server_version: 1,
    name: 'Iteration 9',
    goal: '',
    start_date: '2026-04-01',
    finish_date: '2026-04-14',
    state: 'ACTIVE',
  };

  test('renders a sprint selector and the sprint burndown above the project chart', async ({
    page,
  }) => {
    await setup(page);
    // A sprint must exist for the sprint-scoped section to render (last-wins).
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [SPRINT] }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sprint: SPRINT, snapshots: [] }),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/reports`);
    // The selector defaults to the active sprint.
    const selector = page.getByLabel(/to chart/i);
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await expect(selector).toHaveValue(SPRINT.id);
    // Both charts render: the sprint-scoped "… Burndown" and the project "Burn Chart".
    await expect(page.getByRole('heading', { name: /burndown/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: /burn chart/i })).toBeVisible();
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

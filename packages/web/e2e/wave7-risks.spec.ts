import { test, expect } from '@playwright/test';

/**
 * Wave 7 — Risk Register redesign (issues #218, #221, #222, ADR-0043).
 *
 * Golden path: open Risks tab → list renders, matrix shows.
 * Matrix cell-click: clicking a cell filters the table; clear chip removes filter.
 * PMI fields: overdue badge appears on MITIGATING risk with past mitigation_due_date.
 * CSV export: Export CSV button is visible when risks are present.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-risks-00000000-0000-0000-0000-000000000007';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Wave 7 Risk Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
};

// Risks:
// R1 — critical, P5×I5=25, OPEN
// R2 — mitigating, P3×I3=9, with past due date → overdue badge
// R3 — resolved, P2×I2=4
const FIXTURE_RISKS = [
  {
    id: 'risk-001', short_id: '00000001', server_version: 1,
    project: PROJECT_ID, title: 'Critical infrastructure failure', description: 'Infra may fail',
    status: 'OPEN', probability: 5, impact: 5, severity: 25,
    owner: null, created_by: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    tasks: [],
    category: 'TECHNICAL', response: 'MITIGATE',
    mitigation_due_date: null, trigger: '', contingency: '',
  },
  {
    id: 'risk-002', short_id: '00000002', server_version: 1,
    project: PROJECT_ID, title: 'Vendor delivery delay', description: 'Vendor may be late',
    status: 'MITIGATING', probability: 3, impact: 3, severity: 9,
    owner: null, created_by: null,
    created_at: '2026-01-05T00:00:00Z', updated_at: '2026-01-06T00:00:00Z',
    tasks: [],
    category: 'EXTERNAL', response: 'ACCEPT',
    // Deliberately in the past so the "Overdue" badge triggers
    mitigation_due_date: '2025-12-01', trigger: 'Vendor misses milestone', contingency: 'Switch supplier',
  },
  {
    id: 'risk-003', short_id: '00000003', server_version: 1,
    project: PROJECT_ID, title: 'Scope creep', description: 'Requirements may expand',
    status: 'RESOLVED', probability: 2, impact: 2, severity: 4,
    owner: null, created_by: null,
    created_at: '2026-01-10T00:00:00Z', updated_at: '2026-01-11T00:00:00Z',
    tasks: [],
    category: null, response: null, mitigation_due_date: null, trigger: '', contingency: '',
  },
];

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

type Page = import('@playwright/test').Page;

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

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  // Standard shell routes
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 3, complete_tasks: 1,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
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
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: 3, critical_path_count: 0, monte_carlo_p80: null,
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
      body: JSON.stringify({ project_id: PROJECT_ID, window_start: '2026-01-01', window_end: '2026-06-01', resources: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ columns: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-sched', role: 2 }]),
    }),
  );
  await page.route('**/api/v1/projects/*/risks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_RISKS) }),
  );
}

// ---------------------------------------------------------------------------
// Golden path — risk list renders
// ---------------------------------------------------------------------------

test.describe('Risk register — golden path', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });
  });

  test('renders all three risks in the table', async ({ page }) => {
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();
    await expect(page.getByText('Scope creep')).toBeVisible();
  });

  test('renders the risk heatmap matrix', async ({ page }) => {
    // Matrix is in the aside with aria-label "Risk heatmap"
    const heatmap = page.getByRole('complementary', { name: 'Risk heatmap' });
    await expect(heatmap).toBeVisible();
    // The P×I heading is present
    await expect(heatmap.getByText(/Probability.*Impact/i)).toBeVisible();
  });

  test('Export CSV button is visible', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Matrix cell-click filter
// ---------------------------------------------------------------------------

test.describe('Risk matrix cell-click filter', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });
  });

  test('clicking P5×I5 cell filters the table to that risk', async ({ page }) => {
    // The P5×I5 cell has aria-label "P5 × I5 = 25, 1 risk"
    const cell = page.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    await cell.click();

    // Filter chip appears
    await expect(page.getByText(/Filtered to/)).toBeVisible();
    await expect(page.getByText('P5 × I5')).toBeVisible();

    // Only the critical risk is shown
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).not.toBeVisible();
    await expect(page.getByText('Scope creep')).not.toBeVisible();
  });

  test('Clear filter chip restores the full list', async ({ page }) => {
    const cell = page.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    await cell.click();
    await expect(page.getByText(/Filtered to/)).toBeVisible();

    await page.getByRole('button', { name: 'Clear filter' }).click();

    await expect(page.getByText(/Filtered to/)).not.toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();
    await expect(page.getByText('Scope creep')).toBeVisible();
  });

  test('clicking the active cell again toggles selection off', async ({ page }) => {
    const cell = page.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    await cell.click();
    await expect(page.getByText(/Filtered to/)).toBeVisible();

    // Click again — should toggle off
    await cell.click();
    await expect(page.getByText(/Filtered to/)).not.toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();
  });

  test('Escape key while matrix has focus clears filter', async ({ page }) => {
    const cell = page.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    await cell.click();
    await expect(page.getByText(/Filtered to/)).toBeVisible();

    // Focus the cell and press Escape
    await cell.focus();
    await page.keyboard.press('Escape');

    await expect(page.getByText(/Filtered to/)).not.toBeVisible();
  });

  test('cell aria-pressed reflects selection state', async ({ page }) => {
    const cell = page.getByRole('button', { name: 'P5 × I5 = 25, 1 risk' });
    await expect(cell).toHaveAttribute('aria-pressed', 'false');

    await cell.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
  });
});

// ---------------------------------------------------------------------------
// Overdue mitigation badge
// ---------------------------------------------------------------------------

test.describe('Overdue mitigation badge', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });
  });

  test('overdue badge appears on MITIGATING risk with past due date', async ({ page }) => {
    // The "Vendor delivery delay" row has status MITIGATING + mitigation_due_date in the past
    const riskRow = page.getByRole('button', { name: /Open risk: Vendor delivery delay \(overdue mitigation\)/ });
    await expect(riskRow).toBeVisible();

    const badge = riskRow.getByText('Overdue');
    await expect(badge).toBeVisible();
  });

  test('overdue badge does not appear on non-mitigating risk', async ({ page }) => {
    const criticalRow = page.getByRole('button', { name: /Open risk: Critical infrastructure failure/ });
    await expect(criticalRow.getByText('Overdue')).not.toBeVisible();
  });

  test('overdue row has amber background tint', async ({ page }) => {
    const riskRow = page.getByRole('button', { name: /Open risk: Vendor delivery delay \(overdue mitigation\)/ });
    // bg-semantic-at-risk/5 is applied to the tr — verify the class exists on the element
    await expect(riskRow).toHaveClass(/bg-semantic-at-risk/);
  });
});

// ---------------------------------------------------------------------------
// Risk drawer — PMI fields detail view
// ---------------------------------------------------------------------------

test.describe('Risk drawer PMI fields', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });
  });

  test('opening a risk with PMI fields shows Category and Response', async ({ page }) => {
    await page.getByRole('button', { name: /Open risk: Critical infrastructure failure/ }).click();

    // Wait for drawer content
    await expect(page.getByText('Technical')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Mitigate')).toBeVisible();
  });

  test('opening the overdue risk shows Trigger and Contingency', async ({ page }) => {
    await page.getByRole('button', { name: /Open risk: Vendor delivery delay/ }).click();

    await expect(page.getByText('Vendor misses milestone')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Switch supplier')).toBeVisible();
  });
});

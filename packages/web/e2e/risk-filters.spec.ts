import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #1170 — Risk register filter + sort layer (part of v2 epic #1163).
 *
 * Golden path: the All/High/Unmitigated/Mine segment filter narrows the table;
 * severity sort reorders it; per-filter empty state offers a reset; the dual
 * facet (segment + matrix cell) status chip clears via "Clear all".
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-riskf-00000000-0000-0000-0000-000000001170';
const ME_ID = 'me-00000000-0000-0000-0000-000000000001';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Risk Filter Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
};

// R1 — critical, sev 25, OPEN, owned by me   → All, High, Unmitigated, Mine
// R2 — sev 9, MITIGATING, owned by someone   → All, Unmitigated
// R3 — sev 4, RESOLVED, owned by someone     → All
const FIXTURE_RISKS = [
  {
    id: 'risk-001',
    short_id: '00000001',
    short_id_display: 'R-001',
    qualified_id: 'RF-R-001',
    server_version: 1,
    project: PROJECT_ID,
    title: 'Critical infrastructure failure',
    description: '',
    status: 'OPEN',
    probability: 5,
    impact: 5,
    severity: 25,
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
  },
  {
    id: 'risk-002',
    short_id: '00000002',
    short_id_display: 'R-002',
    qualified_id: 'RF-R-002',
    server_version: 1,
    project: PROJECT_ID,
    title: 'Vendor delivery delay',
    description: '',
    status: 'MITIGATING',
    probability: 3,
    impact: 3,
    severity: 9,
    owner: 'other-user',
    owner_name: 'Other Person',
    owner_initials: 'OP',
    created_by: null,
    created_at: '2026-01-05T00:00:00Z',
    updated_at: '2026-01-06T00:00:00Z',
    tasks: [],
    category: 'EXTERNAL',
    response: 'ACCEPT',
    mitigation_due_date: null,
    trigger: '',
    contingency: '',
  },
  {
    id: 'risk-003',
    short_id: '00000003',
    short_id_display: 'R-003',
    qualified_id: 'RF-R-003',
    server_version: 1,
    project: PROJECT_ID,
    title: 'Scope creep',
    description: '',
    status: 'RESOLVED',
    probability: 2,
    impact: 2,
    severity: 4,
    owner: 'other-user',
    owner_name: 'Other Person',
    owner_initials: 'OP',
    created_by: null,
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-11T00:00:00Z',
    tasks: [],
    category: null,
    response: null,
    mitigation_due_date: null,
    trigger: '',
    contingency: '',
  },
];

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

  // Benign fallback for any authenticated-shell endpoint this spec does not
  // mock explicitly (e.g. /me/work/, /programs/, /monte-carlo/latest/). Without
  // it those calls fall through to the preview server, take an effective 401,
  // and flip the session-expired modal mid-test. Registered FIRST so the
  // specific routes below take precedence.
  // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
  // being masked by a permissive 200 body (the #1190 flake class).
  await setupCatchAll(page);

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
        max_project_role: 200,
        workspace_role: null,
        can_access_admin_settings: false,
      }),
    }),
  );
  // Mock the authenticated-shell side calls so a stray 401 can't flip the
  // session-expired modal (which would intercept pointer events mid-test).
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
  // NotificationBell polls /me/notifications/; useCurrentUser hits /auth/me/.
  // Mock the poll so it can't 401 and expire the session.
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
        total_tasks: 3,
        complete_tasks: 1,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 3,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
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
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/resource-allocation/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: PROJECT_ID,
        window_start: '2026-01-01',
        window_end: '2026-06-01',
        resources: [],
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ columns: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-sched', role: 200 }]),
    }),
  );
  await page.route('**/api/v1/projects/*/risks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(FIXTURE_RISKS) }),
  );
}

test.describe('Risk register — segment filter', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('renders the filter as a radiogroup defaulting to All', async ({ page }) => {
    const group = page.getByRole('radiogroup', { name: 'Filter risks' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio')).toHaveCount(4);
    await expect(group.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  });

  test('High narrows to severity >= 12', async ({ page }) => {
    await page.getByRole('radio', { name: 'High' }).click();
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).not.toBeVisible();
    await expect(page.getByText('Scope creep')).not.toBeVisible();
    await expect(page.getByText(/Filtered to/)).toBeVisible();
  });

  test('Unmitigated excludes resolved risks', async ({ page }) => {
    await page.getByRole('radio', { name: 'Unmitigated' }).click();
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();
    await expect(page.getByText('Scope creep')).not.toBeVisible();
  });

  test('Mine narrows to risks owned by the current user', async ({ page }) => {
    await page.getByRole('radio', { name: 'Mine' }).click();
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).not.toBeVisible();
  });
});

test.describe('Risk register — v2 fidelity polish (issue 1230)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows the "N in register · X high · Y unmitigated" header sub-line', async ({ page }) => {
    // Single <p>: match the whole line so it can't collide with the matrix
    // "N unmitigated need action" callout.
    await expect(page.getByText(/3 in register.*1 high.*2 unmitigated/)).toBeVisible();
  });

  test('renders live per-facet counts on the segment chips', async ({ page }) => {
    const group = page.getByRole('radiogroup', { name: 'Filter risks' });
    await expect(group.getByRole('radio', { name: 'All' })).toContainText('3');
    await expect(group.getByRole('radio', { name: 'High' })).toContainText('1');
    await expect(group.getByRole('radio', { name: 'Unmitigated' })).toContainText('2');
    await expect(group.getByRole('radio', { name: 'Mine' })).toContainText('1');
  });

  test('Newest sort orders the table by created_at descending', async ({ page }) => {
    const newest = page.getByRole('button', { name: 'Newest' });
    await expect(newest).toHaveAttribute('aria-pressed', 'false');
    await newest.click();
    await expect(newest).toHaveAttribute('aria-pressed', 'true');

    // Fixture created_at: R1 2026-01-01, R2 2026-01-05, R3 2026-01-10 → newest first is R3.
    const rows = page.getByRole('button', { name: /Open risk:/ });
    await expect(rows.first()).toHaveAttribute('aria-label', /Open risk: Scope creep/);
  });

  test('matrix shows the "N unmitigated need action" callout', async ({ page }) => {
    await expect(page.getByText('2 unmitigated need action')).toBeVisible();
  });
});

test.describe('Risk register — severity sort & empty state', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('severity header toggles aria-sort none → descending → ascending', async ({ page }) => {
    const header = page.getByRole('columnheader', { name: /Severity/ });
    await expect(header).toHaveAttribute('aria-sort', 'none');
    await header.getByRole('button', { name: /Severity/ }).click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    await header.getByRole('button', { name: /Severity/ }).click();
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  test('Hide low severity toggle hides low-severity rows and persists across reload (#1239)', async ({
    page,
  }) => {
    // R1 sev 25 (critical), R2 sev 9 (medium), R3 sev 4 (low).
    const toggle = page.getByRole('checkbox', { name: 'Hide low severity' });
    await expect(page.getByText('Scope creep')).toBeVisible();

    await toggle.check();
    await expect(page.getByText('Scope creep')).not.toBeVisible();
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();

    // Persisted to localStorage and re-applied on reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('checkbox', { name: 'Hide low severity' })).toBeChecked();
    await expect(page.getByText('Scope creep')).not.toBeVisible();
  });

  test('combined cell + segment with no match shows the empty state and resets', async ({
    page,
  }) => {
    // Select the low-severity cell (R3, P2×I2=4), then apply the High segment —
    // R3 is not high, so the AND of both facets is empty.
    await page.getByRole('button', { name: 'P2 × I2 = 4, 1 risk' }).click();
    await page.getByRole('radio', { name: 'High' }).click();
    await expect(page.getByText('No risks match the selected cell and filter.')).toBeVisible();

    await page.getByRole('button', { name: 'Show all risks' }).click();
    await expect(page.getByText('Critical infrastructure failure')).toBeVisible();
    await expect(page.getByText('Vendor delivery delay')).toBeVisible();
    await expect(page.getByText('Scope creep')).toBeVisible();
  });
});

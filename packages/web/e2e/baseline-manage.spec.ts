import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Baseline capture & management E2E (#1864).
 *
 * Drives the real Schedule UI against mocked API routes: capture a baseline
 * from the Actions (···) menu, open the baseline manager, set a different
 * baseline active, and delete one. Auth + role are seeded so the admin/owner
 * gated affordances render.
 */

const PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Alpha Platform Upgrade',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
  },
];

function baseline(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    project: PROJECT_ID,
    name: 'Baseline 1',
    created_by: null,
    created_at: '2026-07-12T10:00:00Z',
    is_active: true,
    has_cpm_dates: true,
    task_count: 48,
    ...over,
  };
}

interface GotoOpts {
  role: number;
  baselines: ReturnType<typeof baseline>[];
}

async function gotoSchedule(page: Page, { role, baselines }: GotoOpts) {
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: PROJECT_ID, name: 'Alpha Platform Upgrade', description: '', start_date: '2026-01-01', calendar: 'default' }],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: PROJECT_ID,
        name: 'Alpha Platform Upgrade',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'WATERFALL',
        code: '',
        health: 'AUTO',
        visibility: 'WORKSPACE',
        timezone: '',
        default_view: 'SCHEDULE',
        lead: null,
        lead_detail: null,
        iteration_label: 'Sprint',
        is_archived: false,
        archived_at: null,
        archived_by: null,
        recalculated_at: null,
        is_sample: false,
        program_detail: null,
        server_version: 1,
      }),
    }),
  );
  // Members — satisfies both useCurrentUserRole (?self=true → [0].role) and
  // useProjectMembers (user_detail map).
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'm1', role, user_detail: { id: 'u1', username: 'kelly' } }]),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
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
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );

  // Baseline endpoints. List/create share the collection URL; activate and
  // delete are the per-item URLs (non-overlapping globs).
  await page.route('**/api/v1/projects/*/baselines/', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(baseline({ id: 'bN', name: 'Baseline 3', is_active: true })),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: baselines.length, next: null, previous: null, results: baselines }),
    });
  });
  await page.route('**/api/v1/projects/*/baselines/*/activate/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(baseline({ id: 'b2', name: 'Baseline 2', is_active: true })),
    }),
  );
  await page.route('**/api/v1/projects/*/baselines/*/', (route) =>
    route.fulfill({ status: 204, body: '' }),
  );

  await page.routeWebSocket('**/ws/v1/projects/**', () => {
    /* accept and hold open */
  });
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
}

async function openManager(page: Page) {
  await page.getByRole('button', { name: 'Project actions' }).click();
  await page.getByRole('menuitem', { name: 'Baselines…' }).click();
  await expect(page.getByRole('dialog', { name: 'Baselines' })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'u1', email: 'pm@example.com', first_name: 'P', last_name: 'M' }),
    }),
  );
});

test.describe('Baseline capture & management', () => {
  test('admin captures a baseline via the educational confirm (toast confirms)', async ({ page }) => {
    await gotoSchedule(page, { role: 300, baselines: [baseline()] });
    await page.getByRole('button', { name: 'Project actions' }).click();
    await page.getByRole('menuitem', { name: 'Capture baseline' }).click();
    // The confirm dialog explains the action before anything is captured.
    const confirm = page.getByRole('dialog', { name: 'Capture a baseline?' });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/immutable/i)).toBeVisible();
    await expect(confirm.getByText(/history/i)).toBeVisible();
    await confirm.getByRole('button', { name: 'Capture baseline' }).click();
    await expect(page.getByText('Captured Baseline 3')).toBeVisible();
  });

  test('manager lists baselines and marks the active one', async ({ page }) => {
    await gotoSchedule(page, {
      role: 300,
      baselines: [baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })],
    });
    await openManager(page);
    const dialog = page.getByRole('dialog', { name: 'Baselines' });
    await expect(dialog.getByText('Baseline 1')).toBeVisible();
    await expect(dialog.getByText('Baseline 2')).toBeVisible();
    // exact avoids matching the "Set active" button on the inactive row.
    await expect(dialog.getByText('Active', { exact: true })).toBeVisible();
  });

  test('admin sets a different baseline active (toast confirms)', async ({ page }) => {
    await gotoSchedule(page, {
      role: 300,
      baselines: [baseline({ is_active: true }), baseline({ id: 'b2', name: 'Baseline 2', is_active: false })],
    });
    await openManager(page);
    await page.getByRole('button', { name: 'Set active' }).click();
    await expect(page.getByText('Baseline 2 is now the active baseline')).toBeVisible();
  });

  test('owner deletes a baseline through the destructive confirm', async ({ page }) => {
    await gotoSchedule(page, { role: 400, baselines: [baseline()] });
    await openManager(page);
    await page.getByRole('dialog', { name: 'Baselines' }).getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Delete baseline' }).click();
    await expect(page.getByText('Deleted Baseline 1')).toBeVisible();
  });

  test('empty state offers the capture CTA to an admin', async ({ page }) => {
    await gotoSchedule(page, { role: 300, baselines: [] });
    await openManager(page);
    const dialog = page.getByRole('dialog', { name: 'Baselines' });
    await expect(dialog.getByText('No baselines yet')).toBeVisible();
    // Both the header button and the EmptyState CTA read "Capture baseline".
    await expect(dialog.getByRole('button', { name: 'Capture baseline' }).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Capture baseline' })).toHaveCount(2);
  });
});

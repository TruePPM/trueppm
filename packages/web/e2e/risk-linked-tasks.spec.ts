import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * #2156 — Risk-to-mitigation-task handoff (ADR-0566).
 *
 * Golden path: open a risk that links a task → the "Linked tasks" section lists
 * it as an openable row. Create flow: on a risk with no links, "Create mitigation
 * task" POSTs a task and PATCHes the risk, then confirms the unscheduled outcome.
 * Empty state: a risk with no links shows the empty prompt.
 *
 * All API calls are intercepted via page.route() — no backend required.
 */

const PROJECT_ID = 'e2e-risktask-0000-0000-0000-000000002156';
const LINKED_TASK_ID = 'task-linked-0000-0000-0000-000000000001';

type Page = import('@playwright/test').Page;

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: '2156 Risk-Task Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  estimation_mode: 'open',
};

// A risk that links one task, and a risk with no links.
function makeRisk(over: Record<string, unknown>) {
  return {
    id: 'risk-x',
    short_id: '00000001',
    server_version: 1,
    project: PROJECT_ID,
    title: 'Vendor delivery delay',
    description: 'Vendor may be late',
    status: 'MITIGATING',
    probability: 3,
    impact: 3,
    severity: 9,
    owner: null,
    created_by: null,
    created_at: '2026-01-05T00:00:00Z',
    updated_at: '2026-01-06T00:00:00Z',
    tasks: [],
    category: 'EXTERNAL',
    response: 'MITIGATE',
    mitigation_due_date: null,
    trigger: '',
    contingency: '',
    ...over,
  };
}

const RISK_LINKED = makeRisk({ id: 'risk-linked', title: 'Overdue integration risk', tasks: [LINKED_TASK_ID] });
const RISK_EMPTY = makeRisk({ id: 'risk-empty', title: 'Unmitigated scope risk', tasks: [] });

// Minimal ApiTask shape mapTask can consume.
function apiTask(id: string, name: string) {
  return {
    id,
    wbs_path: '1',
    name,
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 1,
    percent_complete: 0,
    is_critical: false,
    status: 'NOT_STARTED',
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    late_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    total_float: null,
  };
}

const pj = (results: unknown[]) =>
  JSON.stringify({ count: results.length, next: null, previous: null, results });

async function setup(page: Page, risks: unknown[]) {
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
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  // Project-shell context routes — mocked with their real shapes so the shell
  // renders instead of falling through the catch-all 404 (the #1190 flake class).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 1,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
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
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 1,
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
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [] }) }),
  );
  await page.route('**/api/v1/monte-carlo/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );
  // Member+ role (100) so the create affordance and picker are enabled.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 100 }]),
    }),
  );
  // The linked task resolves from the project task list.
  await page.route('**/api/v1/tasks/**', (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'task-created',
          name: 'Mitigate: Unmitigated scope risk',
          project: PROJECT_ID,
          wbs_path: '2',
          duration: 1,
          status: 'NOT_STARTED',
          percent_complete: 0,
        }),
      });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj([apiTask(LINKED_TASK_ID, 'Integrate vendor API')]),
    });
  });
  await page.route('**/api/v1/dependencies/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/projects/*/risks/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(risks) }),
  );
  await page.route('**/api/v1/projects/*/risks/*/comments/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
}

test.describe('#2156 risk → linked tasks', () => {
  test('lists a linked task as an openable row in the detail drawer', async ({ page }) => {
    await setup(page, [RISK_LINKED]);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Open risk: Overdue integration risk/ }).click();

    // RiskDrawer renders a desktop panel + a mobile sheet; scope to the first
    // (visible desktop) dialog so assertions don't match both copies.
    const drawer = page.getByRole('dialog').first();
    // The section header carries the link count, and the task renders as a button
    // that opens the global task drawer.
    await expect(drawer.getByText('Linked tasks (1)')).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: /Open task Integrate vendor API/ }),
    ).toBeVisible();
  });

  test('shows the empty prompt when a risk links no tasks', async ({ page }) => {
    await setup(page, [RISK_EMPTY]);
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Open risk: Unmitigated scope risk/ }).click();

    const drawer = page.getByRole('dialog').first();
    await expect(drawer.getByText(/No tasks linked yet\./)).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: 'Create mitigation task from this risk' }),
    ).toBeVisible();
  });

  test('creates and links a mitigation task, confirming the unscheduled outcome', async ({ page }) => {
    await setup(page, [RISK_EMPTY]);

    let patchedTasks: string[] | null = null;
    await page.route('**/api/v1/projects/*/risks/risk-empty/', (r) => {
      if (r.request().method() === 'PATCH') {
        const body = r.request().postDataJSON() as { tasks?: string[] };
        patchedTasks = body.tasks ?? null;
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makeRisk({ id: 'risk-empty', tasks: body.tasks ?? [] })),
        });
      }
      return r.fallback();
    });

    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByRole('heading', { name: 'Risk register' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Open risk: Unmitigated scope risk/ }).click();

    const drawer = page.getByRole('dialog').first();
    await drawer.getByRole('button', { name: 'Create mitigation task from this risk' }).click();

    await expect(
      drawer.getByText('Mitigation task created — unscheduled and not in any sprint.'),
    ).toBeVisible();
    // The link PATCH carried the new task id.
    expect(patchedTasks).toEqual(['task-created']);
  });
});

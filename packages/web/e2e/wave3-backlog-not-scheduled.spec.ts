/**
 * E2E tests for issue #332 — backlog cards must not display scheduled-state
 * signals. CPM auto-fills early_start/early_finish for every dated task, so a
 * BACKLOG card without a PM-committed planned_start used to render with a CP
 * pill, 0d-float chip, and a Gantt bar. The fix gates these displays on
 * `plannedStart` (or sprint membership).
 *
 * Two fixture variants share one project and column config; only the task
 * payload differs so each test exercises a single state.
 */
import { test, expect } from '@playwright/test';

const FIXTURE_PROJECT_ID = 'e2e-332-00000000-0000-0000-0000-000000000332';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Backlog Suppression Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const PHASE_TASK = {
  id: 'p1', wbs_path: '1', name: 'Alpha Phase',
  early_start: '2026-04-05', early_finish: '2026-04-30',
  planned_start: '2026-04-05',
  duration: 20, percent_complete: 50, is_critical: false,
  is_milestone: false, is_summary: true, parent_id: null,
  status: 'IN_PROGRESS', assignees: [], total_float: null,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
};

/**
 * Build the task list for a single test variant. The backlog task's
 * planned_start is the only knob that flips between "uncommitted" and
 * "committed". CPM-derived early_start is ALWAYS set (mimicking production)
 * to prove the gate keys on planned_start, not on the absence of dates.
 */
function buildTasks(plannedStart: string | null) {
  return [
    PHASE_TASK,
    {
      id: 'b1', wbs_path: '1.1', name: 'Backlog Idea',
      early_start: '2026-04-05', early_finish: '2026-04-12',
      planned_start: plannedStart,
      duration: 7, percent_complete: 0, is_critical: true,
      is_milestone: false, is_summary: false, parent_id: 'p1',
      status: 'BACKLOG', assignees: [], total_float: 0,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
  ];
}

async function setup(page: import('@playwright/test').Page, plannedStart: string | null) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const tasks = buildTasks(plannedStart);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 0, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active workshop session.' }) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: tasks.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        window_start: '2026-04-01',
        window_end: '2026-05-30',
        resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: null, color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
}

test.describe('Backlog cards must not display as scheduled (#332)', () => {
  test('CP pill is suppressed on a backlog card with no plannedStart even though is_critical is true', async ({ page }) => {
    await setup(page, null);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Backlog Idea')).toBeVisible({ timeout: 10_000 });
    // The card text is present, but the CP pill must NOT be — CPM marked the
    // task critical, but the PM has not committed dates.
    const card = page.getByText('Backlog Idea').locator('..').locator('..');
    await expect(card.getByText('CP', { exact: true })).toHaveCount(0);
  });

  test('float chip is suppressed on the same uncommitted backlog card', async ({ page }) => {
    await setup(page, null);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Backlog Idea')).toBeVisible({ timeout: 10_000 });
    // total_float was set to 0 in the fixture; without the gate this would
    // render as a red "0d float" chip.
    await expect(page.getByText(/0d float/)).toHaveCount(0);
  });

  test('CP pill is suppressed on backlog cards in the rail even with a committed plannedStart (#381)', async ({ page }) => {
    // Pre-#381 behavior: a BACKLOG card with PM-committed plannedStart
    // surfaced the CP pill on the BoardCard to signal "now scheduled". After
    // #381 the rail's BacklogCard is a distinct visual language with no
    // CP/SPI/EVM signals — backlog = idea, not scheduled work, regardless
    // of plannedStart. Promotion to NOT_STARTED is the path that exposes
    // CP. This guards against accidentally re-introducing scheduled-state
    // chrome onto rail cards.
    await setup(page, '2026-04-05');
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Backlog Idea')).toBeVisible({ timeout: 10_000 });
    const card = page.getByText('Backlog Idea').locator('..').locator('..');
    await expect(card.getByText('CP', { exact: true })).toHaveCount(0);
  });

  test('Schedule view: uncommitted backlog task surfaces in the Unscheduled gutter', async ({ page }) => {
    await setup(page, null);
    await page.goto(`${BASE_URL}/schedule`);
    // The Unscheduled gutter heading is always present; we wait for it to
    // confirm the Schedule view is ready before asserting on the row.
    await expect(page.getByText('Unscheduled', { exact: true })).toBeVisible({ timeout: 10_000 });
    // The backlog task name should appear in the gutter row list — proving
    // useUnscheduledTasks now widens to BACKLOG (#332). Scope the lookup to
    // the gutter region: the task name also appears in the task list panel,
    // which would trip strict-mode on a top-level getByText.
    const gutter = page.getByRole('region', { name: 'Unscheduled tasks' });
    await expect(gutter.getByText('Backlog Idea')).toBeVisible();
    // And the empty-state copy must NOT be visible — there IS an unscheduled task.
    await expect(page.getByText('All To Do and Backlog tasks have planned dates')).toHaveCount(0);
  });
});

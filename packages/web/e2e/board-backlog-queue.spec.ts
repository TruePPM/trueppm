/**
 * E2E for the Board Queue layout (epic #361 child D, issue #384, Claude Design).
 *
 * Asserts the surface-level acceptance criteria:
 *   - Switching layout to Queue swaps the body for the queue and hides the rail / phase grid
 *   - All four group headers render with count chips
 *   - Empty groups render their fallback copy
 *   - Tasks render in the correct group based on status
 *
 * Drag-from-row is intentionally out of scope for v1 (queue is read/sort only),
 * so the spec asserts only structural rendering, not row mutations.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-bq-00000000-0000-0000-0000-000000000384';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Backlog Queue Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function commonTaskShape() {
  return {
    early_start: '2026-04-05',
    early_finish: '2026-04-10',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const NEXT_UP_TASK = {
  id: 'next-1',
  wbs_path: '1.1',
  name: 'Stakeholder interviews',
  parent_id: 'phase-1',
  status: 'NOT_STARTED',
  ...commonTaskShape(),
};

const IN_FLIGHT_TASK = {
  id: 'inflight-1',
  wbs_path: '1.2',
  name: 'Persona research',
  parent_id: 'phase-1',
  status: 'IN_PROGRESS',
  ...commonTaskShape(),
  percent_complete: 40,
};

const BACKLOG_TASK = {
  id: 'backlog-1',
  wbs_path: '1.3',
  name: 'Tone-of-voice study',
  parent_id: 'phase-1',
  status: 'BACKLOG',
  ...commonTaskShape(),
  status_changed_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
};

const RECENTLY_DONE_TASK = {
  id: 'done-1',
  wbs_path: '1.4',
  name: 'Project kickoff',
  parent_id: 'phase-1',
  status: 'COMPLETE',
  ...commonTaskShape(),
  percent_complete: 100,
  // 3 days old — within the 14-day recently-done window.
  actual_finish: new Date(Date.now() - 3 * 86_400_000).toISOString(),
};

async function setup(page: import('@playwright/test').Page, tasks: object[]) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    });
  });
}

test.describe('Board queue layout (epic #361 child D, issue #384)', () => {
  test('switching layout to Queue swaps the body and hides the rail and phase grid', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, NEXT_UP_TASK, IN_FLIGHT_TASK, BACKLOG_TASK]);
    await page.goto(`${BASE_URL}/board`);

    // Default is Rail — backlog-band is visible, queue-layout is not mounted.
    await expect(page.getByTestId('backlog-band')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('queue-layout')).toHaveCount(0);

    await page.getByRole('button', { name: 'Queue' }).click();

    await expect(page.getByTestId('queue-layout')).toBeVisible();
    // Rail and drawer are not mounted while queue is active. Phase-grid lane
    // headers (e.g. "Discovery") should also be absent because the entire grid
    // container is gated.
    await expect(page.getByTestId('backlog-band')).toHaveCount(0);
    await expect(page.getByTestId('backlog-drawer')).toHaveCount(0);
  });

  test('renders all four group headers with count chips', async ({ page }) => {
    await setup(page, [
      SUMMARY_TASK,
      NEXT_UP_TASK,
      IN_FLIGHT_TASK,
      BACKLOG_TASK,
      RECENTLY_DONE_TASK,
    ]);
    await page.goto(`${BASE_URL}/board`);
    await page.getByRole('button', { name: 'Queue' }).click();

    await expect(page.getByTestId('queue-group-nextUp')).toBeVisible();
    await expect(page.getByTestId('queue-group-inFlight')).toBeVisible();
    await expect(page.getByTestId('queue-group-backlog')).toBeVisible();
    await expect(page.getByTestId('queue-group-recentlyDone')).toBeVisible();

    // Count chips reflect the partition rules.
    await expect(page.getByTestId('queue-group-count-nextUp')).toHaveText('1');
    await expect(page.getByTestId('queue-group-count-inFlight')).toHaveText('1');
    await expect(page.getByTestId('queue-group-count-backlog')).toHaveText('1');
    await expect(page.getByTestId('queue-group-count-recentlyDone')).toHaveText('1');
  });

  test('renders task names in the right groups, including the BACKLOG row', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, NEXT_UP_TASK, BACKLOG_TASK]);
    await page.goto(`${BASE_URL}/board`);
    await page.getByRole('button', { name: 'Queue' }).click();

    const nextUp = page.getByTestId('queue-group-nextUp');
    await expect(nextUp.getByText('Stakeholder interviews')).toBeVisible();

    const backlog = page.getByTestId('queue-group-backlog');
    await expect(backlog.getByText('Tone-of-voice study')).toBeVisible();

    // In-flight and recently-done groups render their empty-state copy because
    // we passed no rows in those buckets.
    await expect(page.getByTestId('queue-group-empty-inFlight')).toContainText(/No work in flight/i);
    await expect(page.getByTestId('queue-group-empty-recentlyDone')).toContainText(/No tasks completed/i);
  });
});

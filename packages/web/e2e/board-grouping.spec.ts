/**
 * Board swimlane grouping E2E — Phase ↔ By assignee (issue #324) ↔ By epic (#364).
 *
 * Golden path: switch the Group control from Phase to By assignee / By epic and
 * back; error/edge: assignee and epic lanes suppress the phase-authoring
 * "+ add task" affordance (a lane id there is a resource or an epic, not a WBS
 * parent), and an ungrouped card lands in the "(No epic)" lane.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-grouping-0000-0000-0000-000000000324';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Grouping Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// One summary phase ("Alpha Phase") with four leaf cards: two assigned to
// Alice, one to Bob, one unassigned. The web maps API `assignments` →
// `assignees`, so the assignee swimlanes derive from these.
//
// For epic grouping (#364): the leaves carry `parent_epic` (g2/g3 → Checkout,
// g4 → Onboarding, g5 → none). The two epics are `type: 'epic'` summaries with
// NO WBS children, so phase mode filters them out (0 child tasks) and they never
// render as cards (is_summary) — their names appear ONLY as epic lane headers,
// keeping the text assertions collision-free.
const FIXTURE_TASKS = [
  {
    id: 'g1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignments: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'g2', wbs_path: '1.1', name: 'Design',
    early_start: '2026-01-05', early_finish: '2026-01-16', planned_start: '2026-01-05',
    duration: 10, percent_complete: 30, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'g1',
    status: 'IN_PROGRESS', parent_epic: 'e-checkout',
    assignments: [{ resource_id: 'r-1', resource_name: 'Alice', units: 1 }],
    total_float: null, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'g3', wbs_path: '1.2', name: 'Build',
    early_start: '2026-01-19', early_finish: '2026-01-30', planned_start: '2026-01-19',
    duration: 10, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'g1',
    status: 'NOT_STARTED', parent_epic: 'e-checkout',
    assignments: [{ resource_id: 'r-1', resource_name: 'Alice', units: 1 }],
    total_float: null, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'g4', wbs_path: '1.3', name: 'Review work',
    early_start: '2026-02-01', early_finish: '2026-02-05', planned_start: '2026-02-01',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'g1',
    status: 'REVIEW', parent_epic: 'e-onboarding',
    assignments: [{ resource_id: 'r-2', resource_name: 'Bob', units: 1 }],
    total_float: null, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'g5', wbs_path: '1.4', name: 'Unowned chore',
    early_start: '2026-01-05', early_finish: '2026-01-20', planned_start: '2026-01-05',
    duration: 12, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'g1',
    status: 'NOT_STARTED', assignments: [], parent_epic: null,
    total_float: null, predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'e-checkout', wbs_path: '2', name: 'Checkout', type: 'epic',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignments: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'e-onboarding', wbs_path: '3', name: 'Onboarding', type: 'epic',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignments: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 4 },
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('Board swimlane grouping (#324)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('defaults to Phase grouping', async ({ page }) => {
    const groupChip = page.getByRole('button', { name: 'Group lanes by' });
    await expect(groupChip).toContainText('Phase');
    await expect(page.getByText('Alpha Phase')).toBeVisible();
  });

  test('switching to By assignee shows one lane per assignee + Unassigned, and hides the phase lane', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By assignee' }).click();

    // Assignee lane headers (the card avatars render initials, so these names
    // are unique to the lane meta).
    await expect(page.getByText('Alice', { exact: true })).toBeVisible();
    await expect(page.getByText('Bob', { exact: true })).toBeVisible();
    await expect(page.getByText('Unassigned', { exact: true })).toBeVisible();

    // The phase lane header is gone — we are no longer grouping by phase.
    await expect(page.getByText('Alpha Phase')).not.toBeVisible();

    // The chip reflects the active mode.
    await expect(page.getByRole('button', { name: 'Group lanes by' })).toContainText('By assignee');
  });

  test('assignee lanes suppress the per-lane "+ add task" affordance', async ({ page }) => {
    // Phase mode offers it…
    await expect(page.getByRole('button', { name: 'Add task to Alpha Phase' })).toBeVisible();

    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By assignee' }).click();

    // …assignee mode does not (a lane id is a resource, not a parent).
    await expect(page.getByRole('button', { name: 'Add task to Alice' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add task to/ })).toHaveCount(0);
  });

  test('switching back to Phase restores the phase lane', async ({ page }) => {
    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By assignee' }).click();
    await expect(page.getByText('Alpha Phase')).not.toBeVisible();

    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'Phase' }).click();
    await expect(page.getByText('Alpha Phase')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add task to Alpha Phase' })).toBeVisible();
  });

  // Epic grouping (#364) ----------------------------------------------------

  test('switching to By epic shows one lane per epic + a "(No epic)" lane, and hides the phase lane', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By epic' }).click();

    // Epic lane headers (the epics never render as cards, so these names are
    // unique to the lane meta). The ungrouped card (g5) falls into "(No epic)".
    await expect(page.getByText('Checkout', { exact: true })).toBeVisible();
    await expect(page.getByText('Onboarding', { exact: true })).toBeVisible();
    await expect(page.getByText('(No epic)', { exact: true })).toBeVisible();

    // The phase lane header is gone — we are no longer grouping by phase.
    await expect(page.getByText('Alpha Phase')).not.toBeVisible();

    // The chip reflects the active mode.
    await expect(page.getByRole('button', { name: 'Group lanes by' })).toContainText('By epic');
  });

  test('epic lanes suppress the per-lane "+ add task" affordance', async ({ page }) => {
    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By epic' }).click();

    // An epic lane id is an epic, not a WBS parent — no per-lane add affordance.
    await expect(page.getByRole('button', { name: /Add task to/ })).toHaveCount(0);
  });

  test('switching back to Phase from By epic restores the phase lane', async ({ page }) => {
    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'By epic' }).click();
    await expect(page.getByText('Alpha Phase')).not.toBeVisible();

    await page.getByRole('button', { name: 'Group lanes by' }).click();
    await page.getByRole('radio', { name: 'Phase' }).click();
    await expect(page.getByText('Alpha Phase')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add task to Alpha Phase' })).toBeVisible();
  });
});

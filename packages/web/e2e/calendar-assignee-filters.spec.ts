import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * Calendar toolbar: Group by assignee swimlanes (#3169), the containing sprint in
 * the Week header (#3170), "My tasks only" (#3171) and the Month|Week radiogroup's
 * arrow keys (#3180, rule 179).
 */

const PROJECT_ID = 'e2e-calasg-0000-0000-0000-000000003169';
// 2026-03-11 is a Wednesday → the Mar 9–15 week.
const ANCHOR = '2026-03-11';
const url = (extra = '') =>
  `/projects/${PROJECT_ID}/calendar?calAnchor=${ANCHOR}&calView=week${extra}`;

const AISHA = { resource_id: 'res-aisha', resource_name: 'Aisha Khan', units: 100 };
const BEN = { resource_id: 'res-ben', resource_name: 'Ben Ortiz', units: 100 };

const task = (id: string, name: string, assignments: unknown[]) => ({
  id,
  wbs_path: id,
  name,
  early_start: '2026-03-10',
  early_finish: '2026-03-12',
  planned_start: '2026-03-10',
  duration: 3,
  percent_complete: 0,
  is_critical: false,
  status: 'NOT_STARTED',
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  assignments,
});

const TASKS = [
  task('asg-1', 'Pour Slab', [AISHA]),
  task('asg-2', 'Frame Walls', [BEN]),
  task('asg-3', 'Site Survey', []),
];

const SPRINT = {
  id: 'asg-sprint-1',
  server_version: 1,
  short_id: '3',
  short_id_display: 'SP-3',
  name: 'Sprint 3',
  goal: '',
  notes: '',
  start_date: '2026-03-02',
  finish_date: '2026-03-13',
  state: 'COMPLETED',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: null,
  wip_limit: null,
  committed_points: 0,
  committed_task_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: 0,
  completion_ratio_tasks: 0,
  activated_at: '2026-03-02T00:00:00Z',
  closed_at: '2026-03-13T00:00:00Z',
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-13T00:00:00Z',
};

// The current user is Aisha: the server flags her roster row with is_me.
const POOL_ROW = {
  id: 'pr-aisha',
  project: PROJECT_ID,
  resource: 'res-aisha',
  resource_detail: {
    id: 'res-aisha',
    name: 'Aisha Khan',
    job_role: 'Engineer',
    max_units: '1.00',
    calendar: null,
    skills: [],
    is_me: true,
  },
  role_title: '',
  units_override: null,
  effective_max_units: '1.00',
  notes: '',
};

test.describe('Calendar assignee filters, sprint header and radiogroup', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Assignee Project', start_date: '2026-03-01' }],
      tasks: TASKS,
    });
    // Last-registered wins: override the stock empty stubs.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [SPRINT] }),
      }),
    );
    await page.route('**/api/v1/project-resources/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [POOL_ROW] }),
      }),
    );
  });

  test('Group by assignee draws one named swimlane per person, Unassigned last (#3169)', async ({
    page,
  }) => {
    await page.goto(url());
    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('rowheader')).toHaveCount(0);

    await page.getByRole('button', { name: 'Group by assignee' }).click();

    await expect(page).toHaveURL(/calGroup=assignee/);
    const headers = page.getByRole('rowheader');
    await expect(headers).toHaveCount(3);
    await expect(headers.nth(0)).toContainText('Aisha Khan');
    await expect(headers.nth(1)).toContainText('Ben Ortiz');
    await expect(headers.nth(2)).toContainText('Unassigned');
    await expect(
      page.getByRole('grid', { name: 'Calendar dates' }).getByRole('gridcell'),
    ).toHaveCount(21);
    // Each task appears once, in its owner's lane.
    await expect(page.getByRole('button', { name: /Pour Slab/ })).toHaveCount(1);

    await page.getByRole('button', { name: 'Group by assignee' }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(0);
  });

  test('the Group toggle is Week-only (#3169)', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/calendar?calAnchor=${ANCHOR}&calView=month`);
    await expect(page.getByRole('heading', { level: 2, name: 'March 2026' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Group by assignee' })).toHaveCount(0);
  });

  test('the Week header names the containing sprint (#3170)', async ({ page }) => {
    await page.goto(url());
    // The sprint is in the past relative to the real clock, so it is named but has
    // no days-left count (that suffix is pinned in the unit tests).
    await expect(page.getByTestId('calendar-week-sprint')).toHaveText('Sprint 3');
    // Month mode has no single week to name a sprint for.
    await page.goto(`/projects/${PROJECT_ID}/calendar?calAnchor=${ANCHOR}&calView=month`);
    await expect(page.getByRole('heading', { level: 2, name: 'March 2026' })).toBeVisible();
    await expect(page.getByTestId('calendar-week-sprint')).toHaveCount(0);
  });

  test('"My tasks only" keeps just the current user\'s tasks (#3171)', async ({ page }) => {
    await page.goto(url());
    await expect(page.getByRole('button', { name: /Frame Walls/ })).toBeVisible({
      timeout: 10_000,
    });

    const mine = page.getByRole('button', { name: 'My tasks only' });
    await expect(mine).toHaveAttribute('aria-pressed', 'false');
    await mine.click();

    await expect(mine).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/calMine=1/);
    await expect(page.getByRole('button', { name: /Pour Slab/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Frame Walls/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Site Survey/ })).toHaveCount(0);
  });

  test('"My tasks only" with nothing of mine says so and offers a way out (#3171)', async ({
    page,
  }) => {
    await page.route('**/api/v1/project-resources/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.goto(url('&calMine=1'));
    await expect(page.getByText('Nothing assigned to you')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Show all tasks' }).click();
    await expect(page.getByRole('button', { name: /Frame Walls/ })).toBeVisible();
  });

  test('the view-mode control is one tab stop and arrows move and commit (#3180)', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_ID}/calendar?calAnchor=${ANCHOR}&calView=month`);
    const group = page.getByRole('radiogroup', { name: 'Calendar view mode' });
    await expect(group).toBeVisible({ timeout: 10_000 });
    const month = group.getByRole('radio', { name: 'Month' });
    const week = group.getByRole('radio', { name: 'Week' });

    await expect(month).toHaveAttribute('aria-checked', 'true');
    await expect(month).toHaveAttribute('tabindex', '0');
    await expect(week).toHaveAttribute('tabindex', '-1');

    await month.focus();
    await page.keyboard.press('ArrowRight');
    await expect(week).toHaveAttribute('aria-checked', 'true');
    await expect(week).toBeFocused();
    await expect(page).toHaveURL(/calView=week/);
    await expect(page.getByRole('heading', { level: 2, name: 'Mar 9 – 15, 2026' })).toBeVisible();

    await page.keyboard.press('Home');
    await expect(month).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(/calView=month/);
  });
});

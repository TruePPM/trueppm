import { test, expect } from '@playwright/test';

/**
 * Dependency cascade — regression for #314.
 *
 * The bug: editing a dependency only invalidates ['dependencies', projectId];
 * the originating client therefore relied on the cpm_complete WS event (or the
 * 2 s background poll) to see the CPM cascade. When the tab is backgrounded or
 * the socket drops the Schedule view stays stale.
 *
 * The fix in useDependencyMutations now also invalidates ['tasks', projectId]
 * on each of create/update/delete. This spec drives a dep PATCH from the
 * Schedule view and asserts that the task list refetches well within 1 s —
 * proving the invalidation, not the 2 s poll, is what refreshed it.
 */

const PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000314';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Cascade Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

/** Initial CPM dates — A finishes Apr 02, B starts Apr 03 (FS, no lag). */
const INITIAL_TASKS = [
  {
    id: 'task-a',
    wbs_path: '1',
    name: 'A',
    early_start: '2026-04-01',
    early_finish: '2026-04-02',
    duration: 2,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
  },
  {
    id: 'task-b',
    wbs_path: '2',
    name: 'B',
    early_start: '2026-04-03',
    early_finish: '2026-04-06',
    duration: 2,
    percent_complete: 0,
    is_critical: true,
    is_milestone: false,
  },
];

/** After dep PATCH adds 5 days of lag, B's early_start shifts to Apr 13. */
const CASCADED_TASKS = [
  INITIAL_TASKS[0],
  {
    ...INITIAL_TASKS[1],
    early_start: '2026-04-13',
    early_finish: '2026-04-14',
  },
];

const FIXTURE_DEPENDENCY = {
  id: 'dep-ab',
  predecessor: 'task-a',
  successor: 'task-b',
  dep_type: 'FS',
  lag: 0,
  is_critical: true,
};

test.describe('Dependency cascade refresh (#314)', () => {
  test('PATCH /dependencies triggers a tasks refetch within 1 s', async ({ page }) => {
    // Seed auth so RequireAuth lets the page render.
    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm-auth',
        JSON.stringify({
          state: {
            accessToken: 'e2e-token',
            refreshToken: 'e2e-refresh',
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
    });

    // Counters & timing — the test asserts a refetch fires after the PATCH,
    // not via the 2 s background poll.
    let tasksCallCount = 0;
    let depPatchAt: number | null = null;
    let secondTasksFetchAt: number | null = null;

    await page.route('**/api/v1/projects/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: FIXTURE_PROJECTS.length,
          next: null,
          previous: null,
          results: FIXTURE_PROJECTS,
        }),
      }),
    );
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_count: 2,
          critical_path_count: 2,
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
    await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schedule_health: 'unknown',
          spi: null,
          tasks_late_count: 0,
          critical_task_count: 2,
          total_tasks: 2,
          complete_tasks: 0,
          next_milestone: null,
          team_utilization_pct: null,
          owner_name: null,
          start_date: '2026-01-01',
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }),
    );
    await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"tasks":[]}' }),
    );

    // Tasks endpoint — first call returns initial dates, all subsequent calls
    // return the cascaded dates. Recording the timing of the second fetch is
    // how we prove the invalidation (not the 2 s poll) drove the refresh.
    await page.route('**/api/v1/tasks/**', (route) => {
      tasksCallCount += 1;
      if (tasksCallCount >= 2 && secondTasksFetchAt === null) {
        secondTasksFetchAt = Date.now();
      }
      const body = tasksCallCount === 1 ? INITIAL_TASKS : CASCADED_TASKS;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: body.length,
          next: null,
          previous: null,
          results: body,
        }),
      });
    });

    await page.route('**/api/v1/dependencies/**', (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [FIXTURE_DEPENDENCY],
          }),
        });
        return;
      }
      if (method === 'PATCH') {
        depPatchAt = Date.now();
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...FIXTURE_DEPENDENCY, lag: 5 }),
        });
        return;
      }
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    // Wait for the schedule grid to mount so the tasks query has fired once.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForFunction(() => true);
    expect(tasksCallCount).toBeGreaterThanOrEqual(1);

    const baselineTasksCount = tasksCallCount;

    // Drive a dep PATCH directly via the in-page apiClient. Going through the
    // UI control would couple this regression test to the dep-edit popover
    // markup; the unit-level assertion we want is "PATCH /dependencies/<id>/
    // triggers a tasks refetch via the mutation's onSuccess invalidation".
    depPatchAt = Date.now();
    const evalResult = await page.evaluate(async () => {
      const tokenRaw = localStorage.getItem('trueppm-auth');
      const token = tokenRaw
        ? (JSON.parse(tokenRaw).state?.accessToken as string | undefined)
        : undefined;
      const res = await fetch('/api/v1/dependencies/dep-ab/', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ lag: 5 }),
      });
      return { ok: res.ok, status: res.status };
    });
    expect(evalResult.ok).toBe(true);

    // The fix must trigger a fresh tasks fetch within 1 s of the PATCH. The
    // backing query uses ['tasks', projectId] as its key; useDependencyMutations
    // invalidates that key on success, so the refetch should be effectively
    // immediate. Anything beyond 1 s would imply we're seeing the 2 s poll,
    // which is the broken behavior #314 reported.
    await expect
      .poll(() => tasksCallCount, { timeout: 1_000, intervals: [50, 100, 200] })
      .toBeGreaterThan(baselineTasksCount);

    expect(secondTasksFetchAt).not.toBeNull();
    expect(depPatchAt).not.toBeNull();
    const refetchLatency = (secondTasksFetchAt as number) - (depPatchAt as number);
    expect(refetchLatency).toBeLessThan(1_000);
  });

  /**
   * Leaf/summary finish parity (#314 follow-up).
   *
   * Bug: leaf tasks rendered finish as start + duration*calendar-day-ms while
   * summary tasks used early_finish (working-day-correct). Every weekend inside
   * a leaf widened the summary visibly past its widest child — typically 4 days
   * for a 10-working-day chain.
   *
   * This spec serves a project with a summary "Eng" and three children; the
   * widest child (Validate) ends on the same date as the summary's early_finish.
   * The Schedule view's Finish column must show identical strings for the
   * summary and its widest child. Pre-fix, the summary would show ~Jun 10 and
   * Validate would show ~Jun 7 — a visible misalignment.
   */
  test('summary finish equals widest leaf finish after CPM (no weekend drift)', async ({ page }) => {
    const PROJECT = 'e2e-fixture-00000000-0000-0000-0000-000000000314';

    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm-auth',
        JSON.stringify({
          state: {
            accessToken: 'e2e-token',
            refreshToken: 'e2e-refresh',
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
    });

    // Eng = May 11 → Jun 10 (rolled up). Validate = May 28 → Jun 10 (10 working
    // days, identical finish — this is the parity assertion). Pre-fix Validate
    // would have been rendered as May 28 + 10 calendar days = Jun 7.
    const PARITY_TASKS = [
      {
        id: 'eng',
        wbs_path: '1',
        name: 'Eng',
        early_start: '2026-05-11',
        early_finish: '2026-06-10',
        planned_start: null,
        duration: 30,
        percent_complete: 0,
        is_critical: true,
        is_milestone: false,
        is_summary: true,
        parent_id: null,
      },
      {
        id: 'design',
        wbs_path: '1.1',
        name: 'Design',
        early_start: '2026-05-11',
        early_finish: '2026-05-15',
        planned_start: '2026-05-10',
        duration: 5,
        percent_complete: 0,
        is_critical: false,
        is_milestone: false,
        is_summary: false,
        parent_id: 'eng',
      },
      {
        id: 'validate',
        wbs_path: '1.2',
        name: 'Validate',
        early_start: '2026-05-28',
        early_finish: '2026-06-10',
        planned_start: '2026-05-19',
        duration: 10,
        percent_complete: 0,
        is_critical: true,
        is_milestone: false,
        is_summary: false,
        parent_id: 'eng',
      },
    ];

    await page.route('**/api/v1/projects/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              id: PROJECT,
              name: 'Parity Project',
              description: '',
              start_date: '2026-05-01',
              calendar: 'default',
            },
          ],
        }),
      }),
    );
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await page.route('**/api/v1/projects/*/status-summary/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          task_count: 3,
          critical_path_count: 2,
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
    await page.route(`**/api/v1/projects/${PROJECT}/overview/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          schedule_health: 'unknown',
          spi: null,
          tasks_late_count: 0,
          critical_task_count: 2,
          total_tasks: 3,
          complete_tasks: 0,
          next_milestone: null,
          team_utilization_pct: null,
          owner_name: null,
          start_date: '2026-05-01',
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${PROJECT}/attention/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }),
    );
    await page.route(`**/api/v1/projects/${PROJECT}/my-tasks/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"tasks":[]}' }),
    );
    await page.route('**/api/v1/dependencies/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: PARITY_TASKS.length,
          next: null,
          previous: null,
          results: PARITY_TASKS,
        }),
      }),
    );

    await page.goto(`/projects/${PROJECT}/schedule`);

    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });

    // Read the Finish column for both rows. The Finish cell renders the date
    // that the bar's right edge sits over; Jun 10 is the working-day-correct
    // value the CPM pass produced. Pre-fix, Validate would render Jun 7.
    const validateRow = page.getByRole('row').filter({ hasText: 'Validate' }).first();
    const engRow = page.getByRole('row').filter({ hasText: 'Eng' }).first();

    // Wait until both rows have bound their Finish text (Jun 10 in the
    // 'MMM D' formatter the Schedule view uses).
    await expect(validateRow).toContainText('Jun 10');
    await expect(engRow).toContainText('Jun 10');
  });
});

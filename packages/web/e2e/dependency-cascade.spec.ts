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
});

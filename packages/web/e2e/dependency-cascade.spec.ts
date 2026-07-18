import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Dependency cascade — regression for #314.
 *
 * The original cache-invalidation behavior (mutation onSuccess invalidates
 * ['tasks', projectId] alongside ['dependencies', projectId]) is covered
 * deterministically by the vitest unit test in
 * `src/hooks/useDependencyMutations.test.ts`. An earlier draft of this file
 * tried to drive the assertion through `page.evaluate(fetch(...))` but that
 * bypasses the React mutation entirely and never invalidates the cache, so
 * the assertion was structurally impossible to satisfy.
 *
 * What this Playwright spec covers is the *visual* invariant the user sees:
 * a summary task's bar must end on the same date as its widest leaf child
 * once CPM has produced early_finish. Pre-fix the summary used early_finish
 * (working-day-correct) while the leaf used start + duration*calendar-day-ms,
 * so every weekend inside a leaf widened the summary visibly past its widest
 * child — typically 4 days for a 10-working-day chain.
 */

test.describe('Dependency cascade refresh (#314)', () => {
  test('summary finish equals widest leaf finish after CPM (no weekend drift)', async ({
    page,
  }) => {
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

    // Catch-all 401-guard, registered FIRST so every specific route below wins
    // (Playwright matches routes LIFO). Any endpoint the app-wide shell + ⌘K
    // palette read but this spec does not mock (programs, sprints, …) would
    // otherwise cascade through 401-recovery into the SessionExpired banner,
    // which then intercepts every click. #647's extra app-wide subscriptions
    // removed the timing slack that previously let this spec pass without it.
    // Shared 404 catch-all (issue 1513): unmocked endpoints 404 loudly instead of
    // being masked by a permissive 200-list body (the #1190 flake class).
    await setupCatchAll(page);
    // Real current-user so the shell does not treat the session as
    // unauthenticated (the empty-list catch-all above would otherwise stand in).
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'u1',
          email: 'pm@example.com',
          first_name: 'P',
          last_name: 'M',
        }),
      }),
    );

    // Project detail — ProjectShell gates every project route on this query
    // (#1111). Without an object-shaped 200 the catch-all above serves a list
    // `{count,results}` for it (the #1190 vector). Real shape mirrors
    // schedule.spec.ts.
    await page.route(`**/api/v1/projects/${PROJECT}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: PROJECT,
          name: 'Parity Project',
          description: '',
          start_date: '2026-05-01',
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

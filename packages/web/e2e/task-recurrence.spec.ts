import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the recurrence drawer section (#738 / ADR-0090).
 *
 * Golden path: a Scheduler+ opens the drawer, expands Recurrence, adds a weekly
 * rule, and sees the CPM-exclusion banner plus a live "Next 4 occurrences" preview.
 * Read-only path: a Member sees a configured rule's summary with no edit affordance.
 *
 * All API calls are intercepted with Playwright route mocking, mirroring
 * task-drawer-redesign.spec.ts.
 */

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000001';

const FIXTURE_API_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Alpha Platform Upgrade',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    estimation_mode: 'open',
  },
];

const FIXTURE_API_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Weekly Safety Walk',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: null,
    most_likely_duration: null,
    pessimistic_duration: null,
    estimate_status: null,
    status: 'NOT_STARTED',
    planned_start: null,
    assignments: [],
  },
];

interface SetupOptions {
  /** Role ordinal returned by /members/?self=true (200=Scheduler, 100=Member). */
  role: number;
  /** Recurrence rule the GET returns (null → empty list). */
  rule: Record<string, unknown> | null;
}

async function setup(page: Page, { role, rule }: SetupOptions) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const page200 = (results: unknown[]) =>
    json({ count: results.length, next: null, previous: null, results });

  await page.route('**/api/v1/projects/', (r) => r.fulfill(page200(FIXTURE_API_PROJECTS)));
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/members/**', (r) =>
    r.fulfill(json([{ id: 'm1', role }])),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill(
      json({
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
    ),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (r) =>
    r.fulfill(
      json({
        schedule_health: 'unknown',
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
    ),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (r) =>
    r.fulfill(json({ items: [] })),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill(json({ tasks: [] })),
  );
  await page.route('**/api/v1/dependencies/**', (r) => r.fulfill(page200([])));
  await page.route('**/api/v1/task-resources/**', (r) => r.fulfill(page200([])));
  await page.route('**/api/v1/resources/**', (r) => r.fulfill(page200([])));

  // Recurrence: stateful so a save persists into the follow-up GET refetch — GET
  // returns the current rule (0 or 1), POST stores and echoes the created rule.
  let currentRule = rule;
  await page.route('**/api/v1/recurrence-rules/**', (r) => {
    if (r.request().method() === 'POST') {
      currentRule = {
        id: 'new-rule',
        server_version: 1,
        occurrence_count: 0,
        generated_through: null,
        ...JSON.parse(r.request().postData() ?? '{}'),
      };
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(currentRule) });
    }
    return r.fulfill(page200(currentRule ? [currentRule] : []));
  });

  // Tasks must come last among the broad /tasks/ matchers so it isn't shadowed.
  await page.route('**/api/v1/tasks/**', (r) => r.fulfill(page200(FIXTURE_API_TASKS)));

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openRecurrence(page: Page) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText('Weekly Safety Walk', { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: /Weekly Safety Walk/ }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  await drawer.getByRole('button', { name: 'Recurrence' }).click();
  return drawer;
}

test('Scheduler+ configures a weekly recurrence and sees the banner + preview', async ({ page }) => {
  await setup(page, { role: 200, rule: null });
  const drawer = await openRecurrence(page);

  // Empty state offers an Add affordance.
  await expect(drawer.getByText(/doesn't repeat/i)).toBeVisible();
  await drawer.getByRole('button', { name: 'Add recurrence' }).click();

  // Editor: weekly is the default, so the weekday picker, banner and preview show.
  await expect(drawer.getByText(/CPM compute/i)).toBeVisible();
  await expect(drawer.getByRole('group', { name: 'Days of week' })).toBeVisible();
  await expect(drawer.getByText('Next 4 occurrences')).toBeVisible();

  // The default weekly draft already has today's weekday selected (valid), so the
  // save action is enabled — persist it.
  const save = drawer.getByRole('button', { name: 'Add recurrence' });
  await expect(save).toBeEnabled();
  await save.click();

  // After save the editor closes back to the configured summary (refetch returns the rule).
  await expect(drawer.getByRole('button', { name: 'Edit recurrence' })).toBeVisible();
});

test('a read-only Member sees a configured rule summary with no edit button', async ({ page }) => {
  const rule = {
    id: 'rule-1',
    server_version: 1,
    task: 't1',
    frequency: 'WEEKLY',
    interval: 1,
    weekdays: 1,
    day_of_month: null,
    time_of_day: '09:00:00',
    timezone: 'UTC',
    end_type: 'NEVER',
    end_date: null,
    end_count: null,
    inherit_assignee: true,
    inherit_subtasks: false,
    inherit_attachments: false,
    inherit_morning_notification: false,
    generated_through: null,
    occurrence_count: 2,
  };
  await setup(page, { role: 100, rule });
  const drawer = await openRecurrence(page);

  await expect(drawer.getByText(/CPM compute/i)).toBeVisible();
  await expect(drawer.getByText('Next 4 occurrences')).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Edit recurrence/i })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'Add recurrence' })).toHaveCount(0);
});

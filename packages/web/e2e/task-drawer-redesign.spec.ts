import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the redesigned TaskDetailDrawer (issues #306 + #309 / ADR-0050).
 *
 * Replaces the prior tab-based drawer (ADR-0032) with a registry-driven
 * collapsible-section list. Header is sticky; meta rail (status, dates,
 * duration, float, progress) is sticky on the left; sections render in
 * priority order. Overview is open by default; all others start collapsed.
 *
 * Each registered section is wrapped in an error boundary so a buggy section
 * cannot crash the drawer chrome — test coverage for that path lives in the
 * vitest unit at src/features/schedule/sections/SectionErrorBoundary.test.tsx.
 *
 * All API calls are intercepted with Playwright route mocking.
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
    name: 'Discovery & Design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 50,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    actual_start: null,
    actual_finish: null,
    schedule_variance_days: null,
    baseline_start: null,
    baseline_finish: null,
    optimistic_duration: 7,
    most_likely_duration: 10,
    pessimistic_duration: 15,
    estimate_status: null,
    status: 'IN_PROGRESS',
    planned_start: null,
    assignments: [],
  },
  {
    id: 't2',
    wbs_path: '2',
    name: 'Backend Implementation',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    duration: 10,
    percent_complete: 0,
    total_float: 0,
    is_critical: true,
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

const FIXTURE_HISTORY = {
  count: 1,
  next: null,
  previous: null,
  results: [
    {
      id: 1,
      history_date: '2026-04-25T10:00:00Z',
      history_type: '~',
      history_user: 'alice',
      diff: [{ field: 'duration', old: '8', new: '10' }],
    },
  ],
};

async function gotoSchedule(page: Page) {
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
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_API_PROJECTS }),
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
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown',
        spi: null,
        tasks_late_count: 0,
        critical_task_count: 0,
        total_tasks: 0,
        complete_tasks: 0,
        next_milestone: null,
        team_utilization_pct: null,
        owner_name: null,
        start_date: '2026-01-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_API_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_API_TASKS,
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
  await page.route('**/api/v1/task-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/tasks/*/history/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(FIXTURE_HISTORY),
    }),
  );
  await page.route('**/tasks/*/baseline/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ has_baseline: false }),
    }),
  );

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
}

async function openDrawer(page: Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await expect(grid).toBeVisible({ timeout: 10_000 });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

test.describe('TaskDetailDrawer redesign — section list', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('renders OSS sections in priority order', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');

    // Each section's collapsible header is a <button> with the title as its
    // accessible name. The visible ▶ glyph sits in an aria-hidden span, so
    // textContent includes it but the accessible name does not — filter by
    // accessible name to avoid leaking the glyph into the assertion.
    //
    // Unconditional sections from sections/index.ts in priority order. Sprint
    // (150) is conditional on the task having an active sprint and is omitted
    // here; Subtasks (300) renders for non-milestone tasks, which Discovery &
    // Design is.
    const sectionNames = [
      'Overview',       // 100
      'Dependencies',   // 200
      'Subtasks',       // 300 (Discovery & Design is non-milestone)
      'Attachments',    // 400 (#310)
      'External links', // 450 (#637)
      'Comments',       // 500 (#311)
      'Activity',       // 600
      'Estimates',      // 800
      'History',        // 900
      'Baseline',       // 1000
    ];
    const headers = drawer.getByRole('button', {
      name: new RegExp(`^(${sectionNames.join('|')})$`),
    });
    await expect(headers).toHaveCount(sectionNames.length);

    const titles = await headers.evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? el.querySelector('span:not([aria-hidden])')?.textContent ?? ''),
    );
    expect(titles).toEqual(sectionNames);
  });

  test('Overview section is expanded by default', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const overview = drawer.getByRole('button', { name: 'Overview' });
    await expect(overview).toHaveAttribute('aria-expanded', 'true');
  });

  test('Assignees editor lives inside Overview, not under Dependencies (#313)', async ({ page }) => {
    // Regression guard: pre-#313 the assignees editor was rendered inside the
    // legacy DependenciesTab, so opening the drawer surfaced a "Resources"
    // block under Dependencies that duplicated the Overview Assignees list.
    // The mockup has no such block — Assignees is the only home for this UI.
    const drawer = await openDrawer(page, 'Discovery & Design');
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Dependencies' }).click();
    await expect(drawer.getByRole('region', { name: 'Assignees' })).toHaveCount(1);
  });

  test('other sections start collapsed', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    for (const name of [
      'Dependencies',
      'Subtasks',
      'Attachments',
      'External links',
      'Comments',
      'Activity',
      'Estimates',
      'History',
      'Baseline',
    ]) {
      await expect(drawer.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('clicking a section header expands and shows its content', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Estimates' }).click();
    await expect(drawer.getByRole('button', { name: 'Estimates' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // PERT panel content from EstimatesTab — present once the section's body mounts.
    await expect(drawer.getByRole('region', { name: /PERT/i })).toBeVisible();
  });

  test('clicking an expanded section header collapses it', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const overview = drawer.getByRole('button', { name: 'Overview' });
    await overview.click();
    await expect(overview).toHaveAttribute('aria-expanded', 'false');
  });

  test('History section shows audit records when expanded', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'History' }).click();
    await expect(drawer.getByText('Updated')).toBeVisible({ timeout: 5_000 });
    await expect(drawer.getByText('alice')).toBeVisible();
  });

  test('Baseline section shows no-baseline empty state when expanded', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Baseline' }).click();
    await expect(drawer.getByText(/No baseline set/i)).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('TaskDetailDrawer redesign — meta rail', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('shows status, start, finish, duration, float, progress', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const rail = drawer.getByRole('complementary', { name: 'Task vitals' });
    // Each row is a group with an aria-label matching the row label.
    for (const label of ['Status', 'Start', 'Finish', 'Duration', 'Float', 'Progress']) {
      await expect(rail.getByRole('group', { name: label })).toBeVisible();
    }
    // Duration value comes through with .tppm-mono numeric formatting.
    await expect(rail.getByText('10d', { exact: true })).toBeVisible();
  });

  test('renders critical-path styling on float for a critical task', async ({ page }) => {
    const drawer = await openDrawer(page, 'Backend Implementation');
    const rail = drawer.getByRole('complementary', { name: 'Task vitals' });
    // Critical tasks render their float as "{Nd · CP}" — text presence is a
    // sufficient proxy for the styling here; pixel-level color is out of scope.
    await expect(rail.getByText(/CP/)).toBeVisible();
  });

  test('progress bar reflects task percent_complete', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    const rail = drawer.getByRole('complementary', { name: 'Task vitals' });
    const bar = rail.getByRole('progressbar', { name: 'Task progress' });
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
  });
});

test.describe('TaskDetailDrawer redesign — chrome', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
  });

  test('Esc closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
  });

  test('clicking the close button closes the drawer', async ({ page }) => {
    const drawer = await openDrawer(page, 'Discovery & Design');
    await drawer.getByRole('button', { name: 'Close task detail' }).click();
    await expect(drawer).not.toBeVisible();
  });
});

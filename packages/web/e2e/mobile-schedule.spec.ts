import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Mobile-first Schedule surface E2E (#1671, ADR-0348).
 *
 * Below md the Schedule renders a dedicated DOM list-timeline (MobileSchedule),
 * NOT the desktop canvas. At a 375px phone viewport we assert: the WBS rows
 * render, the Unscheduled tray shows its count, a row tap opens the shared
 * TaskDetailDrawer (mobile bottom sheet), the one-tap complete fires the toggle
 * PATCH, and the empty state renders when the project has no tasks.
 */

const PROJECT_ID = 'e2e-mobsched-0000-0000-0000-000000000001';
const VIEWPORT = { width: 375, height: 812 };

// Two scheduled leaves (planned_start set → stay out of the tray) + one
// unscheduled backlog item (NOT_STARTED, no planned_start → routed to the tray).
const TASKS = [
  {
    id: 'm1',
    wbs_path: '1',
    name: 'Discovery and design',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    planned_start: '2026-10-05',
    duration: 10,
    percent_complete: 100,
    // Completed task → never critical (#1863).
    is_critical: false,
    is_milestone: false,
    status: 'COMPLETE',
    is_summary: false,
    parent_id: null,
    can_edit: true,
  },
  {
    id: 'm2',
    wbs_path: '2',
    name: 'Backend build',
    early_start: '2026-10-19',
    early_finish: '2026-10-30',
    planned_start: '2026-10-19',
    duration: 10,
    percent_complete: 60,
    is_critical: false,
    is_milestone: false,
    status: 'IN_PROGRESS',
    is_summary: false,
    parent_id: null,
    can_edit: true,
  },
  {
    id: 'm3',
    wbs_path: '3',
    name: 'Icebox research spike',
    early_start: null,
    early_finish: null,
    duration: 0,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    status: 'NOT_STARTED',
    is_summary: false,
    parent_id: null,
    can_edit: true,
  },
];

async function gotoMobileSchedule(
  page: Page,
  tasks: Record<string, unknown>[] = TASKS,
): Promise<void> {
  await page.setViewportSize(VIEWPORT);
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Ensure the Unscheduled tray is expanded (auto-expand also fires on first
    // appearance, but seed the persisted key so the test is deterministic).
    localStorage.removeItem('trueppm.mobile.schedule.unscheduled.collapsed');
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  const page0 = { count: 0, next: null, previous: null, results: [] };

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(
      json({
        count: 1,
        next: null,
        previous: null,
        results: [
          { id: PROJECT_ID, name: 'Mobile Sched', description: '', start_date: '2026-01-01', calendar: 'default' },
        ],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill(
      json({
        id: PROJECT_ID,
        name: 'Mobile Sched',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        estimation_mode: 'OPEN',
        agile_features: false,
        methodology: 'HYBRID',
        effective_methodology: 'HYBRID',
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
        effective_surface_visibility: {
          reporting: true,
          time_tracking: true,
          baselines: true,
          monte_carlo: true,
        },
        server_version: 1,
      }),
    ),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill(
      json({
        task_count: tasks.length,
        critical_path_count: 1,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 1,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill(
      json({
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
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) => r.fulfill(json({ items: [] })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) => r.fulfill(json({ tasks: [] })));
  await page.route('**/api/v1/tasks/**', (r) =>
    r.fulfill(json({ count: tasks.length, next: null, previous: null, results: tasks })),
  );
  await page.route('**/api/v1/dependencies/**', (r) => r.fulfill(json(page0)));
  await page.route('**/api/v1/ws/ticket/', (r) => r.fulfill(json({ ticket: 'e2e', expires_in: 30 })));
  await page.route('**/api/v1/auth/token/refresh/', (r) => r.fulfill(json({ access: 'e2e-token' })));
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json({ id: 'u1', email: 'e2e@example.com', first_name: 'E', last_name: '2E', is_staff: false })),
  );
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill(json({ id: 'w1', name: 'E2E', public_sharing_enabled: false })),
  );
  await page.route('**/api/v1/programs/**', (r) => r.fulfill(json(page0)));
  await page.route('**/api/v1/projects/*/members/**', (r) => r.fulfill(json(page0)));
  await page.route('**/api/v1/projects/*/sprints/**', (r) => r.fulfill(json(page0)));
  await page.route('**/api/v1/projects/*/velocity/**', (r) => r.fulfill(json({ sprints: [] })));
  await page.route('**/api/v1/projects/*/monte-carlo/latest/**', (r) =>
    r.fulfill({ status: 204, contentType: 'application/json', body: '' }),
  );
  await page.route('**/api/v1/projects/*/visit/', (r) => r.fulfill(json({ ok: true })));
  await page.route('**/api/v1/me/work/**', (r) => r.fulfill(json({ tasks: [] })));
  await page.route('**/api/v1/me/notifications/**', (r) => r.fulfill(json(page0)));
  // Global chrome the mobile shell reads — unmocked these 401 and trip the
  // session-expired modal (`fixed inset-0 z-100`), which then eats every tap.
  await page.route('**/api/v1/me/active-sprints/', (r) => r.fulfill(json([]))); // bare array
  await page.route('**/api/v1/me/timer/', (r) => r.fulfill(json({ active: false })));
  await page.routeWebSocket('**/ws/v1/projects/**', () => {});

  await page.goto(`/projects/${PROJECT_ID}/schedule`);
}

test.describe('Mobile Schedule surface (#1671)', () => {
  test('renders the WBS list, the Unscheduled tray, and opens the drawer on tap', async ({
    page,
  }) => {
    await gotoMobileSchedule(page);

    // Page-rendered signal: a scheduled row is present (the mobile list mounted).
    const backendRow = page.getByRole('button', { name: /Backend build, In progress/ });
    await expect(backendRow).toBeVisible({ timeout: 10_000 });

    // The desktop canvas + toolbar must NOT be present below md.
    await expect(page.getByRole('toolbar', { name: 'Schedule toolbar' })).toHaveCount(0);

    // The Unscheduled tray shows the one backlog item with its count.
    await expect(page.getByRole('button', { name: /Unscheduled/ })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Icebox research spike, unscheduled/ }),
    ).toBeVisible();

    // Tapping a row opens the shared TaskDetailDrawer as a mobile bottom sheet
    // (the desktop drawer shell is display:none below md, so :visible is unique).
    await backendRow.click();
    const sheet = page.locator('[role="dialog"]:visible');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Backend build');
  });

  test('one-tap complete fires the toggle PATCH', async ({ page }) => {
    await gotoMobileSchedule(page);
    await expect(page.getByRole('button', { name: /Backend build, In progress/ })).toBeVisible({
      timeout: 10_000,
    });

    let patchBody: unknown = null;
    await page.route('**/api/v1/tasks/*/', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      patchBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TASKS[1], status: 'COMPLETE', percent_complete: 100 }),
      });
    });

    await page.getByRole('button', { name: /Mark Backend build complete/i }).click();
    await expect.poll(() => patchBody).toEqual({ status: 'COMPLETE' });
  });

  test('renders the empty state for a project with no tasks', async ({ page }) => {
    await gotoMobileSchedule(page, []);
    await expect(page.getByText('No tasks yet')).toBeVisible({ timeout: 10_000 });
  });
});

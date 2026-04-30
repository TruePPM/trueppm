/**
 * Wave 9 — Board Workshop mode E2E (ADR-0046).
 *
 * Golden path: admin starts a workshop session; banner appears with elapsed
 * timer and End Workshop button; exit confirmation dialog appears on click;
 * confirming ends the session and returns to normal board.
 *
 * Error / empty state: workshop toggle is absent for unauthenticated views
 * (not tested here — the auth guard is covered in auth.spec.ts).
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-workshop-00000000-0000-0000-0000-000000000099';
const BASE_URL = `/projects/${PROJECT_ID}`;

const SESSION_ID = 'ws-session-uuid-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Workshop Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'wt1', wbs_path: '1', name: 'Phase One',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
  {
    id: 'wt2', wbs_path: '1.1', name: 'Task A',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    duration: 10, percent_complete: 80, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'wt1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
    server_version: 1,
  },
];

const ACTIVE_SESSION = {
  id: SESSION_ID,
  project_id: PROJECT_ID,
  started_by_id: 'user-uuid',
  started_at: new Date().toISOString(),
  ended_at: null,
  participants: [],
};

const ENDED_SESSION = {
  ...ACTIVE_SESSION,
  ended_at: new Date().toISOString(),
};

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  // Standard project/task fixtures
  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ schedule_health: 'unknown', spi: null, tasks_late_count: 0, critical_task_count: 0, total_tasks: 2, complete_tasks: 0, next_milestone: null, team_utilization_pct: null, owner_name: null, start_date: '2026-01-01' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 2, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: FIXTURE_TASKS.length, next: null, previous: null, results: FIXTURE_TASKS }),
    }),
  );
  await page.route('**/api/v1/calendars/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',      label: 'Backlog',      visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED',  label: 'To Do',        visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS',  label: 'In Progress',  visible: true, wip_limit: 5,    color: '#3B82F6' },
          { status: 'REVIEW',       label: 'Review',       visible: true, wip_limit: 3,    color: '#A855F7' },
          { status: 'COMPLETE',     label: 'Done',         visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ edition: 'community' }) }),
  );
  // Prevent real backend 401s from clearing auth state
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2e-user', username: 'e2euser', display_name: 'E2E User', initials: 'EU', email: 'e2e@example.com' }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-admin', role: 3 }]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/risks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, window_start: '2026-01-01', window_end: '2026-03-01', resources: [] }),
    }),
  );
  await page.route('**/api/v1/monte-carlo/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: 0, p50: null, p80: null, p95: null, buckets: [] }),
    }),
  );

  // Workshop: no active session initially
  await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
    } else {
      route.continue();
    }
  });
}

test.describe('Workshop mode', () => {
  test('toolbar shows workshop toggle button', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Phase One')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByRole('button', { name: /workshop/i })).toBeVisible();
  });

  test('starting workshop shows banner and End Workshop button', async ({ page }) => {
    await setup(page);

    // Override: start returns active session; current returns session after start
    let sessionActive = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
      sessionActive = true;
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(ACTIVE_SESSION),
      });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
      if (sessionActive) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
      }
    });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Phase One')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /workshop/i }).click();

    // Banner should appear
    await expect(page.getByRole('status', { name: /workshop/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /end workshop/i })).toBeVisible();
  });

  test('End Workshop button shows confirmation dialog', async ({ page }) => {
    await setup(page);

    let sessionActive = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
      sessionActive = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
      if (sessionActive) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
      }
    });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Phase One')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /workshop/i }).click();
    await page.waitForTimeout(200);

    // Click End Workshop in the banner
    await page.getByRole('button', { name: /end workshop/i }).click();

    // Confirmation dialog should appear
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/end workshop session/i)).toBeVisible();
  });

  test('confirming exit ends session and hides banner', async ({ page }) => {
    await setup(page);

    let sessionActive = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
      sessionActive = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
      if (sessionActive) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
      }
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/end/`, (route) => {
      sessionActive = false;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ENDED_SESSION) });
    });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Phase One')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /workshop/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /end workshop/i }).click();

    // Click End Workshop in the confirmation dialog
    await page.getByRole('dialog').getByRole('button', { name: /end workshop/i }).click();

    // Banner should be gone
    await expect(page.getByRole('status', { name: /workshop/i })).not.toBeVisible();
  });

  test('cancel in confirmation dialog keeps session active', async ({ page }) => {
    await setup(page);

    let sessionActive = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
      sessionActive = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
      if (sessionActive) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
      }
    });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Phase One')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /workshop/i }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /end workshop/i }).click();

    // Cancel the dialog
    await page.getByRole('dialog').getByRole('button', { name: /cancel/i }).click();

    // Banner should still be visible
    await expect(page.getByRole('status', { name: /workshop/i })).toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('empty board in workshop mode shows Add Phase button', async ({ page }) => {
    await setup(page);

    // Override tasks to return empty list
    await page.route('**/api/v1/tasks/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );

    let sessionActive = false;
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/start/`, (route) => {
      sessionActive = true;
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
    });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/workshop/current/`, (route) => {
      if (sessionActive) {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_SESSION) });
      } else {
        route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active session.' }) });
      }
    });

    await page.goto(`${BASE_URL}/board`);
    // With empty tasks the board shows "No tasks yet" — start workshop
    await expect(page.getByRole('button', { name: /workshop/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /workshop/i }).click();
    await page.waitForTimeout(200);

    // Workshop canvas should show "Add Phase" button, not the generic empty state
    await expect(page.getByRole('button', { name: /\+ Add Phase/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('No tasks yet')).not.toBeVisible();
  });
});

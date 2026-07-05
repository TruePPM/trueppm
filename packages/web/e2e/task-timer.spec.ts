import { test, expect, type Page } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E for the live running timer (#1415, ADR-0185 §C).
 *
 * Golden path: start a timer from a My Work row → the app-wide header chip shows
 * the running state → stop → a TimeEntry is logged and a success toast offers
 * Undo. Plus the Viewer/permission error path (403 → friendly toast, no chip).
 *
 * All API calls are Playwright-mocked; no server required. The running state is
 * driven by the start mutation's response writing the timer into the query cache
 * (the chip does not depend on a re-poll of GET /me/timer/).
 */

const PROJECT_ID = 'e2e-timer-00000000-0000-0000-0000-000000001415';
const TASK_ID = 'task-timer-aaaa';

const TASK = {
  id: TASK_ID,
  short_id: 'PRJ-01a',
  name: 'Build the login form',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  program_id: 'prog-timer-cccc',
  program_name: 'Apollo Program',
  program_color: '#3366cc',
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: 3,
  remaining_points: 2,
  due: '2026-05-30',
  due_source: 'planned',
  is_critical: false,
  group: 'today',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 100,
  url: `/projects/${PROJECT_ID}/schedule?task=${TASK_ID}`,
};

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  name: 'Design App',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'HYBRID',
};

const ACTIVE_TIMER = {
  id: 'timer-e2e-1',
  task: TASK_ID,
  task_short_id: 'PRJ-01a',
  task_name: 'Build the login form',
  project: PROJECT_ID,
  // ~24 minutes ago so the chip shows a non-zero clock immediately.
  started_at: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
  elapsed_seconds: 24 * 60,
  note: '',
  stale: false,
};

async function setupAuthenticatedPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'priya',
        display_name: 'Priya',
        initials: 'P',
        email: 'priya@example.com',
        max_project_role: 100,
        workspace_role: null,
        can_access_admin_settings: false,
        default_landing: 'my_work',
        landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
      }),
    }),
  );

  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
}

async function setupWithTask(page: Page): Promise<void> {
  await setupAuthenticatedPage(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PROJECT_DETAIL] }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [TASK],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 1,
        server_version_high_water: 100,
      }),
    }),
  );
  // No timer running on first load.
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
  );
}

test.describe('Live running timer (#1415, ADR-0185 §C)', () => {
  test('start from a My Work row → header chip runs → stop → logged with Undo', async ({ page }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    // Start writes the active timer; the chip + row read it from the cache.
    await page.route('**/api/v1/me/timer/start', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ active_timer: ACTIVE_TIMER, finalized_entry: null }),
      }),
    );
    // Stop logs a 24-minute entry.
    await page.route('**/api/v1/me/timer/stop', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'entry-e2e-1',
          task: TASK_ID,
          minutes: 24,
          entry_date: '2026-07-05',
          note: '',
          source: 'timer',
          server_version: 1,
          created_at: new Date().toISOString(),
        }),
      }),
    );

    await page.goto('/me/work');

    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Build the login form' })).toBeVisible();

    // Start the timer from the row.
    await assigned.getByRole('button', { name: 'Start timer on Build the login form' }).click();

    // The app-wide header chip appears in the running state.
    const chip = page.getByRole('status', {
      name: /Timer running on PRJ-01a · Build the login form/,
    });
    await expect(chip).toBeVisible();

    // The row mirrors the running state — the Start control is replaced by a Stop.
    await expect(
      assigned.getByRole('button', { name: 'Start timer on Build the login form' }),
    ).toHaveCount(0);
    await expect(
      assigned.getByRole('button', { name: 'Stop timer on Build the login form and log time' }),
    ).toBeVisible();

    // Stop from the header chip → success toast with Undo.
    await chip.getByRole('button', { name: /Stop timer and log time/ }).click();

    await expect(page.getByText('Logged 24m on PRJ-01a · Build the login form')).toBeVisible();
    await expect(page.getByRole('button', { name: /Undo/ })).toBeVisible();

    // The chip clears once stopped.
    await expect(chip).toHaveCount(0);
  });

  test('a Viewer (403) sees a friendly permission message and no chip', async ({ page }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    await page.route('**/api/v1/me/timer/start', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'You do not have permission to perform this action.' }),
      }),
    );

    await page.goto('/me/work');

    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await assigned.getByRole('button', { name: 'Start timer on Build the login form' }).click();

    await expect(
      page.getByText("You don't have permission to log time on this project."),
    ).toBeVisible();
    await expect(page.getByRole('status', { name: /Timer running/ })).toHaveCount(0);
  });
});

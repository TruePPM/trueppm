import { test, expect, type Page, type Route } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E for the My Work row-anchored quick-log time popover (#1234, ADR-0185 §4).
 *
 * Golden path: open the popover from a task row → pick a duration → Log → a
 * success toast offers Undo → Undo deletes the entry. Plus the keyboard path
 * (`L` opens, `↵` logs, `esc` cancels). All API calls are Playwright-mocked.
 */

const PROJECT_ID = 'e2e-te-00000000-0000-0000-0000-000000001234';
const TASK_ID = 'task-te-aaaa';
const ISO_TODAY = new Date().toISOString().slice(0, 10);

const TASK = {
  id: TASK_ID,
  short_id: 'PRJ-07',
  name: 'Wire the settings form',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  program_id: 'prog-te-cccc',
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

/** Empty weekly rollup — the shape `useTimeRollup`/`useWeekTimesheet` expect. */
const EMPTY_WEEK = {
  results: [],
  totals: { by_day: {}, by_cell: {}, today_minutes: 0, week_minutes: 0 },
  submission: { week_start: ISO_TODAY, submitted: false, submitted_at: null },
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
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
  );

  // Weekly rollup (GET) + delete (undo) share the /me/time-entries/ prefix — branch on method.
  await page.route('**/api/v1/me/time-entries/**', (route: Route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_WEEK),
    });
  });

  // Create a time entry.
  await page.route('**/api/v1/tasks/*/time-entries/', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'entry-e2e-1',
        task: TASK_ID,
        user: 1,
        minutes: 60,
        entry_date: ISO_TODAY,
        note: '',
        source: 'manual',
        server_version: 1,
        created_at: new Date().toISOString(),
      }),
    }),
  );
}

test.describe('My Work quick-log time (#1234, ADR-0185 §4)', () => {
  test('log 1h from a row → success + Undo → Undo deletes', async ({ page }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    let deleteCalled = false;
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/me/time-entries/')) deleteCalled = true;
    });

    await page.goto('/me/work');

    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Wire the settings form' })).toBeVisible();

    // Open the row's quick-log popover.
    await assigned.getByRole('button', { name: 'Log time on Wire the settings form' }).click();
    const dialog = page.getByRole('dialog', { name: /Log time · PRJ-07/ });
    await expect(dialog).toBeVisible();

    // Pick 1h and log.
    await dialog.getByRole('button', { name: '1h' }).click();
    await dialog.getByRole('button', { name: 'Log 1:00' }).click();

    // Success toast with Undo, and the popover closes.
    await expect(page.getByText('Logged 1:00 to PRJ-07')).toBeVisible();
    const undo = page.getByRole('button', { name: /Undo logging 1:00/ });
    await expect(undo).toBeVisible();
    await expect(dialog).toHaveCount(0);

    // Undo issues the DELETE.
    await undo.click();
    await expect.poll(() => deleteCalled).toBe(true);
  });

  test('keyboard: L opens, custom entry + Enter logs, Escape cancels', async ({ page }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    await page.goto('/me/work');

    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    const logButton = assigned.getByRole('button', { name: 'Log time on Wire the settings form' });
    await expect(logButton).toBeVisible();

    // Focus a control in the row, then press L to open.
    await logButton.focus();
    await page.keyboard.press('l');
    const dialog = page.getByRole('dialog', { name: /Log time · PRJ-07/ });
    await expect(dialog).toBeVisible();

    // Escape cancels.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Reopen, type a custom duration, and Enter logs.
    await logButton.focus();
    await page.keyboard.press('l');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Custom/).fill('1:30');
    await page.keyboard.press('Enter');

    await expect(page.getByText('Logged 1:30 to PRJ-07')).toBeVisible();
  });
});

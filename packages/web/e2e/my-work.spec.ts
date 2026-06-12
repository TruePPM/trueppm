import { test, expect, type Page } from '@playwright/test';

/**
 * E2E coverage for the My Work contributor surface (ADR-0065 Gap 2, issue #499).
 *
 * Verifies:
 *   - the page renders the task list grouped by active sprint
 *   - the status chip opens a picker and the selection POSTs to
 *     PATCH /api/v1/tasks/{id}/ with the X-Source: my_work header
 *   - the empty state renders distinct flavors for "no projects" vs
 *     "projects but no assignments"
 *
 * All API calls are intercepted with Playwright route mocking; no server
 * required.
 */

const PROJECT_ID = 'e2e-mywork-00000000-0000-0000-0000-000000000499';
const TASK_ID = 'task-mywork-aaaa';
const SPRINT_ID = 'sprint-mywork-bbbb';

const ACTIVE_SPRINT = {
  id: SPRINT_ID,
  name: 'Sprint 12',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  finish_date: '2026-06-01',
  days_remaining: 4,
  task_count: 1,
};

const TASK = {
  id: TASK_ID,
  short_id: 'PRJ-01a',
  name: 'Build the login form',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  sprint_id: SPRINT_ID,
  sprint_name: 'Sprint 12',
  status: 'IN_PROGRESS',
  story_points: 3,
  remaining_points: 2,
  due: '2026-05-30',
  due_source: 'planned',
  is_critical: true,
  // #484/#855: server-computed bucket + explicit human blocker flag.
  group: 'this_sprint',
  is_blocked: false,
  blocked_reason: '',
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

async function setupWithTasks(page: Page) {
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
        active_sprints: [ACTIVE_SPRINT],
        due_today_count: 1,
        server_version_high_water: 100,
      }),
    }),
  );
}

test.describe('My Work — contributor surface (#499, ADR-0065 Gap 2)', () => {
  test('renders task grouped by active sprint with critical indicator and due-source label', async ({
    page,
  }) => {
    await setupWithTasks(page);
    await page.goto('/me/work');

    // Page title.
    await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();

    // Section header for the server-computed bucket (#484): the task is in the
    // active sprint, so it renders under "This Sprint".
    const groupHeader = page.getByRole('heading', {
      name: /This Sprint, 1 task/i,
    });
    await expect(groupHeader).toBeVisible();

    // Task row content.
    await expect(page.getByRole('link', { name: 'Build the login form' })).toBeVisible();
    await expect(page.getByText('PRJ-01a')).toBeVisible();
    await expect(page.getByText('Due May 30 (planned)')).toBeVisible();

    // Critical-path indicator: icon present with the plain-English aria-label;
    // the literal words "critical path" do NOT appear in the visible row.
    await expect(page.getByLabel('On the critical path')).toBeVisible();
    const row = page.locator('li', { hasText: 'Build the login form' });
    // The full visible row text should not say "critical path".
    await expect(row).not.toContainText(/critical path/i);
  });

  test('status chip opens picker and selecting Complete PATCHes with X-Source: my_work', async ({
    page,
  }) => {
    await setupWithTasks(page);

    // Capture the PATCH request to verify the body + header.
    const patchRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/api/v1/tasks/${TASK_ID}/`) && req.method() === 'PATCH',
    );
    await page.route(`**/api/v1/tasks/${TASK_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TASK, status: 'COMPLETE' }),
      }),
    );

    await page.goto('/me/work');

    // Tap the status chip.
    const chip = page.getByRole('button', { name: /Status: In progress, change/i });
    await expect(chip).toBeVisible();
    await chip.click();

    // Picker opens.
    const picker = page.getByRole('dialog', { name: /Move .*Build the login form.* to/i });
    await expect(picker).toBeVisible();

    // Pick Complete.
    await picker.getByRole('option', { name: 'Complete' }).click();

    // PATCH fires with the X-Source header.
    const req = await patchRequest;
    expect(req.headers()['x-source']).toBe('my_work');
    expect(req.postDataJSON()).toEqual({ status: 'COMPLETE' });
  });

  test('Sidebar surfaces a "due today" badge when due_today_count > 0', async ({ page }) => {
    await setupWithTasks(page);
    await page.goto('/me/work');
    // The expanded Sidebar shows "My Work" with the count chip; both
    // accessible names are merged via aria-label when count is set.
    await expect(
      page.getByRole('link', { name: /My Work, 1 due today/i }),
    ).toBeVisible();
  });

  test('empty state — no projects — shows the Load demo data CTA and docs link', async ({
    page,
  }) => {
    await setupAuthenticatedPage(page);

    await page.route('**/api/v1/projects/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
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
          results: [],
          next: null,
          previous: null,
          active_sprints: [],
          due_today_count: 0,
          server_version_high_water: 0,
        }),
      }),
    );

    await page.goto('/me/work');

    await expect(page.getByRole('heading', { name: 'Nothing assigned to you yet' })).toBeVisible();
    await expect(page.getByText(/coming soon/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /Learn about the contributor view/i })).toBeVisible();
  });

  test('empty state — projects exist but no assignments — shows the unassigned flavor', async ({
    page,
  }) => {
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
          results: [],
          next: null,
          previous: null,
          active_sprints: [],
          due_today_count: 0,
          server_version_high_water: 0,
        }),
      }),
    );

    await page.goto('/me/work');

    await expect(
      page.getByRole('heading', { name: /not assigned to any active work right now/i }),
    ).toBeVisible();
    // No demo CTA in flavor B.
    await expect(page.getByRole('button', { name: /Load demo data/i })).toHaveCount(0);
  });

  test('a blocked task shows the Blocked badge with its reason (#476/#855)', async ({ page }) => {
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
          results: [
            { ...TASK, group: 'today', is_blocked: true, blocked_reason: 'Waiting on the API key' },
          ],
          next: null,
          previous: null,
          active_sprints: [ACTIVE_SPRINT],
          due_today_count: 1,
          server_version_high_water: 100,
        }),
      }),
    );

    await page.goto('/me/work');

    // Blocked badge + the reason render in the row; the task sits under "Today".
    await expect(page.getByRole('heading', { name: /Today, 1 task/i })).toBeVisible();
    await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
    await expect(page.getByText('Waiting on the API key')).toBeVisible();
  });
});

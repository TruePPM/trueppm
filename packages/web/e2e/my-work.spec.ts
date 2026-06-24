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
  // ADR-0124 #1135 structured blocker.
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
        // ADR-0129: default_landing + resolved landing so LandingContextHint
        // and LandingPrimaryUsePrompt have the correct shape and render correctly.
        // A concrete preference ('my_work') means neither the hint nor the prompt
        // show (prompt requires default_landing==='auto', hint requires role_policy
        // or fallback resolved_by), so the My Work tests are unaffected.
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

    // v2 home (#1228): the page <h1> is now the time-aware greeting, not the
    // literal "My Work". The greeting names the user from /auth/me/.
    await expect(
      page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Priya\./ }),
    ).toBeVisible();

    // Section header for the server-computed bucket (#484): the task is in the
    // active sprint, so it renders under "This Sprint".
    const groupHeader = page.getByRole('heading', {
      name: /This Sprint, 1 task/i,
    });
    await expect(groupHeader).toBeVisible();

    // Task row content. Scope to the "Assigned to me" list region (#1228): a
    // critical task now also surfaces in the right-column critical-path mini, so
    // an unscoped link/label would match in two places.
    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Build the login form' })).toBeVisible();
    await expect(assigned.getByText('PRJ-01a')).toBeVisible();
    await expect(assigned.getByText('Due May 30 (planned)')).toBeVisible();

    // Critical-path indicator: icon present with the plain-English aria-label;
    // the literal words "critical path" do NOT appear in the visible row.
    await expect(assigned.getByLabel('On the critical path')).toBeVisible();
    const row = assigned.locator('li', { hasText: 'Build the login form' });
    // The full visible row text should not say "critical path".
    await expect(row).not.toContainText(/critical path/i);
  });

  test('“N blocked” chip filters the list to flagged-blocked tasks (#1198)', async ({ page }) => {
    // 401-guard net first (last-registered-wins); specific mocks below override it.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await setupWithTasks(page);

    // Override /me/work/ with one blocked + one unblocked task.
    const BLOCKED_TASK = {
      ...TASK,
      id: '22222222-2222-2222-2222-222222222222',
      short_id: 'PRJ-09z',
      name: 'Wire the payments API',
      is_critical: false,
      is_blocked: true,
      blocked_reason: 'Waiting on the vendor sandbox',
      blocker_type: 'dependency',
      blocked_age_seconds: 7200,
    };
    await page.route('**/api/v1/me/work/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [TASK, BLOCKED_TASK],
          next: null,
          previous: null,
          active_sprints: [ACTIVE_SPRINT],
          due_today_count: 1,
          server_version_high_water: 100,
        }),
      }),
    );

    await page.goto('/me/work');

    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Build the login form' })).toBeVisible();
    await expect(assigned.getByRole('link', { name: 'Wire the payments API' })).toBeVisible();

    // Tap the chip → list narrows to the blocked task; the unblocked one is gone.
    await page.getByRole('button', { name: /Filter to 1 blocked task/i }).click();
    await expect(assigned.getByRole('link', { name: 'Wire the payments API' })).toBeVisible();
    await expect(assigned.getByRole('link', { name: 'Build the login form' })).toHaveCount(0);

    // Tap again → filter clears, both return.
    await page.getByRole('button', { name: /Showing only 1 blocked task/i }).click();
    await expect(assigned.getByRole('link', { name: 'Build the login form' })).toBeVisible();
  });

  test('no “blocked” chip when nothing is blocked (#1198)', async ({ page }) => {
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await setupWithTasks(page); // default fixture task is is_blocked: false
    await page.goto('/me/work');

    await expect(
      page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Priya\./ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /blocked task/i })).toHaveCount(0);
  });

  test('status chip opens picker and selecting Complete PATCHes with X-Source: my_work', async ({
    page,
  }) => {
    // 401-guard safety net (CLAUDE.md): registered FIRST so the specific mocks
    // below win (last-registered-wins). Without it an unmocked request can 401
    // during the click-retry window and the session-expired modal intercepts.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await setupWithTasks(page);

    // Capture the PATCH request to verify the body + header.
    const patchRequest = page.waitForRequest(
      (req) => req.url().includes(`/api/v1/tasks/${TASK_ID}/`) && req.method() === 'PATCH',
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

  test('completing a task via the checkbox fires the warm "done" toast (#1226)', async ({
    page,
  }) => {
    // 401-guard safety net (CLAUDE.md): registered FIRST so the specific mocks
    // below win (Playwright uses last-registered-wins). Without it, an unmocked
    // request can 401 during the click-retry window and the session-expired
    // modal intercepts the click.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await setupWithTasks(page);
    await page.route(`**/api/v1/tasks/${TASK_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...TASK, status: 'COMPLETE' }),
      }),
    );

    await page.goto('/me/work');

    // The one-tap complete checkbox (the contributor's signature action).
    const checkbox = page.getByRole('button', { name: 'Mark Build the login form complete' });
    await expect(checkbox).toBeVisible();
    await checkbox.click();

    // The global toast celebrates the confirmed completion (warm copy).
    await expect(page.getByText('Nice — Build the login form done.')).toBeVisible();
  });

  test('Sidebar surfaces a "due today" badge when due_today_count > 0', async ({ page }) => {
    await setupWithTasks(page);
    await page.goto('/me/work');
    // The expanded Sidebar shows "My Work" with the count chip; both
    // accessible names are merged via aria-label when count is set.
    await expect(page.getByRole('link', { name: /My Work, 1 due today/i })).toBeVisible();
  });

  test('empty state — no projects — shows the Explore a demo project CTA and docs link', async ({
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

    // v2 warm empty state (ADR-0129): welcoming copy + the demo CTA + docs link.
    await expect(page.getByRole('heading', { name: /get you started/i })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explore a demo project' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Learn more/i })).toBeVisible();
  });

  test('empty state — loading the demo lands the contributor on a board (#1054)', async ({
    page,
  }) => {
    // 401-guard net first (last-registered-wins) so the board destination's
    // unmocked reads don't 401 into the session-expired modal.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
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

    // The contributor flow assigns the caller the first open sprint and routes
    // them to that project's Board (not the PM-facing Program Overview).
    const LANDING_PROJECT_ID = 'e2e-landing-00000000-0000-0000-0000-000000001054';
    await page.route('**/api/v1/programs/load-sample/', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          program: { id: 'e2e-prog-1054', name: 'Atlas Platform Launch' },
          landing_project_id: LANDING_PROJECT_ID,
          sample_key: 'atlas-platform-launch',
        }),
      }),
    );

    await page.goto('/me/work');
    await page.getByRole('button', { name: 'Explore a demo project' }).click();

    // Lands on the board holding the freshly-assigned open sprint — the URL is
    // set by the SPA navigation regardless of how the board page then renders.
    await expect(page).toHaveURL(new RegExp(`/projects/${LANDING_PROJECT_ID}/board`));
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

    // v2 flavor B (has projects, no assignments): refreshed copy, NO demo CTA.
    await expect(page.getByRole('heading', { name: /all caught up/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Explore a demo project/i })).toHaveCount(0);
  });

  test('v2 home renders the greeting, focus cards, date chip, and two-column layout (#1228)', async ({
    page,
  }) => {
    // 401-guard safety net (CLAUDE.md): registered FIRST so the specific mocks
    // below win (last-registered-wins). The focus cards + side column read only
    // the /me/work/ payload, so no extra object endpoints to mock.
    await page.route('**/api/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await setupWithTasks(page);
    await page.goto('/me/work');

    // Greeting <h1> + sub line (the critical task drives "on the critical path").
    await expect(
      page.getByRole('heading', { level: 1, name: /Good (morning|afternoon|evening), Priya\./ }),
    ).toBeVisible();
    await expect(page.getByText(/1 task needs you today/)).toBeVisible();
    await expect(page.getByText(/1 on the critical path/)).toBeVisible();

    // The mono date chip is present (today, localized).
    await expect(page.getByLabel(/^Today is /)).toBeVisible();

    // Focus row — "Needs attention" lead card + the sprint method card + the
    // load card. Labels are uppercased via CSS; assert on accessible text.
    // "Needs attention" / "Your load" each appear once (the card labels);
    // "Sprint 12" appears in several places so assert at least one is visible.
    await expect(page.getByText('Needs attention')).toBeVisible();
    await expect(page.getByText('Your load')).toBeVisible();
    await expect(page.getByText('Sprint 12').first()).toBeVisible();

    // Right column method-adaptive stack: an Active sprints panel and an
    // On-the-critical-path panel (the critical task is surfaced there too).
    await expect(page.getByRole('heading', { name: 'Active sprints' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'On the critical path' })).toBeVisible();

    // The assigned-task list is preserved alongside the new chrome. Scope to
    // the list region — the critical task also surfaces in the side-column mini.
    await expect(
      page.getByRole('region', { name: 'Assigned to me' }).getByRole('link', {
        name: 'Build the login form',
      }),
    ).toBeVisible();
  });

  test('a blocked task shows the Blocked badge, type chip, age, and reason (#476/#855/#1135)', async ({
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
          results: [
            {
              ...TASK,
              group: 'today',
              is_blocked: true,
              blocked_reason: 'Waiting on the API key',
              blocker_type: 'vendor',
              blocked_age_seconds: 93600, // 1d 2h
            },
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

    // Blocked badge + type chip + age + reason render in the row; under "Today".
    await expect(page.getByRole('heading', { name: /Today, 1 task/i })).toBeVisible();
    await expect(page.getByText('Blocked', { exact: true })).toBeVisible();
    await expect(page.getByText('External vendor')).toBeVisible();
    await expect(page.getByText('1d 2h blocked')).toBeVisible();
    await expect(page.getByText('Waiting on the API key')).toBeVisible();
  });
});

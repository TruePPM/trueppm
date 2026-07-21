import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * E2E for the global quick-log time popover (#1416, ADR-0185 §C, Pattern C).
 *
 * Golden path: open "Log time" from the top bar → the popover shows the user's
 * assigned tasks → pick a duration preset → Log → a TimeEntry is POSTed and a
 * success toast offers Undo. Plus the Viewer/permission path (403 → friendly
 * toast, popover already closed).
 *
 * All API calls are Playwright-mocked; no server required.
 */

const PROJECT_ID = 'e2e-qlog-00000000-0000-0000-0000-000000001416';
const TASK_ID = 'task-qlog-aaaa';

const TASK = {
  id: TASK_ID,
  short_id: 'PRJ-07',
  name: 'Write the release notes',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  program_id: null,
  program_name: null,
  program_color: null,
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: 2,
  remaining_points: 2,
  due: '2026-07-10',
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
  // No timer running — the TimerChip stays hidden; the quick-log is the entry point.
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false }),
    }),
  );
}

// A membership-scoped project-search fallback so ad-hoc work on an *unassigned* task is
// loggable — no assigned tasks, but /me/search/?type=task finds one (#2174).
const SEARCH_TASK_ID = 'task-search-bbbb';
async function setupNoAssignedWithSearch(page: Page): Promise<void> {
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
  // No assigned work — the assigned-only picker would otherwise be a dead end.
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
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
  );
  // The project-wide task search fallback.
  await page.route('**/api/v1/me/search/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: SEARCH_TASK_ID,
            kind: 'task',
            type: 'task',
            title: 'Help pour the footing',
            program_id: null,
            program_name: null,
            project_id: PROJECT_ID,
            project_name: 'Design App',
            parent_epic_id: null,
            parent_epic_name: null,
          },
        ],
      }),
    }),
  );
}

test.describe('Global quick-log time popover (#1416, ADR-0185 §C)', () => {
  test('empty state is a CTA, and a project search logs ad-hoc unassigned work (#2174)', async ({
    page,
  }) => {
    await setupCatchAll(page);
    await setupNoAssignedWithSearch(page);

    let posted: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/tasks/${SEARCH_TASK_ID}/time-entries/`, async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'entry-search-1',
          task: SEARCH_TASK_ID,
          minutes: 60,
          entry_date: '2026-07-06',
          note: '',
          source: 'manual',
          server_version: 1,
          created_at: new Date().toISOString(),
        }),
      });
    });

    await page.goto('/me/work');
    await page.getByRole('button', { name: 'Log time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await expect(dialog).toBeVisible();

    // With no assigned tasks the picker names the path forward — not a dead end.
    await expect(
      dialog.getByText(/search above to log against any task in your projects/i),
    ).toBeVisible();

    // Type a query → the membership-scoped search surfaces the unassigned task.
    await dialog.getByRole('textbox', { name: 'Search your tasks or projects' }).fill('pour');
    const hit = dialog.getByRole('radio', { name: /Help pour the footing/ });
    await expect(hit).toBeVisible();
    await expect(hit).toBeChecked();

    // Log it — the entry POSTs against the searched task.
    await dialog.getByRole('button', { name: /^Log / }).click();
    await expect(page.getByText('Logged 1h 00m on Help pour the footing')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(posted).toEqual({
      minutes: 60,
      entry_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });


  test('open from top bar → pick a task + preset → Log → success toast with Undo', async ({
    page,
  }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    let posted: Record<string, unknown> | null = null;
    await page.route(`**/api/v1/tasks/${TASK_ID}/time-entries/`, async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'entry-qlog-1',
          task: TASK_ID,
          minutes: 30,
          entry_date: '2026-07-06',
          note: '',
          source: 'manual',
          server_version: 1,
          created_at: new Date().toISOString(),
        }),
      });
    });

    await page.goto('/me/work');

    // Open the global "Log time" popover from the top bar.
    await page.getByRole('button', { name: 'Log time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await expect(dialog).toBeVisible();

    // The assigned task is present and selected by default.
    await expect(
      dialog.getByRole('radio', { name: /PRJ-07 Write the release notes/ }),
    ).toBeChecked();

    // Pick 30m and log.
    await dialog.getByRole('button', { name: '30m' }).click();
    await dialog.getByRole('button', { name: 'Log 30m' }).click();

    // Success toast with Undo; popover closes.
    await expect(page.getByText('Logged 30m on PRJ-07 · Write the release notes')).toBeVisible();
    await expect(page.getByRole('button', { name: /Undo/ })).toBeVisible();
    await expect(dialog).toHaveCount(0);

    expect(posted).toEqual({
      minutes: 30,
      entry_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  test('mobile: the same flow opens in a bottom sheet (#1770)', async ({ page }) => {
    // Below md the desktop popover would overflow the viewport, so the identical
    // form must open in the shared BottomSheet — the phone-first 15-second path.
    await page.setViewportSize({ width: 390, height: 844 });
    await setupCatchAll(page);
    await setupWithTask(page);

    await page.route(`**/api/v1/tasks/${TASK_ID}/time-entries/`, (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'entry-qlog-m1',
          task: TASK_ID,
          minutes: 30,
          entry_date: '2026-07-06',
          note: '',
          source: 'manual',
          server_version: 1,
          created_at: new Date().toISOString(),
        }),
      }),
    );

    await page.goto('/me/work');

    await page.getByRole('button', { name: 'Log time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await expect(dialog).toBeVisible();
    // The scrim is the tell that the mobile surface is the shared BottomSheet.
    await expect(page.getByTestId('bottom-sheet-scrim')).toBeVisible();

    // #1800: the sheet form must not overflow horizontally — the trailing
    // custom-duration input and the primary "Log" button were clipped off the
    // right edge. Assert no horizontal scroll on the sheet and that the primary
    // action sits fully within the viewport (its right edge ≤ 390px).
    const overflow = await dialog.evaluate(
      (el) => (el as HTMLElement).scrollWidth - (el as HTMLElement).clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    const logBtn = dialog.getByRole('button', { name: /^Log / });
    const box = await logBtn.boundingBox();
    expect(box).not.toBeNull();
    expect((box!.x + box!.width)).toBeLessThanOrEqual(390 + 1);

    await dialog.getByRole('button', { name: '30m' }).click();
    await dialog.getByRole('button', { name: 'Log 30m' }).click();

    await expect(page.getByText('Logged 30m on PRJ-07 · Write the release notes')).toBeVisible();
    await expect(dialog).toHaveCount(0);
  });

  test('a Viewer (403) sees a friendly permission message', async ({ page }) => {
    await setupCatchAll(page);
    await setupWithTask(page);

    await page.route(`**/api/v1/tasks/${TASK_ID}/time-entries/`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'You do not have permission to perform this action.' }),
      }),
    );

    await page.goto('/me/work');

    await page.getByRole('button', { name: 'Log time' }).click();
    const dialog = page.getByRole('dialog', { name: 'Log time' });
    await dialog.getByRole('button', { name: /^Log/ }).click();

    await expect(
      page.getByText("You don't have permission to log time on this project."),
    ).toBeVisible();
  });
});

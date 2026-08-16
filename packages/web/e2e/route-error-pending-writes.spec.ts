/**
 * Route crash isolation + the queued-write confirmation (#2834).
 *
 * The data-loss chain this covers: a shell-hosted route throws → without a
 * shell-preserving `errorElement` the whole `AppShell` unmounts, taking
 * `PendingWritesGuard`'s `beforeunload` protection with it → the error screen's
 * "Reload" button then discards the in-memory write queue with no warning.
 *
 * The error is forced the way it actually happens in production: an offline
 * client navigating to a route whose lazy chunk has never been fetched. Going
 * offline serves double duty — TanStack Query pauses the write so it stays
 * queued (route mocks intercept before the network, so the app's *reads* keep
 * working exactly as in a real dead zone), and the chunk request, which is not
 * intercepted, genuinely fails.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-crash-00000000-0000-0000-0000-000000002834';
const TASK_ID = 'task-crash-2834';

const SPRINT_ID = 'sprint-crash-2834';

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
  name: 'Log Tuesday hours',
  project_id: PROJECT_ID,
  project_name: 'Design App',
  sprint_id: SPRINT_ID,
  sprint_name: 'Sprint 12',
  status: 'IN_PROGRESS',
  story_points: 3,
  remaining_points: 2,
  due: '2026-05-30',
  due_source: 'planned',
  is_critical: false,
  // Server-computed bucket (#484): puts the row in the rendered "This Sprint"
  // group rather than a collapsed later-work section.
  group: 'this_sprint',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 100,
  url: `/projects/${PROJECT_ID}/schedule?task=${TASK_ID}`,
};

async function setup(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);

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
            id: PROJECT_ID,
            name: 'Design App',
            description: '',
            start_date: '2026-04-01',
            calendar: 'default',
            estimation_mode: 'open',
            agile_features: true,
            methodology: 'HYBRID',
          },
        ],
      }),
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
        due_today_count: 0,
        server_version_high_water: 100,
      }),
    }),
  );
  await page.route(`**/api/v1/tasks/${TASK_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...TASK, status: 'COMPLETE' }),
    }),
  );
}

test.describe('Route error with queued offline writes (#2834)', () => {
  test('a crashed route keeps the shell, and Reload confirms before discarding writes', async ({
    page,
    context,
  }) => {
    await setup(page);
    await page.goto('/me/work');

    // Page-rendered signal: the row only exists once /me/work/ has resolved.
    const assigned = page.getByRole('region', { name: 'Assigned to me' });
    await expect(assigned.getByRole('link', { name: 'Log Tuesday hours' })).toBeVisible();

    // Go offline and queue a write. TanStack Query pauses it, so it lives only in
    // this tab's memory — exactly the work a reload would throw away.
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Mark Log Tuesday hours complete' }).click();
    await expect(
      page.getByRole('button', { name: /Offline\. 1 change pending/i }),
    ).toBeVisible();

    // Client-side navigation (never page.goto — a document load would wipe the
    // queue) to a route whose chunk has not been fetched. Offline, that dynamic
    // import fails and the route throws.
    await page.getByRole('link', { name: 'Timesheet' }).click();

    // The branded boundary replaces the route body…
    const errorSurface = page.getByRole('alert');
    await expect(errorSurface).toBeVisible();
    await expect(page.getByRole('heading', { name: "Couldn't finish loading" })).toBeVisible();

    // …and the shell survives: the sidebar is still there to navigate away with,
    // which is what keeps PendingWritesGuard mounted (#2834).
    const sidebar = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'My Work', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Offline\. 1 change pending/i }),
    ).toBeVisible();

    // Marker that only survives if the document is never reloaded.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__notReloaded = true;
    });

    // Reload must not fire straight away — it would discard the queued write.
    await page.getByRole('button', { name: 'Reload', exact: true }).click();

    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('1 unsynced change would be lost')).toBeVisible();
    await expect(confirm.getByText(/only stored in this tab/i)).toBeVisible();

    // The safe action is the focused default, and backing out changes nothing.
    await expect(confirm.getByRole('button', { name: 'Stay on this page' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Stay on this page' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(errorSurface).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__notReloaded),
    ).toBe(true);
  });

  test('with nothing queued, Reload is not interrupted by a confirmation', async ({
    page,
    context,
  }) => {
    await setup(page);
    await page.goto('/me/work');
    await expect(
      page.getByRole('region', { name: 'Assigned to me' }).getByRole('link', {
        name: 'Log Tuesday hours',
      }),
    ).toBeVisible();

    // Same forced chunk failure, but no write was ever made.
    await context.setOffline(true);
    await page.getByRole('link', { name: 'Timesheet' }).click();
    await expect(page.getByRole('heading', { name: "Couldn't finish loading" })).toBeVisible();

    await page.getByRole('button', { name: 'Reload', exact: true }).click();
    // No prompt: there is nothing to lose, so the recovery path stays one click.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
});

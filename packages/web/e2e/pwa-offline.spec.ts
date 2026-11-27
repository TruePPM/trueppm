/**
 * Offline shell (ADR-1523 §4–5, #1427/#1428).
 *
 * Golden path: My Work loads online (and is saved on the device), the app is then
 * cold-launched with no network, the precached shell boots, and My Work renders
 * the saved copy under the offline banner instead of a sign-in modal or an empty
 * list. Fallback: an uncached route on that cold launch shows "This view isn't
 * cached", whose "Back to My Work" returns to the saved copy.
 *
 * "Offline" is `context.setOffline(true)` (so the worker must serve the shell), an
 * aborting `/api/` route registered last (a fulfilled mock would otherwise still
 * answer), and `navigator.onLine` pinned false for the following loads.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

const PROJECT_ID = 'proj-pwa-aaaa';
const TASK = {
  id: 'task-pwa-bbbb',
  short_id: 'PRJ-01b',
  name: 'Pour the east footing',
  project_id: PROJECT_ID,
  project_name: 'Harbor Clinic',
  program_id: null,
  program_name: null,
  program_color: null,
  sprint_id: null,
  sprint_name: null,
  status: 'IN_PROGRESS',
  story_points: null,
  remaining_points: null,
  due: '2026-11-30',
  due_source: 'planned',
  is_critical: false,
  group: 'today',
  is_blocked: false,
  blocked_reason: '',
  blocker_type: '',
  blocked_age_seconds: null,
  server_version: 4,
  url: `/projects/${PROJECT_ID}/schedule?task=task-pwa-bbbb`,
};

async function json(page: Page, glob: string, body: unknown): Promise<void> {
  await page.route(glob, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }),
  );
}

async function setupSignedInMyWork(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('e2e-offline') === '1') {
      Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({ state: { accessToken: 'e2e-token', isAuthenticated: true }, version: 0 }),
    );
  });
  await setupCatchAll(page);
  await json(page, '**/api/v1/auth/me/', {
    id: 'e2e-user',
    username: 'dana',
    display_name: 'Dana',
    initials: 'D',
    email: 'dana@example.com',
    max_project_role: 100,
    workspace_role: null,
    can_access_admin_settings: false,
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
  });
  await json(page, '**/api/v1/edition/', { edition: 'community' });
  await json(page, '**/api/v1/projects/', { count: 0, next: null, previous: null, results: [] });
  await json(page, '**/api/v1/me/active-sprints/', []);
  await json(page, '**/api/v1/me/work/**', {
    results: [TASK],
    next: null,
    previous: null,
    active_sprints: [],
    due_today_count: 1,
  });
}

/** Count of saved My Work copies, without creating the database if it is absent. */
async function savedCopies(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'trueppm-pwa')) return 0;
    return new Promise<number>((resolve) => {
      const req = indexedDB.open('trueppm-pwa');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('myWorkSnapshot')) return resolve(0);
        const count = db.transaction('myWorkSnapshot').objectStore('myWorkSnapshot').count();
        count.onsuccess = () => resolve(count.result);
      };
      req.onerror = () => resolve(0);
    });
  });
}

async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await page.route('**/api/v1/**', (route) => route.abort('internetdisconnected'));
  // With a worker controlling the page, Chromium under Playwright still reports
  // `navigator.onLine === true` after setOffline, so pin it for the next loads.
  await page.evaluate(() => sessionStorage.setItem('e2e-offline', '1'));
}

test.describe('PWA offline shell (ADR-1523)', () => {
  test('a cold offline launch shows the saved My Work, and uncached views say so', async ({
    page,
  }) => {
    await setupSignedInMyWork(page);
    await page.goto('/me/work');
    await expect(page.getByText(TASK.name).first()).toBeVisible();
    await expect.poll(() => savedCopies(page)).toBe(1);

    // Let the worker take control so the offline reload is served from the precache.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
      .toBe(true);

    await goOffline(page);
    await page.reload();

    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /offline/i })
        .first(),
    ).toBeVisible();
    await expect(page.getByTestId('my-work-offline-copy')).toContainText('saved on this device');
    await expect(page.getByText(TASK.name).first()).toBeVisible();
    // No sign-in modal over the offline shell.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Fallback: an uncached view on a cold offline launch.
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('heading', { name: 'This view isn’t cached' })).toBeVisible();
    await page.getByRole('link', { name: 'Back to My Work' }).click();
    await expect(page.getByTestId('my-work-offline-copy')).toBeVisible();
    await expect(page.getByText(TASK.name).first()).toBeVisible();

    await page.context().setOffline(false);
  });
});

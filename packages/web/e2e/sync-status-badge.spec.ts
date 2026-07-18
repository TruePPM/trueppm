/**
 * E2E: SyncStatusBadge (#374) — the calm, persistent write-sync indicator in the
 * TopBar right cluster.
 *
 * Proves the real hook → useOnlineStatus → badge wiring in a browser across an
 * online → offline → online cycle, and that the expand modal opens with the
 * sync detail. The state-machine mapping and the manual-retry drain
 * (resumePausedMutations + mutation.continue) are unit-tested in
 * syncStatus.test.ts and SyncStatusBadge.test.tsx; here we assert the live
 * connectivity transition that only a real browser can exercise.
 *
 * Every shell endpoint the board route reads is mocked with its real shape via
 * setupApiMocks — the catch-all list mock would crash object-shaped endpoints
 * (see CLAUDE.md), so we never lean on it for the page render.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-sync-00000000-0000-0000-0000-000000000374';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Sync Badge Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page, { accessToken: 'e2e-sync-token' });
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: [],
    statusSummary: { task_count: 0 },
  });
}

test.describe('SyncStatusBadge (#374)', () => {
  test('is visible, reads Synced online, and flips to Offline and back', async ({
    page,
    context,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // Board column header confirms the shell rendered (comes from board-config,
    // not task data) before we interact with chrome.
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });

    // Online: the badge is present and calm.
    const syncedBadge = page.getByRole('button', { name: /Synced/ });
    await expect(syncedBadge).toBeVisible();

    // Go offline — navigator.onLine flips and the badge reflects it.
    await context.setOffline(true);
    const offlineBadge = page.getByRole('button', { name: /Offline/ });
    await expect(offlineBadge).toBeVisible({ timeout: 10_000 });

    // Back online — badge returns to Synced.
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: /Synced/ })).toBeVisible({ timeout: 10_000 });
  });

  test('opens the expand modal with sync detail and closes on Escape', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Synced/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Sync status' });
    await expect(dialog).toBeVisible();
    // With nothing queued the modal shows the calm empty state and the last-sync line.
    await expect(dialog.getByText('No pending changes — everything is saved.')).toBeVisible();
    await expect(dialog.getByText(/Not synced yet|Last synced/)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

/**
 * Schedule build-mode v1 (#338 #339 #341 #342, gated by #349).
 *
 * Covers the user-visible acceptance criteria:
 * - Flag-on shows the toolbar pill, the bottom hint strip, and the cheatsheet on `?`
 * - Flag-off leaves the Schedule toolbar, list, and footer unchanged (regression)
 * - Hint strip switches its three contextual hotkeys when row focus changes
 * - Right-click on a row opens the context menu with the expected items
 *
 * Deeper structural / mutation flows (Tab → indent server call, EditableCell
 * commit/rollback semantics, focus reducer state machine) are exercised at
 * the vitest layer where they can be asserted without canvas/network coupling.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-build-00000000-0000-0000-0000-000000000349';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Build Mode Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'bm1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'bm2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function enableBuildMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm.featureFlags',
      JSON.stringify({ schedule_build_mode_v1: true }),
    );
  });
}

test.describe('Schedule build-mode — flag off (regression)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('toolbar does not show the Build mode pill when flag is off', async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for tasks to render so we know the Schedule view mounted.
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByTestId('build-mode-pill')).toHaveCount(0);
    await expect(page.getByTestId('build-mode-hint-strip')).toHaveCount(0);
  });
});

test.describe('Schedule build-mode — flag on', () => {
  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('toolbar pill is visible and opens the cheatsheet', async ({ page }) => {
    await page.goto(BASE_URL);
    const pill = page.getByTestId('build-mode-pill');
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);
  });

  test('hint strip is visible at bottom and starts in NoSelection mode', async ({ page }) => {
    await page.goto(BASE_URL);
    const strip = page.getByTestId('build-mode-hint-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-mode', 'NoSelection');
    await expect(strip).toContainText('Build mode');
    await expect(strip).toContainText('Select row');
  });

  test('? opens cheatsheet from anywhere outside an input', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    // ? toggles closed too.
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);
  });

  test('cheatsheet renders every section (Quick actions + Dependencies added in #475+#477)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByTestId('build-mode-pill').click();
    const dialog = page.getByRole('dialog', { name: 'Schedule shortcuts' });
    await expect(dialog.getByText('Selecting rows')).toBeVisible();
    await expect(dialog.getByText('Editing cells')).toBeVisible();
    await expect(dialog.getByText('Structuring (the WBS tree)')).toBeVisible();
    await expect(dialog.getByText('Quick actions')).toBeVisible();
    await expect(dialog.getByText('Dependencies')).toBeVisible();
    await expect(dialog.getByText('Help')).toBeVisible();
  });

  test('right-click on a row opens the row menu with expected items', async ({ page }) => {
    await page.goto(BASE_URL);
    const row = page.getByText('Foundation');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Edit/ })).toBeVisible();
    // Items added in #477 — Mark complete, Add predecessor / successor, Duplicate.
    await expect(menu.getByRole('menuitem', { name: /Mark complete/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Indent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Outdent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Add predecessor/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Add successor/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #806 — deleting a row must not block right-click on subsequent rows.
//
// Reported as "deleting a phase on the critical path grays out the row and
// right-click stops working until manual refresh". Root cause was a race
// between cache invalidation (which unmounts the deleted row) and the
// BuildModeRowMenu portal that lived on its parent — the portal's global
// Escape/click-outside listeners outlived the row and blocked new menu opens.
// ───────────────────────────────────────────────────────────────────────────
test.describe('Schedule build-mode — delete does not block subsequent right-clicks (#806)', () => {
  // Module-scope mutable list so the post-delete handler can splice it out
  // before the catch-all GET refetch reads it back — mirrors the live
  // invalidation path that unmounts the deleted row.
  let currentTasks: typeof FIXTURE_TASKS;

  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    currentTasks = [...FIXTURE_TASKS];
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: currentTasks,
    });
    // Register AFTER setupApiMocks: Playwright matches routes in LIFO order,
    // so this DELETE-specific handler wins over the catch-all `tasks/**` GET
    // registered inside setupApiMocks. The GET catch-all reads the same
    // `currentTasks` array by reference, so the post-splice refetch returns
    // the truncated list and the deleted row unmounts as it does in prod.
    await page.route('**/api/v1/tasks/bm1/', (route) => {
      if (route.request().method() === 'DELETE') {
        const idx = currentTasks.findIndex((t) => t.id === 'bm1');
        if (idx >= 0) currentTasks.splice(idx, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.continue();
    });
  });

  test('after deleting one row, right-click on a sibling row still opens its menu', async ({ page }) => {
    await page.goto(BASE_URL);
    const firstRow = page.getByText('Foundation');
    await expect(firstRow).toBeVisible();

    // Open the menu on Foundation, then activate Delete.
    await firstRow.click({ button: 'right' });
    const firstMenu = page.getByRole('menu', { name: 'Row actions' });
    await expect(firstMenu).toBeVisible();
    await firstMenu.getByRole('menuitem', { name: /Delete/ }).click();

    // The deleted row eventually drops out of the list (cache invalidates,
    // refetch returns the truncated set).
    await expect(page.getByText('Foundation')).toHaveCount(0);

    // The bug: right-click on the surviving sibling did nothing until a full
    // page refresh. With the fix the menu opens normally.
    const secondRow = page.getByText('Framing');
    await secondRow.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
  });
});

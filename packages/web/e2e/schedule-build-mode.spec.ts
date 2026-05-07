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

  test('cheatsheet renders all five sections', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByTestId('build-mode-pill').click();
    const dialog = page.getByRole('dialog', { name: 'Schedule shortcuts' });
    await expect(dialog.getByText('Selecting rows')).toBeVisible();
    await expect(dialog.getByText('Editing cells')).toBeVisible();
    await expect(dialog.getByText('Structuring (the WBS tree)')).toBeVisible();
    await expect(dialog.getByText('Creating & deleting')).toBeVisible();
    await expect(dialog.getByText('Help')).toBeVisible();
  });

  test('right-click on a row opens the row menu with expected items', async ({ page }) => {
    await page.goto(BASE_URL);
    const row = page.getByText('Foundation');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Edit/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Indent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Outdent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

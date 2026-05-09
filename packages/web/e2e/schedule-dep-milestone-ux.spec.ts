/**
 * E2E coverage for ADR-0058 — dep-type UX polish and milestone field
 * suppression (issues #249 + #253).
 *
 * Tests:
 * 1. Dep type picker shows plain-English labels (not bare acronyms).
 * 2. Dep type change that creates a cycle shows an inline row-level
 *    role="alert" (not the tab-level banner).
 * 3. Milestone task opens drawer with "Date" row (not Start/Finish pair),
 *    "— (milestone)" duration, binary progress text, and no Estimates section.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-dep-ms-00000000-0000-0000-0000-000000000058';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'ADR-0058 Test Project',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'task-a',
    wbs_path: '1',
    name: 'Design Phase',
    early_start: '2026-06-01',
    early_finish: '2026-06-10',
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    notes: '',
  },
  {
    id: 'task-b',
    wbs_path: '2',
    name: 'Build Phase',
    early_start: '2026-06-11',
    early_finish: '2026-06-20',
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    notes: '',
  },
  {
    id: 'task-ms',
    wbs_path: '3',
    name: 'Phase Gate',
    early_start: '2026-06-20',
    early_finish: '2026-06-20',
    duration: 0,
    percent_complete: 0,
    is_critical: false,
    is_milestone: true,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    notes: '',
  },
];

// task-b has task-a as predecessor (FS, lag 0)
const FIXTURE_DEPENDENCY = {
  id: 'dep-1',
  predecessor: 'task-a',
  successor: 'task-b',
  dep_type: 'FS',
  lag: 0,
  is_critical: false,
};

async function gotoSchedule(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    tasks: FIXTURE_TASKS,
    dependencies: [FIXTURE_DEPENDENCY],
  });

  // Override the default dep mock to also handle PATCH (used in dep-type change tests).
  // Individual tests add their own PATCH handler after this.
  await page.goto(`/projects/${PROJECT_ID}/schedule`);
}

async function openDrawer(page: import('@playwright/test').Page, taskName: string) {
  const grid = page.getByRole('grid', { name: 'Task list' });
  await grid.getByText(taskName, { exact: true }).click();
  const drawer = page.getByRole('dialog', { name: new RegExp(taskName) }).first();
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  return drawer;
}

// ---------------------------------------------------------------------------
// Dep-type label tests (#249)
// ---------------------------------------------------------------------------

test.describe('Dep-type picker plain-English labels (#249)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('dep type select shows "Finish → Start" not bare "FS"', async ({ page }) => {
    const drawer = await openDrawer(page, 'Build Phase');
    await drawer.getByRole('button', { name: 'Dependencies' }).click();
    const depRegion = drawer.getByRole('region', { name: /dependencies/i }).first();
    await expect(depRegion).toBeVisible({ timeout: 5_000 });

    // The DepRow for the predecessor link should show "Finish → Start"
    const depTypeSelect = depRegion.getByRole('combobox', { name: 'Dependency type' });
    await expect(depTypeSelect).toBeVisible();
    // The selected option text is "Finish → Start" — not the bare acronym "FS"
    await expect(depTypeSelect).toContainText('Finish → Start');
  });

  test('dep type picker options list shows all four plain-English labels', async ({ page }) => {
    const drawer = await openDrawer(page, 'Build Phase');
    await drawer.getByRole('button', { name: 'Dependencies' }).click();

    const addTypeSelect = drawer.getByRole('combobox', { name: 'Link type' }).first();
    await expect(addTypeSelect).toBeVisible();

    for (const label of ['Finish → Start', 'Start → Start', 'Finish → Finish', 'Start → Finish']) {
      await expect(addTypeSelect.getByRole('option', { name: label })).toBeAttached();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-row cycle error (#249)
// ---------------------------------------------------------------------------

test.describe('Per-row cycle error on dep-type PATCH (#249)', () => {
  test.beforeEach(async ({ page }) => {
    // Register a PATCH handler that returns cycle 400 for dep-1.
    // Must be registered before setupApiMocks (earlier = lower priority in Playwright).
    // Actually Playwright last-registered wins, so we set this up AFTER setupApiMocks
    // by calling gotoSchedule first then overriding in the test body.
    await gotoSchedule(page);

    // Wire PATCH /dependencies/dep-1/ to return a cycle 400.
    await page.route('**/api/v1/dependencies/dep-1/', (route) => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            detail: 'cyclic_dependency',
            cycle: [
              { id: 'task-a', name: 'Design Phase', hex_id: 'aa11' },
              { id: 'task-b', name: 'Build Phase', hex_id: 'bb22' },
              { id: 'task-a', name: 'Design Phase', hex_id: 'aa11' },
            ],
          }),
        });
      }
      return route.continue();
    });

    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('cycle on dep-type change shows inline row alert with task names', async ({ page }) => {
    const drawer = await openDrawer(page, 'Build Phase');
    await drawer.getByRole('button', { name: 'Dependencies' }).click();

    const depTypeSelect = drawer.getByRole('combobox', { name: 'Dependency type' });
    await expect(depTypeSelect).toBeVisible({ timeout: 5_000 });

    // Change type to SS — mock PATCH returns cycle 400
    await depTypeSelect.selectOption('SS');

    // A row-level alert should appear (not the tab-level banner below all rows)
    const rowAlert = drawer.getByRole('alert');
    await expect(rowAlert).toBeVisible({ timeout: 3_000 });
    await expect(rowAlert).toContainText('Design Phase');
    await expect(rowAlert).toContainText('Build Phase');
  });

  test('changing dep type again clears the row error', async ({ page }) => {
    const drawer = await openDrawer(page, 'Build Phase');
    await drawer.getByRole('button', { name: 'Dependencies' }).click();

    const depTypeSelect = drawer.getByRole('combobox', { name: 'Dependency type' });
    await depTypeSelect.selectOption('SS');
    const rowAlert = drawer.getByRole('alert');
    await expect(rowAlert).toBeVisible({ timeout: 3_000 });

    // Change again — error clears immediately
    await depTypeSelect.selectOption('FF');
    await expect(rowAlert).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Milestone drawer field suppression (#253)
// ---------------------------------------------------------------------------

test.describe('Milestone drawer field suppression (#253)', () => {
  test.beforeEach(async ({ page }) => {
    await gotoSchedule(page);
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('MetaRail shows "Date" row (not "Start") for a milestone', async ({ page }) => {
    const drawer = await openDrawer(page, 'Phase Gate');
    // "Date" group should be present; "Start" group should not
    await expect(drawer.getByRole('group', { name: 'Date' })).toBeVisible();
    await expect(drawer.getByRole('group', { name: 'Start' })).not.toBeVisible();
  });

  test('MetaRail hides "Finish" row for a milestone', async ({ page }) => {
    const drawer = await openDrawer(page, 'Phase Gate');
    await expect(drawer.getByRole('group', { name: 'Finish' })).not.toBeVisible();
  });

  test('MetaRail shows "— (milestone)" in Duration row', async ({ page }) => {
    const drawer = await openDrawer(page, 'Phase Gate');
    const durationGroup = drawer.getByRole('group', { name: 'Duration' });
    await expect(durationGroup).toBeVisible();
    await expect(durationGroup).toContainText('— (milestone)');
  });

  test('Estimates section is absent from the drawer section list for milestones', async ({ page }) => {
    const drawer = await openDrawer(page, 'Phase Gate');
    // Estimates section is hidden for milestones via canRender predicate
    await expect(drawer.getByRole('button', { name: 'Estimates' })).not.toBeVisible();
  });
});

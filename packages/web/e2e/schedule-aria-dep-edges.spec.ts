/**
 * E2E coverage for #1371 — Schedule ARIA overlay announces dependency edges.
 *
 * The canvas ARIA overlay (role="grid" aria-label="Schedule chart") exposes
 * dependency relationships through per-bar aria-describedby spans so screen-reader
 * users hear "Depends on: Design Phase (FS)" when focused on a successor's bar.
 *
 * All API calls are intercepted via page.route().
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-dep-a11y-00000000-0000-0000-1371-000000000000';

const FIXTURE_TASKS = [
  {
    id: 'task-design',
    wbs_path: '1',
    name: 'Design Phase',
    early_start: '2026-04-01',
    early_finish: '2026-04-10',
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
    id: 'task-build',
    wbs_path: '2',
    name: 'Build Phase',
    early_start: '2026-04-11',
    early_finish: '2026-04-20',
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
];

// Design Phase (FS, +0d lag) → Build Phase
const FIXTURE_DEP = {
  id: 'dep-1',
  predecessor: 'task-design',
  successor: 'task-build',
  dep_type: 'FS',
  lag: 0,
  is_critical: false,
};

test.describe('Schedule ARIA overlay dep edges (#1371)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [
        {
          id: PROJECT_ID,
          name: 'Dep A11y Test Project',
          description: '',
          start_date: '2026-04-01',
          calendar: 'default',
        },
      ],
      tasks: FIXTURE_TASKS,
      dependencies: [FIXTURE_DEP],
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    // Wait for the task-list grid — confirms tasks are fetched and the schedule view rendered.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
  });

  test('successor bar has aria-describedby that names its predecessor', async ({ page }) => {
    // The canvas ARIA overlay renders role="grid" aria-label="Schedule chart"
    // with per-task role="gridcell" children. A successor cell carries aria-describedby
    // pointing at a sr-only span that announces the predecessors (#1371).

    const scheduleGrid = page.locator('[role="grid"][aria-label="Schedule chart"]');
    const buildCell = scheduleGrid.locator('[role="gridcell"][aria-label*="Build Phase"]');

    await expect(buildCell).toBeAttached({ timeout: 8_000 });

    // The cell must have aria-describedby set.
    const descId = await buildCell.getAttribute('aria-describedby');
    expect(descId, 'Build Phase bar should have aria-describedby').toBeTruthy();

    // The linked description element must announce the predecessor name and type.
    const descSpan = page.locator(`#${descId}`);
    await expect(descSpan).toBeAttached();
    await expect(descSpan).toContainText('Depends on:');
    await expect(descSpan).toContainText('Design Phase');
    await expect(descSpan).toContainText('FS');
  });

  test('predecessor bar has aria-describedby that names its successor', async ({ page }) => {
    const scheduleGrid = page.locator('[role="grid"][aria-label="Schedule chart"]');
    const designCell = scheduleGrid.locator('[role="gridcell"][aria-label*="Design Phase"]');

    await expect(designCell).toBeAttached({ timeout: 8_000 });

    const descId = await designCell.getAttribute('aria-describedby');
    expect(descId, 'Design Phase bar should have aria-describedby').toBeTruthy();

    const descSpan = page.locator(`#${descId}`);
    await expect(descSpan).toBeAttached();
    await expect(descSpan).toContainText('Leads to:');
    await expect(descSpan).toContainText('Build Phase');
  });
});

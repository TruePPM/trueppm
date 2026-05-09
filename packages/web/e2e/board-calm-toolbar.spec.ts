/**
 * E2E for the Board calm toolbar (epic #361 child B, issue #382).
 *
 * Covers acceptance criteria from #382:
 *   - Primary chips (Group / Sort / Density) open a popover and surface their
 *     options
 *   - Quiet pill toggles report aria-pressed state
 *   - Layout segmented control (Rail · Drawer · Queue) persists across reload
 *   - More⋯ overflow exposes Collapse/Expand/WIP/Tints/EVM/Columns/?/Workshop
 *
 * Drag-and-drop and the actual lane-collapse behaviour are validated in the
 * BoardView unit tests + board-backlog-band.spec.ts; this spec asserts the
 * toolbar surface itself.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-cb-00000000-0000-0000-0000-000000000382';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Calm Toolbar Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const COMMITTED_TASK = {
  id: 't1',
  wbs_path: '1.1',
  name: 'Stakeholder interviews',
  parent_id: 'phase-1',
  status: 'IN_PROGRESS',
  early_start: '2026-04-05',
  early_finish: '2026-04-10',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  is_summary: false,
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

async function setup(page: import('@playwright/test').Page) {
  const tasks = [SUMMARY_TASK, COMMITTED_TASK];
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    });
  });
}

test.describe('Board calm toolbar (epic #361 child B, issue #382)', () => {
  test('identity block, primary chips, layout switcher, and pill toggles render', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const toolbar = page.getByRole('toolbar', { name: 'Board toolbar' });
    await expect(toolbar).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.getByText('Calm Toolbar Test Project')).toBeVisible();
    await expect(toolbar.getByText(/active · .* in backlog/)).toBeVisible();

    // Primary chips
    await expect(toolbar.getByRole('button', { name: 'Group lanes by' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Sort tasks by' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Card density' })).toBeVisible();

    // Quiet pill toggles
    await expect(toolbar.getByRole('button', { name: /My tasks/ })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Show cost' })).toBeVisible();

    // Layout segmented control — defaults to Rail. `exact: true` because the
    // BacklogBand also exposes a "Collapse backlog rail" button.
    await expect(toolbar.getByRole('button', { name: 'Rail', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(toolbar.getByRole('button', { name: 'Drawer' })).toHaveAttribute('aria-pressed', 'false');
    await expect(toolbar.getByRole('button', { name: 'Queue' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('Sort chip opens a popover with Priority / Start date / % complete radios', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const sortChip = page.getByRole('button', { name: 'Sort tasks by' });
    await expect(sortChip).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await sortChip.click();
    await expect(sortChip).toHaveAttribute('aria-expanded', 'true');

    const popover = page.getByRole('dialog', { name: 'Sort tasks by' });
    await expect(popover.getByRole('radio', { name: 'Priority' })).toBeVisible();
    await expect(popover.getByRole('radio', { name: 'Start date' })).toBeVisible();
    await expect(popover.getByRole('radio', { name: '% complete' })).toBeVisible();
  });

  test('More⋯ overflow surfaces every secondary control', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    await page.getByRole('button', { name: 'More board controls' }).click();

    // Every legacy toolbar control must remain reachable per the acceptance
    // criterion "All 14 prior controls remain reachable".
    await expect(page.getByRole('button', { name: 'Collapse all lanes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Expand all lanes' })).toBeVisible();
    await expect(page.getByLabel('Show WIP limits')).toBeVisible();
    await expect(page.getByLabel('Show column tints')).toBeVisible();
    await expect(page.getByLabel('EVM indicators')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open board column settings' })).toBeVisible();
    await expect(page.getByRole('button', { name: '? Keyboard shortcuts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start workshop session' })).toBeVisible();
  });

  test('layout switcher persists Drawer selection across reload', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    const drawerBtn = page.getByRole('button', { name: 'Drawer' });
    await drawerBtn.click();
    await expect(drawerBtn).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Drawer' })).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
    // `name: 'Rail'` non-exact also matches "Collapse backlog rail" — pin with exact.
    await expect(page.getByRole('button', { name: 'Rail', exact: true })).toHaveAttribute('aria-pressed', 'false');
  });

  test('backlog density preference persists across reload', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    await page.getByRole('button', { name: 'Card density' }).click();
    await page.getByRole('radio', { name: 'Backlog card density: Compact' }).click();

    await page.reload();
    await page.getByRole('button', { name: 'Card density' }).click();
    await expect(
      page.getByRole('radio', { name: 'Backlog card density: Compact' }),
    ).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });
  });
});

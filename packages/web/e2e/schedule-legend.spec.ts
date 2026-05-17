/**
 * Schedule legend overlay (#474, ADR-0064).
 *
 * Covers user-visible acceptance criteria:
 * - Legend visible by default on the Schedule view (lg+ viewports).
 * - Header chip toggle collapses the body; the chip remains visible.
 * - Collapsed state persists across reload (localStorage key
 *   `trueppm.schedule.legend.collapsed.v1`).
 * - Suppressed below the `lg` (1024px) breakpoint.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-legend-00000000-0000-0000-0000-000000000474';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Legend Overlay Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'lg1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Schedule legend overlay (#474)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('renders the legend body by default at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.getByTestId('schedule-legend-chip')).toBeVisible();
    await expect(page.getByTestId('schedule-legend-body')).toBeVisible();
    // Sample of entries across the three rows (bar / marker / line). Scoped to
    // the legend body — "Critical path" and "Today" also appear as labels on
    // toolbar buttons elsewhere on the page.
    const body = page.getByTestId('schedule-legend-body');
    await expect(body.getByText('Summary rollup')).toBeVisible();
    await expect(body.getByText('Critical path')).toBeVisible();
    await expect(body.getByText('Today')).toBeVisible();
    await expect(body.getByText('Finish-to-start')).toBeVisible();
  });

  test('clicking the chip collapses the body; chip stays visible', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await page.getByTestId('schedule-legend-chip').click();
    await expect(page.getByTestId('schedule-legend-chip')).toBeVisible();
    await expect(page.getByTestId('schedule-legend-body')).toBeHidden();
  });

  test('collapsed state persists across reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await page.getByTestId('schedule-legend-chip').click();
    await expect(page.getByTestId('schedule-legend-body')).toBeHidden();
    await page.reload();
    await expect(page.getByTestId('schedule-legend-chip')).toBeVisible();
    await expect(page.getByTestId('schedule-legend-body')).toBeHidden();
  });

  test('legend is hidden on tablet viewport (< 1024px)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.getByTestId('schedule-legend')).toBeHidden();
  });
});

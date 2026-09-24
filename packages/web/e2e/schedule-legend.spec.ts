/**
 * Schedule legend overlay (#474, ADR-0064; toolbar toggle + default-closed
 * behavior added #3614).
 *
 * Covers user-visible acceptance criteria:
 * - Legend open by default on the user's first-ever visit (lg+ viewports).
 * - Closed by default on every visit AFTER the first — a 280×300px panel
 *   with no dismiss control was occluding most of a ~320px Gantt pane at
 *   1280, permanently, before this (#3614).
 * - A toolbar "Legend" button (aria-pressed) and the legend panel's own
 *   close control both show/hide the SAME panel and never disagree.
 * - An explicit open/closed choice persists across reload (localStorage key
 *   `trueppm.schedule.legend.collapsed.v1`).
 * - Suppressed below the `lg` (1024px) breakpoint.
 */
import { test, expect } from './fixtures/coverage';
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

test.describe('Schedule legend overlay (#474, #3614)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('renders the legend body by default on a first visit at desktop width', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.getByTestId('schedule-legend-body')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Legend', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Sample of entries across the three rows (bar / marker / line). Scoped to
    // the legend body — "Critical path" and "Today" also appear as labels on
    // toolbar buttons elsewhere on the page.
    const body = page.getByTestId('schedule-legend-body');
    await expect(body.getByText('Summary rollup')).toBeVisible();
    await expect(body.getByText('Critical path')).toBeVisible();
    await expect(body.getByText('Today')).toBeVisible();
    await expect(body.getByText('Finish-to-start')).toBeVisible();
    // Delivery-mode rows (#2727 pt.7) plus MIXED (#2737) and the sprint-window
    // band (#2738) — one legend carries the whole hybrid vocabulary.
    await expect(body.getByText('Scrum')).toBeVisible();
    await expect(body.getByText('Mixed subtree')).toBeVisible();
    await expect(body.getByText('Sprint window')).toBeVisible();
  });

  test('the toolbar Legend button hides and reshows the whole panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    const toggle = page.getByRole('button', { name: 'Legend', exact: true });
    await expect(page.getByTestId('schedule-legend')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Unmounted entirely, not just its body — nothing occludes the canvas.
    await expect(page.getByTestId('schedule-legend')).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('schedule-legend')).toBeVisible();
  });

  test('the legend panel’s own close control hides it and updates the toolbar button', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await page.getByTestId('schedule-legend-close').click();
    await expect(page.getByTestId('schedule-legend')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Legend', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('an explicit choice to close persists across reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await page.getByTestId('schedule-legend-close').click();
    await expect(page.getByTestId('schedule-legend')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('schedule-legend')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Legend', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('defaults to CLOSED on the next page load once it has been seen, with no explicit choice (#3614)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    // First visit: open, untouched.
    await expect(page.getByTestId('schedule-legend')).toBeVisible();

    // A second page load (not a toggle) — the legend has now been seen once,
    // so the default flips to closed without the user ever clicking anything.
    await page.reload();
    await expect(page.getByTestId('schedule-legend')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Legend', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('legend is hidden on tablet viewport (< 1024px)', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.getByTestId('schedule-legend')).toBeHidden();
  });
});

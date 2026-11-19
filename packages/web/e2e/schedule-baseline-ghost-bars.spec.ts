/**
 * Baseline ghost bars on the canvas Gantt (#3821, ADR-0376 follow-up).
 *
 * The bars themselves are canvas pixels, so the observable contract here is the
 * control surface and the legend: with an ACTIVE baseline the Display menu offers
 * "Baseline bars" (a checkbox, default on, keyboard reachable) and the legend
 * names the mark; with no baseline neither exists (no inert control, no legend
 * row for an undrawn mark). Geometry is covered in GanttRenderer.baseline.test.ts.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-baseline-ghost-0000-0000-0000-000000003821';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const TASKS = [
  {
    id: 'bg1',
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

const BASELINE = {
  id: 'b1',
  project: PROJECT_ID,
  name: 'Baseline 1',
  created_by: null,
  created_at: '2026-04-01T10:00:00Z',
  is_active: true,
  has_cpm_dates: true,
  task_count: 1,
};

async function setup(page: Page, baselines: Array<typeof BASELINE>) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      { id: PROJECT_ID, name: 'Baseline Ghost Project', description: '', start_date: '2026-04-01', calendar: 'default' },
    ],
    projectId: PROJECT_ID,
    tasks: TASKS,
  });
  await page.route('**/api/v1/projects/*/baselines/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: baselines.length, next: null, previous: null, results: baselines }),
    }),
  );
  await page.route('**/api/v1/projects/*/baselines/b1/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...BASELINE,
        tasks: [
          {
            task_id: 'bg1',
            task_name: 'Foundation',
            start: '2026-04-03',
            finish: '2026-04-07',
            duration: 5,
            actual_start: null,
            actual_finish: null,
          },
        ],
      }),
    }),
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(BASE_URL);
}

async function openDisplayMenu(page: Page) {
  await page
    .getByRole('toolbar', { name: 'Schedule toolbar' })
    .getByRole('button', { name: /Display/ })
    .click();
  return page.getByRole('menu', { name: 'Display options' });
}

test.describe('Baseline ghost bars (#3821)', () => {
  test('active baseline: Display menu toggles the ghost bars and the legend names them', async ({
    page,
  }) => {
    await setup(page, [BASELINE]);
    const legend = page.getByTestId('schedule-legend-body');
    await expect(legend.getByText('Baseline (planned)')).toBeVisible();

    const menu = await openDisplayMenu(page);
    const toggle = menu.getByRole('menuitemcheckbox', { name: 'Baseline bars' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    // Hidden bars => the legend stops naming them.
    await expect(legend.getByText('Baseline (planned)')).toHaveCount(0);
  });

  test('no baselines: no toggle and no legend row', async ({ page }) => {
    await setup(page, []);
    await expect(page.getByTestId('schedule-legend-body')).toBeVisible();
    await expect(page.getByText('Baseline (planned)')).toHaveCount(0);
    const menu = await openDisplayMenu(page);
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Progress %' })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Baseline bars' })).toHaveCount(0);
  });
});

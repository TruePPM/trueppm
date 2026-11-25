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

const SUMMARY_MILESTONE_TASKS = [
  {
    id: 'bg-sum',
    wbs_path: '2',
    name: 'Phase One',
    early_start: '2026-04-06',
    early_finish: '2026-04-15',
    planned_start: '2026-04-06',
    duration: 8,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'bg-ms',
    wbs_path: '3',
    name: 'Handover',
    early_start: '2026-04-20',
    early_finish: '2026-04-20',
    planned_start: '2026-04-20',
    duration: 0,
    percent_complete: 0,
    is_critical: false,
    is_milestone: true,
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

async function setup(
  page: Page,
  baselines: Array<typeof BASELINE>,
  opts: { extraTasks?: typeof SUMMARY_MILESTONE_TASKS; slipped?: boolean } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      { id: PROJECT_ID, name: 'Baseline Ghost Project', description: '', start_date: '2026-04-01', calendar: 'default' },
    ],
    projectId: PROJECT_ID,
    tasks: [...TASKS, ...(opts.extraTasks ?? [])],
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
          ...(opts.extraTasks
            ? [
                // Baselined at 2026-04-10 / 2026-04-14: both now sit later (+5d, +6d)
                // unless `slipped` is false, when they are on plan.
                {
                  task_id: 'bg-sum',
                  task_name: 'Phase One',
                  start: '2026-04-06',
                  finish: opts.slipped === false ? '2026-04-15' : '2026-04-10',
                  duration: 5,
                },
                {
                  task_id: 'bg-ms',
                  task_name: 'Handover',
                  start: opts.slipped === false ? '2026-04-20' : '2026-04-14',
                  finish: opts.slipped === false ? '2026-04-20' : '2026-04-14',
                  duration: 0,
                },
              ]
            : []),
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

  test('slipped summary and milestone: the legend names the slip mark only while drawn (#5065)', async ({
    page,
  }) => {
    await setup(page, [BASELINE], { extraTasks: SUMMARY_MILESTONE_TASKS });
    const legend = page.getByTestId('schedule-legend-body');
    await expect(legend.getByText('Baseline slip')).toBeVisible();

    const menu = await openDisplayMenu(page);
    await menu.getByRole('menuitemcheckbox', { name: 'Baseline bars' }).click();
    await page.keyboard.press('Escape');
    await expect(legend.getByText('Baseline slip')).toHaveCount(0);
  });

  test('on-plan summary and milestone draw no slip mark, so the legend omits it (#5065)', async ({
    page,
  }) => {
    await setup(page, [BASELINE], { extraTasks: SUMMARY_MILESTONE_TASKS, slipped: false });
    const legend = page.getByTestId('schedule-legend-body');
    await expect(legend.getByText('Baseline (planned)')).toBeVisible();
    await expect(legend.getByText('Baseline slip')).toHaveCount(0);
  });
});

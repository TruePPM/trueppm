/**
 * E2E smoke for the canvas Gantt under forced-colors / Windows High Contrast
 * (#1742). A `<canvas>` is not touched by the UA forced-colors transform, so the
 * engine detects `(forced-colors: active)` and repaints with the system-color
 * palette. Pixel output can't be asserted here, but this proves the detection +
 * repaint path runs end to end without crashing the view (no root error boundary)
 * and the canvas still mounts. Palette correctness is unit-tested in
 * GanttRenderer.test.ts.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

// Emulate Windows High Contrast for every test in this file.
test.use({ forcedColors: 'active' });

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000001742';

const FIXTURE_TASKS = [
  {
    id: 'fc1',
    wbs_path: '1',
    name: 'Forced Colors Audit',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test('the Gantt canvas renders under forced-colors without crashing the view', async ({
  page,
}) => {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: FIXTURE_PROJECT_ID,
        name: 'Forced Colors Audit',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });

  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);

  // The canvas scroll container mounts (the engine constructed + painted).
  await expect(page.getByTestId('schedule-canvas-scroll')).toBeVisible({ timeout: 15_000 });
  // The toolbar renders — the view did not fall through to the root error boundary.
  await expect(page.getByRole('toolbar', { name: 'Schedule toolbar' })).toBeVisible();
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
});

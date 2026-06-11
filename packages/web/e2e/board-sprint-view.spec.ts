/**
 * E2E for the Board sprint view switcher (#429, ADR-0119).
 *
 * Covers the golden path: switch from Project view to a single-sprint view, the
 * phase columns scope to that sprint, the selection persists in the ?sprint= URL
 * param, and switching back to "All tasks" restores the full project board.
 *
 * The drag-to-assign behaviour is validated in the BoardView/useBoardTasks unit
 * tests (dnd-kit drag is brittle in Playwright); this spec asserts the
 * filter + URL surface.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-sv-00000000-0000-0000-0000-000000000429';
const BASE_URL = `/projects/${PROJECT_ID}`;
const SPRINT_ID = 'sprint-atlas-4';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sprint View Project',
    description: '',
    start_date: '2026-06-01',
    calendar: 'default',
    agile_features: true,
    methodology: 'HYBRID',
  },
];

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Delivery',
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
  sprint: null,
};

function task(id: string, name: string, sprint: string | null) {
  return {
    id,
    wbs_path: `1.${id}`,
    name,
    parent_id: 'phase-1',
    status: 'IN_PROGRESS',
    early_start: '2026-06-02',
    early_finish: '2026-06-06',
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
    sprint,
  };
}

const IN_SPRINT = task('t-in', 'In the sprint', SPRINT_ID);
const OUT_SPRINT = task('t-out', 'Not in the sprint', null);

const SPRINTS = [
  {
    id: SPRINT_ID,
    server_version: 1,
    short_id: 'SP1',
    short_id_display: 'SP-1',
    name: 'Atlas 4',
    goal: '',
    notes: '',
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
    state: 'ACTIVE',
    target_milestone: null,
    capacity_points: null,
    wip_limit: null,
    exclude_from_velocity: false,
  },
];

async function setup(page: import('@playwright/test').Page) {
  const tasks = [SUMMARY_TASK, IN_SPRINT, OUT_SPRINT];
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  // Override the default empty sprints list with our ACTIVE sprint.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: SPRINTS.length, next: null, previous: null, results: SPRINTS }),
    }),
  );
}

test.describe('Board sprint view (#429)', () => {
  test('switches the board to a single sprint and back, persisting ?sprint=', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // Project view: both tasks visible.
    await expect(page.getByText('In the sprint')).toBeVisible();
    await expect(page.getByText('Not in the sprint')).toBeVisible();

    // Open the sprint switcher (defaults to "Project") and pick Atlas 4.
    await page.getByRole('button', { name: /Board scope: Project/i }).click();
    await page.getByRole('menuitemradio', { name: /Atlas 4/ }).click();

    // URL carries the sprint scope; the out-of-sprint card is hidden.
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    await expect(page.getByText('In the sprint')).toBeVisible();
    await expect(page.getByText('Not in the sprint')).toHaveCount(0);

    // Switch back to the full project board.
    await page.getByRole('button', { name: /Sprint view: Atlas 4/i }).click();
    await page.getByRole('menuitemradio', { name: /All tasks/ }).click();
    await expect(page).not.toHaveURL(/sprint=/);
    await expect(page.getByText('Not in the sprint')).toBeVisible();
  });
});

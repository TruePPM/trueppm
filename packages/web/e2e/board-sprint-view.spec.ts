/**
 * E2E for the Board sprint view switcher (#429, ADR-0119) + chrome (#1138/#1141, ADR-0123).
 *
 * Covers the golden path: the board now SMART-DEFAULTS to a project's single
 * active sprint (#1141) — the switcher no longer resets to "Project" every load.
 * From there: switch to "All tasks" and back, the scope persists in ?sprint=,
 * and a COMPLETED sprint shows the read-only banner (#1141).
 *
 * The drag-to-assign behaviour (and the drop toast, #1140) is validated in the
 * BoardView/useBoardTasks unit tests (dnd-kit drag is brittle in Playwright);
 * this spec asserts the filter + URL + chrome surface. Day-counter / date text
 * is intentionally NOT asserted — it is wall-clock + locale dependent.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-sv-00000000-0000-0000-0000-000000000429';
const BASE_URL = `/projects/${PROJECT_ID}`;
const SPRINT_ID = 'sprint-atlas-4';
const DONE_SPRINT_ID = 'sprint-atlas-3';

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

function sprintFixture(id: string, name: string, state: string) {
  return {
    id,
    server_version: 1,
    short_id: name.replace(/\s/g, ''),
    short_id_display: `SP-${name.replace(/\s/g, '')}`,
    name,
    goal: '',
    notes: '',
    start_date: '2026-06-01',
    finish_date: '2026-06-14',
    state,
    target_milestone: null,
    capacity_points: null,
    wip_limit: null,
    exclude_from_velocity: false,
  };
}

// Exactly one ACTIVE sprint → the smart default (#1141) pre-selects it. The
// COMPLETED sprint drives the read-only banner test.
const SPRINTS = [
  sprintFixture(SPRINT_ID, 'Atlas 4', 'ACTIVE'),
  sprintFixture(DONE_SPRINT_ID, 'Atlas 3', 'COMPLETED'),
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: SPRINTS.length, next: null, previous: null, results: SPRINTS }),
    }),
  );
}

test.describe('Board sprint view (#429 / chrome #1138 #1141)', () => {
  test('smart-defaults to the single active sprint, switches to All tasks and back', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);

    // #1141 smart default: the board pre-selects the single ACTIVE sprint, so
    // the scope lands on Atlas 4 (URL + switcher label) and the out-of-sprint
    // card is hidden — no manual pick needed.
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    await expect(page.getByRole('button', { name: /Sprint view: Atlas 4/i })).toBeVisible();
    await expect(page.getByText('In the sprint', { exact: true })).toBeVisible();
    await expect(page.getByText('Not in the sprint', { exact: true })).toHaveCount(0);

    // Switch back to the full project board.
    await page.getByRole('button', { name: /Sprint view: Atlas 4/i }).click();
    await page.getByRole('menuitemradio', { name: /All tasks/ }).click();
    await expect(page).not.toHaveURL(/sprint=/);
    await expect(page.getByText('Not in the sprint', { exact: true })).toBeVisible();

    // And back into the sprint scope via the switcher.
    await page.getByRole('button', { name: /Board scope: Project/i }).click();
    await page.getByRole('menuitemradio', { name: /Atlas 4/ }).click();
    await expect(page).toHaveURL(/[?&]sprint=sprint-atlas-4/);
    await expect(page.getByText('Not in the sprint', { exact: true })).toHaveCount(0);
  });

  test('shows the read-only banner on a closed sprint (#1141)', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board?sprint=${DONE_SPRINT_ID}`);

    // A shared ?sprint= link to a COMPLETED sprint surfaces the read-only banner.
    await expect(page.getByText(/Closed sprint — read only/i)).toBeVisible();
  });
});

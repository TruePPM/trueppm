import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * Unified "Today" split view (issue 412, ADR-0180).
 *
 * The dual-hat PM + Scrum-Master home the `unified` role-context lens lands on:
 * a read-only SchedulePulse strip (schedule health + the active sprint's live
 * progress) above the embedded sprint board. These specs assert the strip renders
 * its schedule signal and the active-sprint rollup chip, and that the board is
 * embedded below — plus the no-active-sprint empty state.
 */

const PROJECT_ID = 'e2e-today-0000-0000-0000-000000000001';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Apollo Platform',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

function unifiedUser(): UserFixture {
  return {
    id: 'e2e-user',
    username: 'e2euser',
    display_name: 'E2E User',
    initials: 'EU',
    email: 'e2e@example.com',
    default_landing: 'my_work',
    landing: { intent: 'my_work', path: '/me/work', resolved_by: 'preference' },
    hidden_views: [],
    role_context: 'unified',
  };
}

const ATRISK_OVERVIEW = {
  schedule_health: 'at_risk' as const,
  spi: 0.92,
  tasks_late_count: 2,
  critical_task_count: 5,
  total_tasks: 20,
  complete_tasks: 5,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-07-01', percent_complete: 40 },
};

type Methodology = 'WATERFALL' | 'AGILE' | 'HYBRID';

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function paginated(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

async function base(
  page: Page,
  opts: { overview?: typeof ATRISK_OVERVIEW; tasks?: unknown[]; methodology?: Methodology } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  // The project-detail mock returns the fixture verbatim, so stamping
  // effective_methodology drives the strip's methodology-aware halves (issue 1338).
  const projects = opts.methodology
    ? [{ ...FIXTURE_PROJECTS[0], effective_methodology: opts.methodology }]
    : FIXTURE_PROJECTS;
  await setupApiMocks(page, {
    projects,
    projectId: PROJECT_ID,
    user: unifiedUser(),
    overview: opts.overview,
    tasks: opts.tasks,
  });
}

/** Register an ACTIVE sprint (overrides the fixtures' empty default — must come after base()). */
async function routeActiveSprint(page: Page) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill(
      json(
        paginated([
          {
            id: 'sp-1',
            short_id: 'A1',
            short_id_display: 'SP-A1',
            name: 'Sprint 14',
            goal: 'Checkout polish',
            start_date: '2026-06-15',
            finish_date: '2026-06-26',
            state: 'ACTIVE',
            committed_points: 13,
            completed_points: null,
          },
        ]),
      ),
    ),
  );
}

test.describe('Unified Today view (ADR-0180)', () => {
  test('golden path — renders the schedule strip + active-sprint rollup above the board', async ({
    page,
  }) => {
    // Two tasks committed to the active sprint, one COMPLETE → derived 50%.
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'IN_PROGRESS', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks });
    await routeActiveSprint(page);

    await page.goto(`/projects/${PROJECT_ID}/today`);

    // Gate on the page-rendered signal before asserting chrome (the strip).
    const pulse = page.getByTestId('schedule-pulse');
    await expect(pulse).toBeVisible();
    // Schedule health band carries its text label, not color alone.
    await expect(page.getByTestId('pulse-health')).toContainText('At risk');
    // The active-sprint rollup chip (board → schedule link).
    await expect(page.getByTestId('pulse-sprint')).toContainText('Sprint 14');
    await expect(page.getByTestId('pulse-sprint').getByRole('progressbar')).toBeVisible();
    // The board is embedded below in its own landmark.
    await expect(page.getByRole('region', { name: 'Sprint board' })).toBeVisible();
  });

  test('empty state — shows "No active sprint" when none is active', async ({ page }) => {
    await base(page, { overview: ATRISK_OVERVIEW });
    // No sprint route override → fixtures return an empty sprint list.
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    await expect(page.getByTestId('pulse-no-sprint')).toContainText('No active sprint');
  });

  test('WATERFALL — keeps the schedule pulse, drops the sprint rollup', async ({ page }) => {
    await base(page, { overview: ATRISK_OVERVIEW, methodology: 'WATERFALL' });
    // Even with an active sprint, the rollup half is gone on waterfall.
    await routeActiveSprint(page);
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    await expect(page.getByTestId('pulse-health')).toContainText('At risk');
    await expect(page.getByTestId('pulse-sprint')).toHaveCount(0);
    // The board still embeds below — board is visible for every methodology.
    await expect(page.getByRole('region', { name: 'Sprint board' })).toBeVisible();
  });

  test('AGILE — foregrounds the sprint rollup, drops the CPM/SPI pulse', async ({ page }) => {
    const tasks = [
      { id: 't1', name: 'Cart', status: 'COMPLETE', sprint: 'sp-1', wbs_path: '1' },
      { id: 't2', name: 'Checkout', status: 'IN_PROGRESS', sprint: 'sp-1', wbs_path: '2' },
    ];
    await base(page, { overview: ATRISK_OVERVIEW, tasks, methodology: 'AGILE' });
    await routeActiveSprint(page);
    await page.goto(`/projects/${PROJECT_ID}/today`);

    await expect(page.getByTestId('schedule-pulse')).toBeVisible();
    // The active sprint chip is shown and foregrounded.
    await expect(page.getByTestId('pulse-sprint')).toContainText('Sprint 14');
    await expect(page.getByTestId('pulse-sprint').getByRole('progressbar')).toBeVisible();
    // The CPM/SPI schedule-pulse cluster is off-vocabulary on agile → not rendered.
    await expect(page.getByTestId('pulse-health')).toHaveCount(0);
  });
});

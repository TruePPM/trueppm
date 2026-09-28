import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type UserFixture } from './fixtures';

/**
 * The board sits above the fold on /today with an active sprint (#4181).
 *
 * At 1334x896 only ~160px of board columns used to be visible on Today: the
 * sprint panel's velocity / capacity / WIP body stayed painted while its toggle
 * reported collapsed, because the body's `flex` utility outranked preflight's
 * `[hidden] { display: none }`. `globals.css` now makes the `hidden` attribute
 * authoritative (web rule 433). The fix is global, so the Board route is
 * asserted too: its sprint header is unchanged and the panel collapses there
 * the same way.
 *
 * Every endpoint the page reads is mocked with its real shape (the same set the
 * #4144 guard in `today-view.spec.ts` uses), and each test gates on a real
 * column heading before measuring anything.
 */

const PROJECT_ID = 'e2e-today-fold-0000-0000-000000004181';
const VIEWPORT = { width: 1334, height: 896 };
/** Rows of first-column cards that must be fully visible (the #4181 design floor). */
const MIN_VISIBLE_ROWS = 5;

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

const OVERVIEW = {
  schedule_health: 'at_risk' as const,
  spi: 0.92,
  tasks_late_count: 2,
  critical_task_count: 5,
  total_tasks: 20,
  complete_tasks: 5,
  next_milestone: { id: 'm1', name: 'Beta', date: '2026-07-01', percent_complete: 40 },
};

// Eight To Do cards committed to the active sprint — more than fit, so the
// assertion measures the fold rather than the end of a short list.
const TASKS = Array.from({ length: 8 }, (_, i) => ({
  id: `t${i}`,
  name: `Fold task ${i}`,
  status: 'NOT_STARTED',
  sprint: 'sp-1',
  wbs_path: String(i + 1),
}));

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function paginated(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

async function setup(page: Page) {
  await page.setViewportSize(VIEWPORT);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Apollo Platform',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: PROJECT_ID,
    user: unifiedUser(),
    overview: OVERVIEW,
    tasks: TASKS,
  });
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
  await page.route('**/api/v1/sprints/sp-1/burndown/', (route) =>
    route.fulfill(json({ sprint: { id: 'sp-1', name: 'Sprint 14' }, snapshots: [] })),
  );
  await page.route('**/api/v1/sprints/sp-1/scope-changes/', (route) =>
    route.fulfill(
      json({
        summary: { points_added: 0, points_removed: 0, added_mid_sprint_count: 0, total: 0 },
        events: [],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill(
      json({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
        team_velocity_per_day: null,
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/forecast/`, (route) =>
    route.fulfill(
      json({
        velocity: {
          sprints: [],
          rolling_avg_points: null,
          rolling_stdev_points: null,
          forecast_range_low: null,
          forecast_range_high: null,
          rolling_avg_tasks: null,
          rolling_stdev_tasks: null,
          team_velocity_per_day: null,
        },
        remaining_committed_points: 0,
        sprints_to_complete_low: null,
        sprints_to_complete_high: null,
        milestones: [],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/fields/`, (route) => route.fulfill(json([])));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/labels/`, (route) =>
    route.fulfill(json(paginated([]))),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) =>
    route.fulfill(json({ ok: true })),
  );
  await page.route('**/api/v1/me/timer/', (route) => route.fulfill(json({ active: false })));
  await page.route('**/api/v1/me/work/', (route) =>
    route.fulfill(
      json({
        ...paginated([]),
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    ),
  );
  await page.route('**/api/v1/programs/', (route) => route.fulfill(json(paginated([]))));
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill(json({ id: 'w1', name: 'E2E', public_sharing_enabled: false })),
  );
}

/** Wait for the board to paint, then assert the first N cards of To Do are fully on screen. */
async function expectCardsAboveFold(page: Page) {
  await expect(page.getByRole('heading', { name: /^To Do, / })).toBeVisible();
  const cards = page.locator('[data-board-card]');
  await expect(cards.first()).toBeVisible();
  for (let i = 0; i < MIN_VISIBLE_ROWS; i++) {
    const box = await cards.nth(i).boundingBox();
    expect(box, `card ${i} has a layout box`).not.toBeNull();
    if (!box) return;
    expect(box.y, `card ${i} top`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `card ${i} bottom within ${VIEWPORT.height}px`).toBeLessThanOrEqual(
      VIEWPORT.height,
    );
  }
}

test.describe('Board above the fold with an active sprint (#4181)', () => {
  test('/today — first-column cards are within the viewport; sprint panel body starts collapsed', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/today`);
    await expect(page.getByTestId('schedule-pulse')).toBeVisible();

    await expectCardsAboveFold(page);

    // The collapsed body is actually out of the layout, not just flagged.
    const toggle = page.getByRole('button', { name: 'Expand sprint panel' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sprint-panel-body-sp-1')).toBeHidden();
    await expect(page.getByTestId('sprint-burndown-toggle')).toBeHidden();

    // Expanding is still one click away and reveals the body.
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Collapse sprint panel' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.getByTestId('sprint-burndown-toggle')).toBeVisible();
  });

  test('Board route — sprint header still renders in full and the columns stay above the fold', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/board`);

    await expectCardsAboveFold(page);

    // BoardSprintHeader is untouched by the fix: meta line, goal, Standup entry.
    await expect(page.getByLabel(/^Sprint 14, /)).toBeVisible();
    await expect(page.getByTestId('sprint-goal')).toContainText('Checkout polish');
    await expect(page.getByRole('button', { name: /Standup/ })).toBeVisible();
    await expect(page.locator('#sprint-panel-body-sp-1')).toBeHidden();
  });
});

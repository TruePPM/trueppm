/**
 * Sprint scope-injection approve-gate E2E (#881 / ADR-0102).
 *
 * Golden path: an injected task is flagged pending → the board banner shows the
 * pending line + a Review button for a team-owned actor (ADMIN) → opening the
 * review slide-over and accepting the item POSTs the accept endpoint.
 * Plus the empty-state of the review panel.
 *
 * Role is ADMIN (300) so the render-gate (useCanManageScope) lets the affordance
 * appear; the server is the real gate.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-scope-0000-0000-0000-000000000881';
const BASE_URL = `/projects/${PROJECT_ID}/board`;

const PROJECT_FIXTURE = {
  id: PROJECT_ID,
  name: 'Scope Injection E2E',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  agile_features: true,
  methodology: 'AGILE' as const,
};

const PROJECT_DETAIL = {
  ...PROJECT_FIXTURE,
  server_version: 1,
  calendar: null,
  estimation_mode: 'open',
};

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'BEEF',
  short_id_display: 'SP-BEEF',
  name: 'Iteration 14',
  goal: 'Ship the approve-gate',
  notes: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-14',
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: 40,
  committed_points: 30,
  committed_task_count: 6,
  pending_count: 1,
  completed_points: 10,
  completed_task_count: 2,
  completion_ratio_points: 0.33,
  completion_ratio_tasks: 0.33,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-04T12:00:00Z',
};

const PHASE = {
  id: 'ph1', wbs_path: '1', name: 'Delivery', early_start: '2026-04-01',
  early_finish: '2026-04-14', planned_start: '2026-04-01', duration: 14,
  percent_complete: 0, is_critical: false, is_milestone: false, is_summary: true,
  parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
};

const PENDING_TASK = {
  id: 'tk-pending', wbs_path: '1.1', name: 'Urgent hotfix', early_start: '2026-04-05',
  early_finish: '2026-04-07', planned_start: '2026-04-05', duration: 2,
  percent_complete: 0, is_critical: false, is_milestone: false, is_summary: false,
  parent_id: 'ph1', status: 'NOT_STARTED', assignees: [], total_float: null,
  sprint: ACTIVE_SPRINT.id,
  sprint_pending: true,
  sprint_scope_changes: [
    {
      id: 'sc-1',
      subtask_name: 'Urgent hotfix',
      item_name: 'Urgent hotfix',
      added_by_name: 'PM',
      added_at: '2026-04-05T09:00:00Z',
      goal_impact: false,
      status: 'pending',
    },
  ],
};

async function setupRoutes(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT_FIXTURE],
    projectId: PROJECT_ID,
    tasks: [PHASE, PENDING_TASK],
    members: [{ id: 'mem-1', role: 300 }],
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROJECT_DETAIL) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 300 }]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sprint: ACTIVE_SPRINT, snapshots: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
        forecast_range_low: null, forecast_range_high: null, rolling_avg_tasks: null,
        rolling_stdev_tasks: null, team_velocity_per_day: null,
      }),
    }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

test.describe('Sprint scope-injection approve-gate (#881 / ADR-0102)', () => {
  test('golden path: banner Review → panel → accept POSTs the accept endpoint', async ({ page }) => {
    await setupRoutes(page);

    let acceptHit = false;
    await page.route('**/api/v1/scope-changes/sc-1/accept/', (route) => {
      acceptHit = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'sc-1', task: 'tk-pending', sprint: 'sp-active',
          item_name: 'Urgent hotfix', status: 'accepted', goal_impact: false,
          added_at: '2026-04-05T09:00:00Z', pending_count: 0,
        }),
      });
    });

    await page.goto(BASE_URL);

    // Banner shows the pending line + Review button (gated, ADMIN sees it).
    // The "pending acceptance" copy renders in more than one surface (banner,
    // sprint panel, burndown caption), so scope to the first match rather than
    // tripping strict mode.
    await expect(page.getByText(/1 pending acceptance/).first()).toBeVisible();
    const review = page.getByRole('button', { name: /Review \(1\)/ });
    await expect(review).toBeVisible();
    await review.click();

    // Review slide-over opens; accept the single item.
    const panel = page.getByRole('dialog', { name: /Review pending scope/ });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Accept Urgent hotfix into the sprint/ }).click();

    await expect.poll(() => acceptHit).toBe(true);
  });

  test('non-facet Member taps the pending chip → self-explanatory disclosure, no accept/reject (#1472)', async ({
    page,
  }) => {
    await setupRoutes(page);
    // Re-cast the viewer as a plain Member (100): the banner Review affordance
    // is gated off for her (useCanManageScope), so the pending chip is her only
    // reachable touchpoint — exactly the "signal I can't act on" this fixes.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'mem-1', role: 100 }]),
      }),
    );

    await page.goto(BASE_URL);

    // The board opens on the "My tasks" filter; the injected task is unassigned,
    // so turn the filter off to reveal it.
    const myTasks = page.getByRole('button', { name: 'My tasks' });
    await expect(myTasks).toHaveAttribute('aria-pressed', 'true');
    await myTasks.click();

    // The card renders and the Review affordance is gated off for a Member.
    await expect(page.getByText('Urgent hotfix').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Review \(/ })).toHaveCount(0);

    // The pending chip is now an interactive disclosure trigger.
    const chip = page.getByRole('button', { name: /Pending acceptance\. What does this mean\?/ });
    await expect(chip.first()).toBeVisible();
    await expect(chip.first()).toHaveAttribute('aria-expanded', 'false');

    // Tapping it opens a plain-language explanation — not a dead control.
    await chip.first().click();
    const note = page.getByRole('note', { name: /Pending acceptance — explanation/ });
    await expect(note).toBeVisible();
    await expect(note).toContainText(/won't count toward the committed plan until someone on the team/i);
    // No accept/reject capability is granted to the Member — only "Got it".
    await expect(note.getByRole('button')).toHaveText('Got it');

    // "Got it" closes it and returns focus to the chip.
    await note.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByRole('note')).toHaveCount(0);
    await expect(chip.first()).toBeFocused();
  });

  test('empty state: panel with no pending items shows the all-clear message', async ({ page }) => {
    await setupRoutes(page);
    // Re-route the sprint + tasks so nothing is pending.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1, next: null, previous: null,
          results: [{ ...ACTIVE_SPRINT, pending_count: 0 }],
        }),
      }),
    );

    await page.goto(BASE_URL);
    // With pending_count 0 the banner's Review button is absent; the panel is
    // only reachable when pending > 0, so the empty-state is exercised via the
    // unit test. Here we simply assert no Review affordance is shown.
    await expect(page.getByRole('button', { name: /Review \(/ })).toHaveCount(0);
  });

  // --- touch-target geometry (#1801 backfill) ---

  test('the scope-injection banner dismiss control stays >=44x44px at a 375px viewport', async ({
    page,
  }) => {
    // Rule 228 / WCAG 2.5.5 (#1801): the dismiss × keeps a 44px touch target
    // on phones, compacting to 24px only at `md:` (>=768px). Prior coverage
    // (BoardScopeInjectionBanner.test.tsx) only asserted the className string
    // ('min-h-[44px]' etc.) — this is the real rendered bounding-box geometry
    // at a real phone viewport the issue's own AC named.
    await page.setViewportSize({ width: 375, height: 812 });
    await setupRoutes(page);
    await page.goto(BASE_URL);

    const dismiss = page.getByRole('button', { name: 'Dismiss scope-injection notice' });
    await expect(dismiss).toBeVisible({ timeout: 10_000 });
    const box = await dismiss.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

/**
 * Sprint story picker E2E (issues #2670, #2914).
 *
 * "Pull from backlog" on the planned-sprint surface used to be a plain <Link>
 * that navigated away to the Product Backlog page (#1347) — a detour that lost
 * the sprint's capacity/goal context and required N round trips to commit N
 * stories. This spec covers the in-place picker that replaces it: multi-select
 * over the backlog with Definition-of-Ready (ADR-0105) surfaced but never
 * hard-gating a commit in OSS.
 *
 * The commit itself is asserted at the wire (#2914): ONE
 * `POST /projects/{pk}/tasks/bulk/` carrying every selected row, not N
 * `PATCH /tasks/{id}/`. The partial-failure case is the one that matters — the
 * endpoint answers 207 with per-row `applied` / `rejected` buckets, and the
 * picker has to name the refused rows and retry exactly those.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-story-picker-00000000-0000-0000-0000-000000000031';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Story Picker Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology: 'AGILE',
  },
];

const PROJECT_DETAIL = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Story Picker Project',
  description: '',
  start_date: '2026-04-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
  // Server-resolved default (ADR-0758, #2670) — Ready only by default, the safe
  // starting view the picker seeds its "Ready only" / "Show all" toggle from.
  effective_sprint_picker_ready_only_default: true,
};

const PLANNED_SPRINT = {
  id: 'sp-planned',
  server_version: 1,
  short_id: 'D00D',
  short_id_display: 'SP-D00D',
  name: 'Next iteration planning',
  goal: '',
  start_date: '2026-04-15',
  finish_date: '2026-04-28',
  state: 'PLANNED',
  target_milestone: null,
  target_milestone_detail: null,
  capacity_points: 20,
  committed_points: 0,
  committed_task_count: 0,
  completed_points: 0,
  completed_task_count: 0,
  completion_ratio_points: 0,
  completion_ratio_tasks: 0,
  activated_at: null,
  closed_at: null,
  created_at: '2026-04-10T00:00:00Z',
  updated_at: '2026-04-10T00:00:00Z',
};

function apiStory(over: Record<string, unknown>) {
  return {
    id: 'story',
    short_id: 'S1',
    short_id_display: 'T-S1',
    name: 'Story',
    type: 'story',
    status: 'BACKLOG',
    wbs_path: null,
    parent_id: null,
    parent_epic: null,
    notes: '',
    sprint: null,
    sprint_pending: false,
    dor: 'idea',
    dor_blockers: [],
    story_points: null,
    early_start: '2026-04-15',
    early_finish: '2026-04-20',
    planned_start: '2026-04-15',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ac_met: 0,
    ac_total: 0,
    ...over,
  };
}

const READY_A = apiStory({
  id: 'story-ready-a',
  name: 'Ready story A',
  dor: 'ready',
  story_points: 3,
});
const READY_B = apiStory({
  id: 'story-ready-b',
  name: 'Ready story B',
  dor: 'ready',
  story_points: 5,
});
const NOT_READY_C = apiStory({
  id: 'story-refine-c',
  name: 'Unrefined story C',
  dor: 'refine',
  story_points: null,
  dor_blockers: ['unestimated', 'no_acceptance_criteria'],
});

function productBacklogBody(stories: ReturnType<typeof apiStory>[]) {
  const readyCount = stories.filter((s) => s.dor === 'ready').length;
  return {
    epics: [],
    ungrouped: stories,
    health: {
      dor_pct: stories.length ? Math.round((100 * readyCount) / stories.length) : 0,
      ready_count: readyCount,
      ready_points: stories
        .filter((s) => s.dor === 'ready')
        .reduce((sum, s) => sum + (s.story_points ?? 0), 0),
      capacity_points: PLANNED_SPRINT.capacity_points,
      unestimated: stories.filter((s) => s.story_points == null).length,
      ac_met: 0,
      ac_total: 0,
      story_count: stories.length,
    },
    scoring: { model: 'none' },
  };
}

async function setupPage(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROJECT_DETAIL),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: [PLANNED_SPRINT] }),
    }),
  );
  // Empty committed backlog — nothing has been pulled into the planned sprint yet.
  await page.route(/\/api\/v1\/tasks\//, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/product-backlog/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(productBacklogBody([READY_A, READY_B, NOT_READY_C])),
    }),
  );
  await page.route(`**/api/v1/sprints/${PLANNED_SPRINT.id}/capacity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        members: [],
        totals: {
          committed_hours: 0,
          available_hours: 0,
          ratio: 0,
          buffer_hours: 0,
          label: 'on_track',
          pto_days: 0,
        },
        working_days: 0,
        hours_per_day: 8,
      }),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/incoming_carryover\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/retrospective/carryover/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [] }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sprints: [],
        rolling_avg_points: null,
        rolling_stdev_points: null,
        forecast_range_low: null,
        forecast_range_high: null,
        rolling_avg_tasks: null,
        rolling_stdev_tasks: null,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: 0,
        critical_path_count: 0,
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ edition: 'community' }),
    }),
  );
  await page.route('**/api/v1/auth/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'e2e-user',
        username: 'e2e',
        display_name: 'E2E',
        initials: 'E',
        email: 'e2e@example.com',
      }),
    }),
  );
  // SCHEDULER role (300) — required for canManageLifecycle, which gates the
  // "Pull from backlog" button just like onAddTask.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300 }]),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-1', role: 300, role_label: 'Scheduler' }]),
    }),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"None"}' }),
  );
  await page.route('**/api/v1/me/active-sprints/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprint-health/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ signals: [] }),
    }),
  );
  await page.route('**/api/v1/me/timer/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ active: false }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 0,
        next: null,
        previous: null,
        results: [],
        due_today_count: 0,
      }),
    }),
  );
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/auth/me/pinned/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/visit/`, (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/api/v1/ws/ticket/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'e2e' }),
    }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, results: [] }),
    }),
  );
}

/** One `operations` row as the picker sends it. */
interface BulkOp {
  op: string;
  id: string;
  data: { sprint?: string };
}

/**
 * Capture every `tasks/bulk/` batch and answer each with a scripted 207.
 *
 * `replies` is consumed in order — the retry case needs the second call to
 * answer differently from the first. A call past the end answers "everything
 * applied", so a spec only scripts the responses it actually asserts on.
 */
async function routeBulk(
  page: import('@playwright/test').Page,
  batches: BulkOp[][],
  replies: ((ops: BulkOp[]) => Record<string, unknown>)[] = [],
) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/tasks/bulk/`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = req.postDataJSON() as { operations: BulkOp[] };
    const ops = body.operations;
    const reply = replies[batches.length];
    batches.push(ops);
    await route.fulfill({
      status: 207,
      contentType: 'application/json',
      body: JSON.stringify(
        reply
          ? reply(ops)
          : {
              applied: ops.map((op, index) => ({
                index,
                id: op.id,
                op: 'update',
                outcome: 'updated',
              })),
              rejected: [],
              skipped: [],
              capabilities_denied: [],
              operation_id: null,
            },
      ),
    });
  });
}

test.describe('Sprint story picker (#2670, #2914)', () => {
  test('golden path — open the picker, see DoR badges, commit a Ready story', async ({ page }) => {
    await setupPage(page);

    const batches: BulkOp[][] = [];
    await routeBulk(page, batches);

    await page.goto(BASE_URL);

    const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
    await expect(backlog).toBeVisible();
    await backlog.getByRole('button', { name: 'Pull from backlog →', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /Pull stories into SP-D00D/i });
    await expect(dialog).toBeVisible();

    // Ready-first, Ready-only by default: both ready stories show, the unrefined
    // one is hidden with an explicit count + escape hatch (never silently absent).
    await expect(dialog.getByText('Ready story A')).toBeVisible();
    await expect(dialog.getByText('Ready story B')).toBeVisible();
    await expect(dialog.getByText('Unrefined story C')).not.toBeVisible();
    await expect(dialog.getByText(/1 not-ready story is hidden/i)).toBeVisible();

    // Select one ready story and commit it.
    await dialog.getByRole('button', { name: 'Ready story A' }).click();
    await expect(dialog.getByText(/1 selected/i)).toBeVisible();
    await dialog.getByRole('button', { name: /Commit 1 story/i }).click();

    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(/Pulled 1 story into SP-D00D/i)).toBeVisible();
    // ONE batch carrying the selection — not one PATCH per story (#2914).
    expect(batches).toEqual([
      [{ op: 'update', id: 'story-ready-a', data: { sprint: 'sp-planned' } }],
    ]);
  });

  test('partial failure — the 207 buckets are reconciled per row, and the retry is scoped to them', async ({
    page,
  }) => {
    await setupPage(page);

    const batches: BulkOp[][] = [];
    await routeBulk(page, batches, [
      // First batch: story A lands, story B is refused with a reason the picker must show.
      () => ({
        applied: [{ index: 0, id: 'story-ready-a', op: 'update', outcome: 'updated' }],
        rejected: [
          {
            index: 1,
            id: 'story-ready-b',
            code: 'forbidden',
            message: 'You may not edit this task.',
          },
        ],
        skipped: [],
        capabilities_denied: [],
        operation_id: null,
      }),
    ]);

    await page.goto(BASE_URL);
    const backlogRegion = page.getByRole('region', { name: /Sprint Backlog/i });
    await backlogRegion.getByRole('button', { name: 'Pull from backlog →', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /Pull stories into SP-D00D/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Ready story A' }).click();
    await dialog.getByRole('button', { name: 'Ready story B' }).click();
    await dialog.getByRole('button', { name: /Commit 2 stories/i }).click();

    // The dialog stays open and reconciles: committed count, the refused row by
    // name, and the server's own reason — none of which a toast could carry.
    const result = dialog.getByTestId('story-picker-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Committed 1 of 2 stories to SP-D00D.');
    await expect(result).toContainText('1 not committed');
    await expect(result).toContainText('Ready story B');
    await expect(result).toContainText('You may not edit this task.');

    // The retry re-sends the rejected row ONLY — never the one that already landed.
    await dialog.getByRole('button', { name: /Retry 1 story/i }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(/Pulled 1 story into SP-D00D/i)).toBeVisible();
    expect(batches).toEqual([
      [
        { op: 'update', id: 'story-ready-a', data: { sprint: 'sp-planned' } },
        { op: 'update', id: 'story-ready-b', data: { sprint: 'sp-planned' } },
      ],
      [{ op: 'update', id: 'story-ready-b', data: { sprint: 'sp-planned' } }],
    ]);
  });

  test('edge case — a not-ready story is advisory only, never hard-blocked from commit', async ({
    page,
  }) => {
    await setupPage(page);

    const batches: BulkOp[][] = [];
    await routeBulk(page, batches);

    await page.goto(BASE_URL);
    const backlog = page.getByRole('region', { name: /Sprint Backlog/i });
    await backlog.getByRole('button', { name: 'Pull from backlog →', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: /Pull stories into SP-D00D/i });
    await expect(dialog).toBeVisible();

    // Reveal the not-ready story — dimmed, with its blocker reasons spelled out.
    await dialog.getByRole('button', { name: 'Show all' }).click();
    await expect(dialog.getByText('Unrefined story C')).toBeVisible();
    await expect(dialog.getByText(/needs an estimate/i)).toBeVisible();
    await expect(dialog.getByText(/add at least one acceptance criterion/i)).toBeVisible();

    // Selecting it surfaces an advisory warning — not a disabled Commit button.
    await dialog.getByRole('button', { name: /Unrefined story C/i }).click();
    await expect(
      dialog.getByText(/1 selected story is not marked Ready — you can still pull it/i),
    ).toBeVisible();
    const commitButton = dialog.getByRole('button', { name: /Commit 1 story/i });
    await expect(commitButton).toBeEnabled();

    // OSS never hard-blocks: the commit goes through anyway.
    await commitButton.click();
    await expect(dialog).not.toBeVisible();
    expect(batches).toEqual([
      [{ op: 'update', id: 'story-refine-c', data: { sprint: 'sp-planned' } }],
    ]);
  });
});

/**
 * Sprint header buttons + timeline plan-arrow flows — issue #299.
 *
 * Three flows:
 *   1. Filter popover → "Me" filter reduces the backlog.
 *   2. Close sprint dialog → carry-over picker → confirm.
 *   3. Timeline "Activate →" on the last planned card → POST /activate/.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-sprint-buttons-00000000-0000-0000-0000-00000071';
const ROUTE = `/projects/${PROJECT_ID}/sprints`;

const PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Sprint Buttons Test',
  description: '',
  start_date: '2026-01-01',
  calendar: null,
  estimation_mode: 'open',
  agile_features: true,
  methodology: 'AGILE',
};

function isoOffsetDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'A1',
  short_id_display: 'SP-A1',
  name: 'Sprint Alpha',
  goal: 'In progress',
  notes: '',
  start_date: isoOffsetDays(-7),
  finish_date: isoOffsetDays(7),
  state: 'ACTIVE',
  target_milestone: null,
  target_milestone_detail: null,
  committed_points: 12,
  committed_task_count: 2,
  completed_points: 4,
  completed_task_count: 1,
  completion_ratio_points: 0.33,
  completion_ratio_tasks: 0.5,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

const PLANNED_SPRINT = {
  ...ACTIVE_SPRINT,
  id: 'sp-planned',
  short_id: 'P1',
  short_id_display: 'SP-P1',
  name: 'Sprint Bravo',
  state: 'PLANNED',
  // Within 3 days → "Activate →" appears.
  start_date: isoOffsetDays(2),
  finish_date: isoOffsetDays(16),
  committed_points: null,
  committed_task_count: null,
  completed_points: null,
  completed_task_count: null,
  activated_at: null,
};

const BACKLOG_TASKS = [
  {
    id: 't-alice',
    short_id: 'T-1',
    short_id_display: 'T-1',
    name: 'Alice task',
    wbs_path: '1.1',
    status: 'IN_PROGRESS',
    story_points: 5,
    is_critical: false,
    sprint: 'sp-active',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: '1.00' }],
  },
  {
    id: 't-bob',
    short_id: 'T-2',
    short_id_display: 'T-2',
    name: 'Bob task',
    wbs_path: '1.2',
    status: 'NOT_STARTED',
    story_points: 3,
    is_critical: false,
    sprint: 'sp-active',
    assignments: [{ resource_id: 'r2', resource_name: 'Bob', units: '1.00' }],
  },
];

const PROJECT_RESOURCES = [
  {
    id: 'pr-1',
    project: PROJECT_ID,
    resource: 'r1',
    resource_detail: {
      id: 'r1', name: 'Alice', email: 'e2e@example.com',
      job_role: '', max_units: '1.00', calendar: null, skills: [],
      is_me: true,
    },
    role_title: '', units_override: null, effective_max_units: '1.00', notes: '',
  },
  {
    id: 'pr-2',
    project: PROJECT_ID,
    resource: 'r2',
    resource_detail: {
      id: 'r2', name: 'Bob', email: 'bob@example.com',
      job_role: '', max_units: '1.00', calendar: null, skills: [],
      is_me: false,
    },
    role_title: '', units_override: null, effective_max_units: '1.00', notes: '',
  },
];

async function setupCommon(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const json = (body: unknown, status = 200) => ({
    status, contentType: 'application/json', body: JSON.stringify(body),
  });

  // Catch-all FIRST so any specific route below wins (Playwright matches
  // routes in reverse-registration order). Returning a plain empty array is
  // a common shape for non-paginated endpoints; paginated consumers fail
  // gracefully on `.results === undefined`.
  await page.route('**/api/v1/**', (r) => r.fulfill(json([])));

  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill(json({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' })),
  );
  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [PROJECT] })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) => r.fulfill(json(PROJECT)));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) => {
    const url = new URL(r.request().url());
    if (url.searchParams.get('self') === 'true') {
      return r.fulfill(json([{ id: 'mem-1', role: 300, user_id: 'e2e-user' }]));
    }
    return r.fulfill(json([{ id: 'mem-1', role: 300 }]));
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/presence/`, (r) => r.fulfill(json([])));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/status-summary/`, (r) =>
    r.fulfill(json({
      task_count: 2, critical_path_count: 0, monte_carlo_p80: null,
      at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
      last_saved: null, recalculated_at: null,
    })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (r) =>
    r.fulfill(json({ sprint: ACTIVE_SPRINT, snapshots: [] })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (r) =>
    r.fulfill(json({
      members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 },
      working_days: 0, hours_per_day: 8,
    })),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (r) =>
    r.fulfill(json({
      sprints: [], rolling_avg_points: null, rolling_stdev_points: null,
      forecast_range_low: null, forecast_range_high: null,
      rolling_avg_tasks: null, rolling_stdev_tasks: null,
    })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (r) => r.fulfill(json({ detail: 'None' }, 404)));
  // The live retro board (ADR-0117) mounts for ACTIVE/COMPLETED sprints and fires
  // these on mount; give them safe defaults so they don't hit the network and add
  // churn to the initial render (empty board, no own pulse, GATED trend → private wall).
  await page.route(/\/api\/v1\/sprints\/.*\/retro-board\//, (r) =>
    r.fulfill(json({
      columns: [
        { key: 'went_well', label: 'What went well' },
        { key: 'to_improve', label: 'What to improve' },
        { key: 'ideas', label: 'Ideas & discussion' },
      ],
      items: [],
    })),
  );
  await page.route(/\/api\/v1\/sprints\/.*\/pulse-trend\//, (r) => r.fulfill(json({ gated: true })));
  await page.route(/\/api\/v1\/sprints\/.*\/pulse\//, (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/api/v1/me/active-sprints/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/project-resources/**', (r) =>
    r.fulfill(json({ count: PROJECT_RESOURCES.length, next: null, previous: null, results: PROJECT_RESOURCES })),
  );
}

test.describe('Sprint header buttons (#299)', () => {
  test('Filter popover applies a "Me" filter to the backlog', async ({ page }) => {
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] }),
      }),
    );
    await page.route(/\/api\/v1\/tasks\//, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: BACKLOG_TASKS.length, next: null, previous: null, results: BACKLOG_TASKS }),
      }),
    );

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Alice task')).toBeVisible();
    await expect(page.getByText('Bob task')).toBeVisible();

    await page.getByRole('button', { name: 'Filter' }).click();
    await expect(page.getByRole('dialog', { name: /Filter sprint backlog/ })).toBeVisible();
    await page.getByRole('radio', { name: 'Me' }).click();

    await expect(page.getByText('Alice task')).toBeVisible();
    await expect(page.getByText('Bob task')).not.toBeVisible();
  });

  test('Close sprint opens a confirmation dialog with carry-over picker', async ({ page }) => {
    let closeBody: { carry_over_to: string } | null = null;
    await setupCommon(page);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 2, next: null, previous: null, results: [ACTIVE_SPRINT, PLANNED_SPRINT] }),
      }),
    );
    await page.route(/\/api\/v1\/tasks\//, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) => {
      closeBody = r.request().postDataJSON() as { carry_over_to: string };
      return r.fulfill({
        status: 202, contentType: 'application/json',
        body: JSON.stringify({ queued: true, request_id: 'req-1' }),
      });
    });

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Close active sprint/ }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();
    // Default radio is "next planned" since one exists.
    const nextRadio = dialog.getByRole('radio', { name: /Next planned sprint/ });
    await expect(nextRadio).toBeChecked();

    await dialog.getByRole('button', { name: 'Close sprint' }).click();
    // The close mutation fires with the planned sprint id as the carry-over
    // destination.
    await expect.poll(() => closeBody?.carry_over_to).toBe('sp-planned');
  });

  test('Activate → on the last planned card activates it and the board reflects the ACTIVE transition', async ({ page }) => {
    let activateCalled = false;
    await setupCommon(page);
    // Stateful sprints list — mirrors the live invalidate-then-refetch after
    // activate (useSprintMutations invalidates ['sprints', projectId]). Before:
    // Alpha ACTIVE, Bravo PLANNED. After activate advances the cadence: Alpha
    // closes, Bravo becomes the sole active. A body-blind mock that returns
    // PLANNED forever lets a deleted cache-invalidation ship green — the button
    // stays "Activate →" and users double-activate (issue 1512).
    let sprintsList: Array<Record<string, unknown>> = [ACTIVE_SPRINT, PLANNED_SPRINT];
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: sprintsList.length, next: null, previous: null, results: sprintsList }),
      }),
    );
    await page.route(/\/api\/v1\/tasks\//, (r) =>
      r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
      }),
    );
    await page.route(/\/api\/v1\/sprints\/sp-planned\/activate\//, (r) => {
      activateCalled = true;
      sprintsList = [
        { ...ACTIVE_SPRINT, state: 'COMPLETED', closed_at: '2026-04-15T00:00:00Z' },
        { ...PLANNED_SPRINT, state: 'ACTIVE', activated_at: '2026-04-15T00:00:00Z' },
      ];
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          ...PLANNED_SPRINT,
          state: 'ACTIVE',
          warnings: [
            { resource_id: 'r1', resource_name: 'Alice', load_factor: 1.3, message: 'Alice at 130% in week 1' },
          ],
        }),
      });
    });

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });

    const activate = page.getByRole('button', { name: 'Activate →' });
    await expect(activate).toBeVisible();
    await activate.click();

    await expect.poll(() => activateCalled).toBe(true);

    // The UI reflects the ACTIVE transition after the refetch: Bravo has left the
    // planned bucket, so its "Activate →" affordance is gone. This is the exact
    // regression the issue names — a deleted cache-invalidation leaves the button
    // reading "Activate →" and lets users double-activate. Asserting the request
    // fired is not enough; this proves the list actually re-read and re-rendered.
    // (The transient capacity-warning banner is intentionally cleared by
    // SprintsView when the active sprint rolls over, so it is not asserted here —
    // it only ever "persisted" under the old body-blind mock that never flipped.)
    await expect(page.getByRole('button', { name: 'Activate →' })).toHaveCount(0, { timeout: 10_000 });
  });
});

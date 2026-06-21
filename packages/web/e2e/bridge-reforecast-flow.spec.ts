/**
 * Bridge: close a milestone-bound sprint → reforecast (#1034 item 6).
 *
 * The "bridge" is the link between the agile sprint loop and the CPM schedule
 * forecast: an ACTIVE sprint advancing toward a milestone surfaces the rolled-up
 * milestone progress + variance (the AdvancingToMilestoneCard), and closing that
 * sprint feeds actuals back into the schedule and *queues* a server-side
 * reforecast (the close endpoint returns `{queued: true}`, ADR-0102/ADR-0106).
 *
 * What this spec covers end-to-end (no other E2E stitches the bridge surface):
 *   1. Golden — the bridge card renders the milestone rollup + the schedule
 *      deep-link, and confirming the close fires POST /close/ → 202 {queued}
 *      (the reforecast trigger) and dismisses the dialog.
 *   2. Error — a failed close (500) leaves the dialog open and the sprint ACTIVE
 *      (SprintsView has no onError handler; the dialog only closes onSuccess).
 *
 * The downstream *confidence number change* itself is server-side (the CPM
 * reforecast) and arrives via the `milestone_forecast_updated` WS event; it is
 * covered by the scheduler/backend tests (test_milestone_reforecast.py) and the
 * component units (AdvancingToMilestoneCard / SprintForecastWidget), not here.
 */
import { test, expect } from '@playwright/test';

const PROJECT_ID = 'e2e-bridge-reforecast-0000-0000-0000-000010';
const ROUTE = `/projects/${PROJECT_ID}/sprints`;
const MILESTONE_ID = 'task-m1';

const PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Bridge Reforecast Test',
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

// An ACTIVE sprint bound to a milestone — the bridge surface. The serializer
// expands the FK into `target_milestone_detail` (with a rollup) so the card
// renders without a second round-trip.
const BOUND_ACTIVE_SPRINT = {
  id: 'sp-active',
  server_version: 1,
  short_id: 'A1',
  short_id_display: 'SP-A1',
  name: 'Sprint Alpha',
  goal: 'Advancing the beta gate',
  notes: '',
  start_date: isoOffsetDays(-7),
  finish_date: isoOffsetDays(7),
  state: 'ACTIVE',
  target_milestone: MILESTONE_ID,
  target_milestone_detail: {
    id: MILESTONE_ID,
    name: 'Customer Beta Gate',
    wbs_path: '2.4',
    finish: isoOffsetDays(10),
    predecessor_ids: [],
    rollup: {
      percent_complete: 60,
      rollup_basis: 'points',
      variance_days: 3,
      sprint_scope_changed: false,
      scope_change_sprint_id: null,
      sprint_count: 1,
    },
  },
  committed_points: 12,
  committed_task_count: 2,
  completed_points: 7,
  completed_task_count: 1,
  completion_ratio_points: 0.58,
  completion_ratio_tasks: 0.5,
  pending_count: 0,
  activated_at: '2026-04-01T00:00:00Z',
  closed_at: null,
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

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
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // Catch-all FIRST so any specific route below wins (Playwright matches routes
  // in reverse-registration order). Object-shaped endpoints the page reads are
  // all mocked explicitly below — never rely on this empty-array net for them.
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
    r.fulfill(json({ sprint: BOUND_ACTIVE_SPRINT, snapshots: [] })),
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
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  // Sprint list + empty backlog — the bound ACTIVE sprint is the only one.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [BOUND_ACTIVE_SPRINT] })),
  );
  await page.route(/\/api\/v1\/tasks\//, (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
}

test.describe('Bridge: close a milestone-bound sprint → reforecast (#1034)', () => {
  test('golden: the bridge card renders the milestone rollup and closing queues the reforecast', async ({
    page,
  }) => {
    let closeBody: { carry_over_to: string } | null = null;
    await setupCommon(page);
    // The close endpoint returns 202 {queued:true} — the server-side reforecast
    // is queued, not synchronous (ADR-0102 §close → outbox).
    await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) => {
      closeBody = r.request().postDataJSON() as { carry_over_to: string };
      return r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ queued: true, request_id: 'req-bridge-1' }),
      });
    });

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });

    // The bridge surface: the active sprint advances toward a milestone, with the
    // rolled-up progress and a deep-link into the schedule forecast. Scope to the
    // card region — the milestone name also appears in the Sprint Cadence section.
    await expect(page.getByRole('heading', { name: /Advancing to Milestone/i })).toBeVisible();
    const card = page.getByRole('region', { name: /Advancing to Milestone/i });
    await expect(card.getByText('Customer Beta Gate')).toBeVisible();
    await expect(card.getByLabel(/Milestone progress 60 percent/)).toBeVisible();
    const scheduleLink = card.getByRole('link', { name: /Open in Schedule view/ });
    await expect(scheduleLink).toHaveAttribute('href', new RegExp(`/schedule#task-${MILESTONE_ID}`));

    // Close the sprint → confirm → the reforecast is queued.
    await page.getByRole('button', { name: /Close active sprint/ }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Close sprint/ }).click();

    // No next planned sprint exists → carry-over defaults to the project backlog.
    await expect.poll(() => closeBody?.carry_over_to).toBe('backlog');
    // onSuccess dismisses the dialog (SprintsView.handleConfirmClose).
    await expect(dialog).not.toBeVisible();
  });

  test('error: a failed close leaves the dialog open and the sprint active', async ({ page }) => {
    let closeAttempts = 0;
    await setupCommon(page);
    await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) => {
      closeAttempts += 1;
      return r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Reforecast worker unavailable' }),
      });
    });

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Close active sprint/ }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Close sprint/ }).click();

    await expect.poll(() => closeAttempts).toBe(1);
    // The close mutation has no onError → the dialog stays open (it only closes
    // onSuccess) and the sprint remains ACTIVE: the bridge card is still shown.
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('heading', { name: /Advancing to Milestone/i })).toBeVisible();
  });
});

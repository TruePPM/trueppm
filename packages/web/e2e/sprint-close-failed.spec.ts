/**
 * Terminal sprint-close failure surface — issue #2992.
 *
 * Closing a sprint returns 202 and completes on a Celery drain, so it can fail
 * minutes after the button was pressed. Until this, it failed *silently*: the
 * sprint stayed ACTIVE, the success toast and retro CTA both stood, and the
 * error existed only on a read route nothing called.
 *
 * Three flows:
 *   1. Golden — a terminal failure surfaces where the user pressed Close, names
 *      the reason, and says the sprint is still open.
 *   2. The correctness case — a close that FAILED but is still scheduled to
 *      retry surfaces nothing, because the drain re-runs it and it usually then
 *      succeeds. Branching on `status` instead of `terminal` breaks exactly here.
 *   3. Recovery — the banner offers a way back into the close dialog, and is
 *      dismissible.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-close-failed-0000-0000-0000-000000002992';
const ROUTE = `/projects/${PROJECT_ID}/sprints`;

const PROJECT = {
  id: PROJECT_ID,
  server_version: 1,
  name: 'Retro Handoff Project',
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

async function setupCommon(page: Page) {
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

  // Catch-all FIRST so an unmocked endpoint returns a typed 404 instead of
  // falling through and 401ing, which trips the token-refresh session
  // teardown and races the page render (#2366). Routes below win.
  await setupCatchAll(page);

  // Catch-all safety net FIRST (later-registered specific routes win).
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
  // Retro board reads (ADR-0117) — the panel mounts for ACTIVE/COMPLETED and
  // fires these on mount; give them real shapes so the surface renders.
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
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] })),
  );
  await page.route(/\/api\/v1\/tasks\//, (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
}


/** A close-request row as the read route serves it. */
function closeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-2992',
    sprint: 'sp-active',
    status: 'FAILED',
    attempt_count: 3,
    failure_reason: 'error',
    error_message:
      'The close failed and will not be retried. The sprint is still open \u2014 ask a project admin for the details.',
    requested_at: '2026-08-23T10:00:00Z',
    started_at: '2026-08-23T10:00:01Z',
    completed_at: '2026-08-23T10:00:02Z',
    next_attempt_at: null,
    terminal: true,
    ...overrides,
  };
}

async function mockClose(page: Page, state: Record<string, unknown>) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  // Registered BEFORE the generic /sprints/ routes below would match — the
  // close-request read is what the surface branches on, so it must never fall
  // through to the catch-all's list shape.
  await page.route(/\/api\/v1\/sprints\/sp-active\/close-request\//, (r) =>
    r.fulfill(json(state)),
  );
  await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) =>
    r.fulfill(json({ queued: true, request_id: 'req-2992' }, 202)),
  );
}

async function closeTheSprint(page: Page) {
  await page.goto(ROUTE);
  await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('retro-handoff-target')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Close active sprint/ }).click();
  const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Close sprint/ }).click();
  await expect(dialog).not.toBeVisible();
}

test.describe('Terminal sprint-close failure (#2992)', () => {
  test('golden: an abandoned close says so, and says the sprint is still open', async ({
    page,
  }) => {
    await setupCommon(page);
    await mockClose(page, closeRequest());

    await closeTheSprint(page);

    // role="alert", not "status": this reverses a success the user was already
    // told about by the close toast.
    const banner = page.getByRole('alert').filter({ hasText: "didn't close" });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('Sprint Alpha');
    // The fact that changes what the user does next.
    await expect(banner).toContainText('still open');
    // The server-authored explanation, rendered verbatim.
    await expect(banner).toContainText('ask a project admin');
    await expect(banner).toContainText('Tried 3 times');

    // The success handoff is retracted — leaving "Sprint Alpha closed. Run its
    // retro" next to "Sprint Alpha didn't close" would be worse than either.
    await expect(page.getByRole('button', { name: /Run the Sprint Alpha retro/ })).toHaveCount(0);
  });

  test('a close that failed but is still scheduled to retry surfaces nothing', async ({ page }) => {
    // The single most important assertion in this spec. A FAILED row with a
    // live retry clock is one the drain re-runs about a minute later, and it
    // usually then succeeds — alarming the user about it is worse than silence.
    await setupCommon(page);
    await mockClose(
      page,
      closeRequest({
        terminal: false,
        attempt_count: 1,
        next_attempt_at: '2026-08-23T10:01:02Z',
        error_message: 'The close failed and will be retried automatically.',
      }),
    );

    await closeTheSprint(page);

    // The success handoff still stands, and no failure alert exists.
    await expect(page.getByRole('button', { name: /Run the Sprint Alpha retro/ })).toBeVisible();
    // Wait past a poll cycle so this is a real absence, not an early read.
    await page.waitForTimeout(4_000);
    await expect(page.getByRole('alert').filter({ hasText: "didn't close" })).toHaveCount(0);
  });

  test('the failure is still there after a reload, without pressing Close at all', async ({
    page,
  }) => {
    // The close dies on a drain minutes after the button was pressed, so having
    // navigated away by then is the ordinary case — and a teammate watching the
    // same board never pressed anything. If the banner only existed in the tab
    // that fired the mutation, the original defect (sprint silently stays open,
    // no error anywhere) would be unchanged for everyone else.
    await setupCommon(page);
    await mockClose(page, closeRequest());

    // Land on the sprints workspace cold. No close is requested in this session.
    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { level: 1, name: /Sprint Alpha/ })).toBeVisible({
      timeout: 10_000,
    });

    const banner = page.getByRole('alert').filter({ hasText: "didn't close" });
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('still open');
  });

  test('the failure offers a way back into the close dialog, and is dismissible', async ({
    page,
  }) => {
    await setupCommon(page);
    await mockClose(page, closeRequest());

    await closeTheSprint(page);

    const banner = page.getByRole('alert').filter({ hasText: "didn't close" });
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // Retry re-opens the close dialog rather than firing a blind second POST —
    // the disposition choices matter as much on the second attempt as the first.
    await banner.getByRole('button', { name: 'Try closing again' }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();

    // Taking the retry also clears the banner: it described an outcome the user
    // is now re-deciding.
    await expect(banner).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // The sprint is still open and the workspace is intact. Scoped to the page
    // heading — the dialog title also matches /Sprint Alpha/ (strict mode).
    await expect(page.getByRole('heading', { level: 1, name: /Sprint Alpha/ })).toBeVisible();
  });
});

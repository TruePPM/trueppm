/**
 * Post-close retro handoff CTA — issue #1471.
 *
 * The retro→backlog pipeline is strong, but the retro was orphaned from the
 * close ceremony that should launch it. Two flows:
 *   1. Golden — close a sprint → a "Run the retro" CTA appears → clicking it
 *      deep-links (selects + focuses) the just-closed sprint's retro surface.
 *   2. Dismiss — the CTA is dismissible and never gates the close: dismissing
 *      removes it and leaves the workspace intact.
 */
import { test, expect, type Page } from './fixtures/coverage';

const PROJECT_ID = 'e2e-retro-handoff-0000-0000-0000-000000001471';
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

test.describe('Post-close retro handoff (#1471)', () => {
  test('golden: closing a sprint surfaces a one-tap deep-link into its retro', async ({ page }) => {
    await setupCommon(page);
    await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) =>
      r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ queued: true, request_id: 'req-1471' }),
      }),
    );

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });
    // Gate on a data-dependent surface so the dialog's `activeSprint` gate is
    // settled before we interact — otherwise a cold-start refetch can flicker it
    // and drop the close click (issue #1471 spec hardening).
    await expect(page.getByTestId('retro-handoff-target')).toBeVisible({ timeout: 10_000 });

    // Close the sprint via the dialog.
    await page.getByRole('button', { name: /Close active sprint/ }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Close sprint/ }).click();
    await expect(dialog).not.toBeVisible();

    // The handoff CTA appears on close success, naming the just-closed sprint.
    const cta = page.getByRole('button', { name: /Run the Sprint Alpha retro/ });
    await expect(cta).toBeVisible();

    // One tap deep-links the retro surface: the target region receives focus.
    await cta.click();
    const retroTarget = page.getByTestId('retro-handoff-target');
    await expect(retroTarget).toBeFocused();
    await expect(retroTarget.getByRole('heading', { name: 'Retrospective' })).toBeVisible();

    // The CTA is consumed once the retro is opened.
    await expect(cta).toHaveCount(0);
  });

  test('dismiss: the CTA is dismissible and never gates the close', async ({ page }) => {
    await setupCommon(page);
    await page.route(/\/api\/v1\/sprints\/sp-active\/close\//, (r) =>
      r.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ queued: true, request_id: 'req-1471b' }),
      }),
    );

    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('retro-handoff-target')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Close active sprint/ }).click();
    const dialog = page.getByRole('dialog', { name: /Close Sprint Alpha/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /Close sprint/ }).click();
    await expect(dialog).not.toBeVisible();

    const cta = page.getByRole('button', { name: /Run the Sprint Alpha retro/ });
    await expect(cta).toBeVisible();

    // Dismissing removes the handoff without opening the retro.
    await page.getByRole('button', { name: 'Dismiss retro handoff' }).click();
    await expect(cta).toHaveCount(0);
    // The workspace is intact — the sprint header is still present.
    await expect(page.getByRole('heading', { name: /Sprint Alpha/ })).toBeVisible();
  });
});

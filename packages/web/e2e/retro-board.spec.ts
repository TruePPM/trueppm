/**
 * Live multi-writer retro board + team-health pulse E2E (#851 / #923, ADR-0117).
 *
 * Golden path: the board renders three columns and a member adds a sticky
 * (POST fires). Privacy 🔴: a team member sees the pulse poll + aggregate trend,
 * while a reader above the pulse audience (the PM band → gated trend) sees ONLY
 * the "kept private" wall — never a count, poll, or teaser.
 */
import { test, expect, type Page } from '@playwright/test';

const PROJECT_ID = 'e2e-retro-board-0000-0000-0000-000000000851';
const BASE_URL = `/projects/${PROJECT_ID}/sprints`;

const ACTIVE_SPRINT = {
  id: 'sp-active', server_version: 1, short_id: 'A1', short_id_display: 'SP-A1',
  name: 'Active sprint', goal: '', start_date: '2026-04-01', finish_date: '2026-04-14',
  state: 'ACTIVE', target_milestone: null, target_milestone_detail: null,
  committed_points: 20, committed_task_count: 0, completed_points: 0, completed_task_count: 0,
  completion_ratio_points: 0, completion_ratio_tasks: 0,
  activated_at: '2026-04-01T00:00:00Z', closed_at: null,
  created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z',
};

interface Options {
  /** pulse-trend response — gated (PM band) vs the team's aggregate trend. */
  pulseTrend: unknown;
}

async function setup(page: Page, opts: Options) {
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

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [
      { id: PROJECT_ID, name: 'Retro Board Project', description: '', start_date: '2026-04-01', calendar: 'default', methodology: 'AGILE' },
    ] })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill(json({ id: PROJECT_ID, server_version: 1, name: 'Retro Board Project', description: '', start_date: '2026-04-01', calendar: null, estimation_mode: 'open', agile_features: true, methodology: 'AGILE' })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/`, (r) =>
    r.fulfill(json({ count: 1, next: null, previous: null, results: [ACTIVE_SPRINT] })));
  await page.route(/\/api\/v1\/sprints\/.*\/burndown\//, (r) => r.fulfill(json({ sprint: ACTIVE_SPRINT, snapshots: [] })));
  await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (r) => r.fulfill(json({ members: [], totals: { committed_hours: 0, available_hours: 0, ratio: 0, buffer_hours: 0, label: 'on_track', pto_days: 0 }, working_days: 0, hours_per_day: 8 })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/velocity/`, (r) => r.fulfill(json({ sprints: [], rolling_avg_points: null, rolling_stdev_points: null, forecast_range_low: null, forecast_range_high: null, rolling_avg_tasks: null, rolling_stdev_tasks: null })));
  await page.route(/\/api\/v1\/tasks\//, (r) => r.fulfill(json({ count: 0, next: null, previous: null, results: [] })));
  await page.route('**/api/v1/me/active-sprints/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/presence/', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/projects/*/status-summary/', (r) => r.fulfill(json({ task_count: 0, critical_path_count: 0, monte_carlo_p80: null, at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [], last_saved: null, recalculated_at: null })));
  await page.route('**/api/v1/edition/', (r) => r.fulfill(json({ edition: 'community' })));
  await page.route('**/api/v1/auth/me/', (r) => r.fulfill(json({ id: 'e2e-user', username: 'e2e', display_name: 'E2E', initials: 'E', email: 'e2e@example.com' })));
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/`, (r) => r.fulfill(json([{ id: 'mem-1', role: 100 }])));

  // Single-author retro: a row exists so the surface renders the full editor.
  await page.route(/\/api\/v1\/sprints\/.*\/retro\//, (r) => {
    if (r.request().url().includes('/retrospective/prior/')) return r.fulfill(json({ detail: 'None' }, 404));
    return r.fulfill(json({ kind: 'full', id: 'retro-1', sprint: 'sp-active', notes: '', team_visibility: 'team_only', created_by: null, created_at: '2026-04-15T00:00:00Z', updated_at: '2026-04-15T00:00:00Z', action_items: [] }));
  });

  await page.route(/\/api\/v1\/sprints\/.*\/retro-board\//, (r) => {
    if (r.request().method() === 'POST') {
      const b = r.request().postDataJSON() as { column: string; text: string };
      return r.fulfill(json({ id: `bi-${Date.now()}`, retro: 'retro-1', column: b.column, text: b.text, author: 1, author_username: 'e2e', position: 1, color: '', converted_action_item_id: null, created_at: '2026-04-15T00:00:00Z', updated_at: '2026-04-15T00:00:00Z' }, 201));
    }
    return r.fulfill(json({
      columns: [
        { key: 'went_well', label: 'What went well' },
        { key: 'to_improve', label: 'What to improve' },
        { key: 'ideas', label: 'Ideas & discussion' },
      ],
      items: [],
    }));
  });
  await page.route(/\/api\/v1\/sprints\/.*\/pulse-trend\//, (r) => r.fulfill(json(opts.pulseTrend)));
  await page.route(/\/api\/v1\/sprints\/.*\/pulse\//, (r) =>
    r.request().method() === 'PUT'
      ? r.fulfill(json({ id: 'pr-1', retro: 'retro-1', mood: 4, energy: 4, confidence: null, updated_at: '2026-04-15T00:00:00Z' }))
      : r.fulfill({ status: 204, body: '' }));
}

test.describe('Live retro board (#851)', () => {
  test('renders the three columns and posts a new sticky', async ({ page }) => {
    const post = page.waitForRequest(
      (req) => req.url().includes('/retro-board/') && req.method() === 'POST',
    );
    await setup(page, { pulseTrend: { gated: false, energy_declining: false, points: [] } });
    await page.goto(BASE_URL);

    const panel = page.getByRole('region', { name: /Retrospective/i });
    await expect(panel).toBeVisible();
    // Each column label renders in both the mobile segmented control and the desktop
    // column header (and "What went well" a third time, as the default-active mobile
    // column), so assert on the first match rather than tripping strict mode.
    await expect(panel.getByText('What went well').first()).toBeVisible();
    await expect(panel.getByText('What to improve').first()).toBeVisible();
    await expect(panel.getByText('Ideas & discussion').first()).toBeVisible();

    // Add a sticky to the first column (desktop column is the first match).
    await panel.getByRole('button', { name: /\+ Add a card/i }).first().click();
    await panel.getByRole('textbox', { name: /Add a card to What went well/i }).first()
      .fill('Pairing cut the bug in half');
    await page.keyboard.press('Enter');

    const req = await post;
    const body = req.postDataJSON() as Record<string, unknown>;
    expect(body.column).toBe('went_well');
    expect(body.text).toBe('Pairing cut the bug in half');
  });
});

test.describe('Team-health pulse privacy (#923 🔴)', () => {
  test('team member sees the poll and the aggregate trend', async ({ page }) => {
    await setup(page, {
      pulseTrend: {
        gated: false, energy_declining: true,
        points: [{ sprint_id: 's1', sprint_name: 'S1', avg_mood: 3, avg_energy: 2, avg_confidence: 3, response_count: 5 }],
      },
    });
    await page.goto(BASE_URL);

    const panel = page.getByRole('region', { name: /Retrospective/i });
    await expect(panel.getByRole('radiogroup', { name: /^Mood$/i })).toBeVisible();
    await expect(panel.getByText(/Energy down 2 sprints running/i)).toBeVisible();
    await expect(panel.getByText(/5 responded this sprint/i)).toBeVisible();
  });

  test('an above-audience reader sees ONLY the "kept private" wall — no poll, no count', async ({ page }) => {
    await setup(page, { pulseTrend: { gated: true } });
    await page.goto(BASE_URL);

    const panel = page.getByRole('region', { name: /Retrospective/i });
    await expect(panel.getByText(/keeps its health pulse private/i)).toBeVisible();
    // The 🔴: nothing else leaks — no poll, no count, no trend.
    await expect(panel.getByRole('radiogroup', { name: /Mood/i })).toHaveCount(0);
    await expect(panel.getByText(/responded this sprint/i)).toHaveCount(0);
  });
});

import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll, type ProjectFixture } from './fixtures';
import { findClippedContent, formatFindings } from './fixtures/clipped-content';

/**
 * Clipped-content gate (#3166).
 *
 * Asserts one invariant across the primary surfaces: **a container that clips
 * must never hold content taller than itself.** Anything past its bottom edge
 * is painted nowhere and reachable by nothing — no scrollbar, no wheel, no
 * `scrollIntoView` — so the user simply loses it.
 *
 * This exists because the class kept coming back and every previous fix was a
 * fix to one site: #539 (settings at 375px), #2665 (`NewProjectModal` — the
 * Create button clipped off the bottom), #2674 (`ImportModal`, still open), and
 * now #3166 (`ScheduleForecastBar` — 1085px of run history unreachable and the
 * Gantt canvas squeezed to zero height). Four instances, four people noticing by
 * eye, no mechanism. Web rule 300: a rule that has needed a second manual sweep
 * does not have a working mechanism.
 *
 * A short viewport is the point. Every one of those four bugs is invisible at
 * 1080p and obvious at 720p, which is why they reach users and not reviewers —
 * so the sweep runs at 1280×720 and at a phone size, not at whatever the runner
 * defaults to.
 *
 * See `fixtures/clipped-content.ts` for why this is a browser measurement and
 * cannot be a lint rule or a vitest assertion.
 */

const PROJECT_ID = 'e2e-clip-00000000-0000-0000-0000-000000003166';

const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Clipped Content Fixture',
  description: 'Route-coverage fixture for the clipped-content gate.',
  start_date: '2026-01-01',
  calendar: 'default',
};

/** Enough rows that a list-driven surface has something to overflow with. */
const TASKS = Array.from({ length: 24 }, (_, i) => ({
  id: `clip-t${i + 1}`,
  wbs_path: `${i + 1}`,
  name: `Task ${i + 1}`,
  early_start: '2026-01-05',
  early_finish: '2026-01-09',
  planned_start: '2026-01-05',
  duration: 5,
  percent_complete: 0,
  is_critical: i % 3 === 0,
  is_milestone: false,
  is_summary: false,
  status: 'NOT_STARTED',
  optimistic_duration: null,
  pessimistic_duration: null,
  most_likely_duration: null,
  notes: '',
  server_version: 1,
}));

/**
 * A run history long enough to outgrow the forecast bar — the #3166 reproduction.
 * Twelve rows is two past `ForecastHistorySection`'s `INITIAL_VISIBLE` of 10, so
 * the "Show older runs" fold is on screen too.
 */
const MC_HISTORY_RUNS = Array.from({ length: 12 }, (_, i) => ({
  id: `clip-run-${i}`,
  taken_at: `2026-05-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  cpm_finish: '2026-11-30',
  n_simulations: 500,
  task_count: TASKS.length,
  delta: i === 11 ? null : { p50: 1, p80: 1, p95: 1 },
  triggered_by_name: 'P M',
}));

/** Wire shape of `GET /projects/{id}/monte-carlo/latest/`, mirroring
 *  `schedule-monte-carlo.spec.ts`. The field names matter: `mapResponse` throws
 *  on a wrong shape, React Query retries, and the bar sits on "Loading forecast…"
 *  rather than failing — which reads as a missing mock, not a malformed one. */
const MC_RESULT = {
  project_id: PROJECT_ID,
  runs: 500,
  p50: '2026-11-15',
  p80: '2026-12-10',
  p95: '2026-12-28',
  histogram_buckets: [
    { date: '2026-11-02', count: 90 },
    { date: '2026-11-09', count: 120 },
    { date: '2026-11-16', count: 100 },
    { date: '2026-11-23', count: 70 },
    { date: '2026-11-30', count: 45 },
  ],
  // The server states forecast freshness on every branch (#3140). Stated here so the
  // one spec that guards this bar's 1280px layout measures the row production actually
  // renders — an omitted key maps to `unknown`, which adds a Rerun button the server
  // would never have asked for.
  forecast_staleness: 'current',
  plan_version: 1,
  plan_version_current: 1,
  last_run_at: '2026-05-12T10:00:00Z',
  cpm_finish: '2026-11-30',
  delta_vs_cpm: { p50: -15, p80: 10, p95: 28 },
  risk_premium_state: 'premium',
  risk_premium_days: 10,
  risk_premium_ratio: 0.05,
  risk_premium_band: null,
  risk_premium_as_of: '2026-05-12T10:00:00Z',
  risk_premium_reason: null,
  risk_premium_cpm_finish: '2026-11-30',
  risk_premium_p80: '2026-12-10',
  confidence_curve: [
    { date: '2026-11-02', pct: 28 },
    { date: '2026-11-09', pct: 52 },
    { date: '2026-11-16', pct: 72 },
    { date: '2026-11-23', pct: 86 },
    { date: '2026-11-30', pct: 95 },
  ],
  sensitivity: [{ task_id: 'clip-t1', index: 0.88 }],
};

async function setupShell(page: import('@playwright/test').Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID, tasks: TASKS });

  await page.route('**/api/v1/programs/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
  await page.route('**/api/v1/me/timer/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(null) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/latest/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MC_RESULT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/monte-carlo/history/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: MC_HISTORY_RUNS, cap: 100, enabled: true }),
    }),
  );
}

async function expectNoClippedContent(page: import('@playwright/test').Page): Promise<void> {
  const findings = await findClippedContent(page);
  expect(
    findings,
    findings.length
      ? `Content is clipped by an overflow:hidden container and reachable by nothing:\n${formatFindings(findings)}\n\n` +
        'Fix: cap the region and give it its own scroller — ' +
        '`max-h-* overflow-hidden flex flex-col` on the shell, ' +
        '`flex-1 min-h-0 overflow-y-auto` on the body. See web rule 354.'
      : '',
  ).toEqual([]);
}

test.describe('clipped content @clip', () => {
  test.beforeEach(async ({ page }) => {
    await setupShell(page);
    // A laptop-height viewport. Every instance of this class so far has been
    // invisible at 1080p, which is precisely why it kept shipping.
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('the Schedule with an expanded forecast and run history (#3166)', async ({ page }) => {
    // The bar's expanded/collapsed choice is persisted, so a user who expanded it
    // once arrives on this state — no click needed to reach the bug.
    await page.addInitScript(() => {
      localStorage.setItem('schedule.insightsExpanded', 'true');
    });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);

    // Exact — the no-simulation empty state is also a region whose name STARTS
    // with "Schedule forecast", and getByRole's name matching is substring by
    // default, so a loose match silently accepts the empty state and the whole
    // reproduction becomes vacuous.
    const bar = page.getByRole('region', { name: 'Schedule forecast', exact: true });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: /Forecast history/i }).click();
    await expect(bar.getByRole('button', { name: /Show older runs/i })).toBeVisible();

    await expectNoClippedContent(page);

    // The gate above proves nothing is hidden. These prove the content is
    // actually usable, which is the thing the user lost — and they are the
    // assertions that fail if someone "fixes" a future finding by shrinking the
    // content rather than by giving it a scroller.

    // 1. The bar owns its own scroller, and it really has somewhere to scroll.
    const scroll = await bar.evaluate((el) => {
      const body = el.querySelector('#schedule-forecast-panel')!;
      return {
        overflowY: getComputedStyle(body).overflowY,
        scrollable: body.scrollHeight - body.clientHeight,
        barHeight: el.getBoundingClientRect().height,
      };
    });
    expect(scroll.overflowY).toBe('auto');
    expect(scroll.scrollable).toBeGreaterThan(0);
    // 40vh of a 720px viewport. The cap is the whole point: uncapped, this
    // measured 1685px. Asserted as a bound rather than an equality so the design
    // can retune the fraction without a test edit, but never silently lose it.
    expect(scroll.barHeight).toBeLessThanOrEqual(288);

    // 2. The bar must not starve the Gantt. Before the fix the canvas measured
    //    exactly 0px tall — the schedule disappeared to make room for its own
    //    forecast strip.
    const canvasHeight = await page
      .locator('canvas')
      .first()
      .evaluate((c) => c.getBoundingClientRect().height);
    expect(canvasHeight).toBeGreaterThan(0);

    // 3. The oldest run is reachable by scrolling the bar, and lands on screen.
    const oldest = bar.getByRole('button', { name: /Show older runs/i });
    await oldest.scrollIntoViewIfNeeded();
    const box = (await oldest.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
  });

  test('the Schedule at rest', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(
      page.getByRole('region', { name: 'Schedule forecast', exact: true }),
    ).toBeVisible();
    await expectNoClippedContent(page);
  });

  test('project Overview', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoClippedContent(page);
  });

  test('project Board', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/board`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoClippedContent(page);
  });

  test('project Settings', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/settings`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoClippedContent(page);
  });

  test('the app shell at a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    await expect(page.getByRole('banner')).toBeVisible();
    await expectNoClippedContent(page);
  });
});

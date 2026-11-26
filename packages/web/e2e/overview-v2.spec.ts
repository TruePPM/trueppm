/**
 * E2E for the shell v2 Project Overview (#4798) behind `?ff=shell_v2`: one lead
 * figure, supporting tiles, the inline cost-variance line, and the empty and error
 * states of the forecast. Both endpoints are mocked in their real shapes.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { expectNoA11yViolationsBothThemes } from './fixtures/a11y';

const PID = 'e2e-overview-v2-00000000-0000-0000-0000-000000000098';

const OVERVIEW = {
  schedule_health: 'on_track',
  spi: 0.97,
  tasks_late_count: 1,
  critical_task_count: 3,
  total_tasks: 20,
  complete_tasks: 8,
  next_milestone: { id: 'm1', name: 'Beta release', date: '2026-12-01', percent_complete: 40 },
  team_utilization_pct: 70,
  team_utilization_reason: null,
  owner_name: 'Pat',
  start_date: '2026-01-01',
  open_risk_count: 5,
  high_risk_count: 2,
  as_of: '2026-11-20T09:12:00Z',
  definitions: {
    schedule_health: 'Server schedule sentence.',
    open_risk_count: 'Server open risks sentence.',
    team_utilization_pct: 'Server utilization sentence.',
  },
};

const MC = {
  project_id: PID,
  n_simulations: 5000,
  runs: 5000,
  p50: '2026-12-01',
  p80: '2026-12-07',
  p95: '2026-12-15',
  histogram_buckets: [],
  last_run_at: '2026-11-20T09:12:00Z',
  cpm_finish: '2026-11-28',
  commitment_date: '2026-12-05',
  p80_delta_vs_commitment_days: 2,
  confidence_curve: [
    { date: '2026-11-28', pct: 10 },
    { date: '2026-12-01', pct: 50 },
    { date: '2026-12-07', pct: 80 },
    { date: '2026-12-15', pct: 95 },
  ],
  definitions: { p80: 'Server P80 sentence.' },
};

type Forecast = 'ready' | 'none' | 'error' | 'stale';

async function open(page: Page, forecast: Forecast) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    tasks: [{ id: 't9', project: PID, name: 'Pour foundation' }],
  });
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  // The shell's project detail read: without it the shell swaps the page for "project unavailable".
  await page.route(`**/api/v1/projects/${PID}/`, (r) =>
    r.fulfill(
      json({
        id: PID,
        name: 'Overview V2 Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        health: 'AUTO',
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PID}/members/**`, (r) =>
    r.fulfill(json([{ id: 'self', role: 300 }])),
  );
  await page.route(`**/api/v1/projects/${PID}/overview/`, (r) => r.fulfill(json(OVERVIEW)));
  await page.route(`**/api/v1/projects/${PID}/monte-carlo/latest/`, (r) =>
    forecast === 'ready'
      ? r.fulfill(json(MC))
      : forecast === 'stale'
        ? r.fulfill(
            json({
              ...MC,
              forecast_staleness: 'project_changed',
              sensitivity: [{ task_id: 't9', index: 0.9 }],
            }),
          )
        : forecast === 'none'
          ? r.fulfill(json({ detail: 'No simulation result available.' }, 404))
          : r.fulfill(json({ detail: 'boom' }, 500)),
  );
  await page.route(`**/api/v1/projects/${PID}/monte-carlo/history/`, (r) =>
    r.fulfill(
      json({
        cap: 20,
        results: [
          {
            id: 'r2',
            taken_at: '2026-11-20T09:12:00Z',
            p50: '2026-12-01',
            p80: '2026-12-07',
            p95: '2026-12-15',
            cpm_finish: '2026-11-28',
            n_simulations: 5000,
            task_count: 20,
            delta: null,
            triggered_by_name: null,
          },
          {
            id: 'r1',
            taken_at: '2026-11-13T09:12:00Z',
            p50: '2026-11-28',
            p80: '2026-12-03',
            p95: '2026-12-10',
            cpm_finish: '2026-11-25',
            n_simulations: 5000,
            task_count: 20,
            delta: null,
            triggered_by_name: null,
          },
        ],
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PID}/status-updates/**`, (r) =>
    r.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.goto(`/projects/${PID}/overview?ff=shell_v2`);
  await expect(page.getByTestId('overview2')).toBeVisible({ timeout: 10_000 });
}

test.describe('shell v2 project overview', () => {
  test('golden path: one lead figure, tiles, inline cost line', async ({ page }) => {
    await open(page, 'ready');
    await expect(page.getByTestId('overview2-lead-figure').locator('.sr-only')).toHaveText(
      /^Forecast finish P80, .*2026.*, as of /,
    );
    await expect(page.getByTestId('overview2-commitment-chip')).toContainText(
      '+2d past commitment',
    );
    await expect(page.getByTestId('overview2-lead-footer')).toContainText('5,000 runs');
    await expect(page.getByTestId('overview2-tile')).toHaveCount(3);
    await expect(page.getByTestId('not-computable')).toContainText('Cost variance');
    await expect(page.getByRole('link', { name: 'Why this date?' })).toBeVisible();
  });

  test('empty state when there is no forecast', async ({ page }) => {
    await open(page, 'none');
    await expect(page.getByTestId('overview2-empty')).toContainText('No forecast yet');
    await expect(page.getByTestId('overview2-tiles')).toBeVisible();
  });

  test('error state keeps the tiles', async ({ page }) => {
    await open(page, 'error');
    await expect(page.getByText(/Forecast didn’t finish/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('overview2-tiles')).toBeVisible();
  });

  test('staleness caveat is spoken with the lead figure; driver and moved-from show (#5104)', async ({
    page,
  }, testInfo) => {
    await open(page, 'stale');
    await expect(page.getByTestId('overview2-lead-figure').locator('.sr-only')).toHaveText(
      /Edited since this run$/,
    );
    await expect(page.getByTestId('overview2-staleness')).toContainText('◆ Edited since this run');
    await expect(page.getByTestId('overview2-driver')).toContainText(
      'Biggest driver: Pour foundation',
    );
    await expect(page.getByTestId('overview2-moved')).toContainText('moved from');
    await expectNoA11yViolationsBothThemes(page, testInfo);
  });
  test.describe('phone layout (#5104)', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('lead card, tiles and cost line fit one column with 44px targets; axe clean in both themes', async ({
      page,
    }, testInfo) => {
      await open(page, 'stale');
      await expect(page.getByTestId('overview2-lead')).toHaveAttribute('data-layout', 'phone');
      const svg = page.getByTestId('overview2-lead').locator('svg[viewBox]');
      await expect(svg).toBeVisible();
      // The S-curve is drawn at the phone size, not the 640-wide desktop viewBox scaled down.
      await expect(svg).toHaveAttribute('viewBox', /^0 0 340 220$/);
      // TODO(#5148): screenshot baselines (CI image, both themes) go here.
      await expect(page.getByTestId('overview2-tile')).toHaveCount(3);
      await expect(page.getByTestId('not-computable')).toContainText('Cost variance');
      const why = await page.getByRole('link', { name: /Why this date\?/ }).boundingBox();
      expect(why?.height ?? 0).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await expectNoA11yViolationsBothThemes(page, testInfo);
    });
  });
});

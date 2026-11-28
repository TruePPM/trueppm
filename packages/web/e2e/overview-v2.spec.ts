/**
 * E2E for the shell v2 Project Overview (#4798) behind `?ff=shell_v2`: one lead
 * figure, supporting tiles, the inline cost-variance line, and the empty and error
 * states of the forecast. Both endpoints are mocked in their real shapes.
 *
 * Screenshot baselines (#5148) are Linux/Chromium; they are skipped on other
 * platforms because font rasterization differs by OS. Regenerate inside the CI
 * Playwright image (`PLAYWRIGHT_BASE_TAG` in `.gitlab-ci.yml`) with
 * `--update-snapshots`, never on the host OS.
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
  next_milestone: {
    id: 'm1',
    name: 'Beta release',
    date: '2026-12-01',
    percent_complete: 40,
    baseline_date: '2026-11-27',
    total_float: 0,
  },
  team_utilization_pct: 70,
  team_utilization_reason: null,
  owner_name: 'Pat',
  start_date: '2026-01-01',
  open_risk_count: 5,
  high_risk_count: 2,
  over_allocated_count: 2,
  over_allocated_reason: null,
  over_allocated_window: { start: '2026-11-16', end: '2027-01-10' },
  changes_since: '2026-11-16T00:00:00Z',
  as_of: '2026-11-20T09:12:00Z',
  definitions: {
    schedule_health: 'Server schedule sentence.',
    open_risk_count: 'Server open risks sentence.',
    team_utilization_pct: 'Server utilization sentence.',
    over_allocated_count: 'Server over-allocation sentence.',
    changes_since: 'Server changes sentence.',
  },
};

const CHANGELOG = {
  results: [
    {
      id: 'c1',
      object_type: 'task',
      object_kind: 'milestone',
      object_kind_label: 'Milestone',
      object_id: 'm1',
      object_label: 'Beta release',
      change_type: 'updated',
      history_date: '2026-11-18T10:00:00Z',
      user: null,
      changes: [],
    },
  ],
  next_cursor: null,
};

const node = (
  task_id: string,
  name: string,
  direction: 'self' | 'upstream' | 'downstream',
  hops: number,
  is_project_finish = false,
) => ({
  task_id,
  name,
  status: 'not_started',
  direction,
  hops,
  early_start: '2026-11-20',
  early_finish: '2026-11-30',
  total_float: { value: 0, unit: 'working_days' },
  band: 'critical',
  is_critical: true,
  is_project_finish,
  sprint: null,
});

const CHAIN = {
  schema_version: 1,
  project_id: PID,
  task_id: 't9',
  computable: true,
  reason: null,
  project_finish: '2026-12-07',
  depth: 25,
  node_cap: 200,
  truncated: false,
  truncated_reason: null,
  total_links: 2,
  omitted_non_driving_count: 0,
  near_critical_threshold: { value: 5, unit: 'working_days' },
  calendar_id: null,
  nodes: [
    node('fin', 'Handover', 'downstream', 1, true),
    node('t9', 'Pour foundation', 'self', 0),
    node('up', 'Permits', 'upstream', 1),
  ],
  edges: [],
  _provenance: {
    schema_version: 1,
    engine_version: '1.0.0',
    api_version: '1',
    input_hash: 'abc',
    computed_at: '2026-11-20T09:12:00Z',
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
  await page.route(`**/api/v1/projects/${PID}/status-summary/`, (r) =>
    r.fulfill(
      json({
        task_count: 20,
        health_band: 'on_track',
        health_band_source: 'derived',
        monte_carlo_p80: '2026-12-07',
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        blocked_count: 0,
        last_saved: null,
        recalculated_at: null,
        as_of: '2026-11-20T09:12:00Z',
        definitions: {},
      }),
    ),
  );
  // Shell reads and the visit beacon around the page: real shapes, not the catch-all 404.
  await page.route(`**/api/v1/projects/${PID}/views/`, (r) =>
    r.fulfill(
      json({
        views: [],
        lens: 'pm',
        seeded_lens: null,
        seed_line: null,
        lens_offer: null,
        landing: null,
        last_layouts: {},
      }),
    ),
  );
  await page.route(`**/api/v1/projects/${PID}/visit/`, (r) => r.fulfill(json({ recorded: true })));
  await page.route('**/api/v1/workspace/', (r) =>
    r.fulfill(json({ name: 'E2E', subdomain: 'e2e', public_sharing: false })),
  );
  await page.route(`**/api/v1/projects/${PID}/changelog/**`, (r) => r.fulfill(json(CHANGELOG)));
  await page.route(`**/api/v1/projects/${PID}/schedule/driving-chain/**`, (r) =>
    r.fulfill(json(CHAIN)),
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
    await expect(page.getByTestId('overview2-tile')).toHaveCount(4);
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
  test('over-allocated tile, changes since Monday and the driver chain (#5103)', async ({
    page,
  }, testInfo) => {
    await open(page, 'stale');
    await expect(page.getByTestId('overview2-tiles')).toContainText('Over-allocated');
    await expect(page.getByTestId('overview2-tiles')).toContainText('people through');
    const changes = page.getByTestId('overview2-changes');
    await expect(changes).toContainText('Beta release');
    await expect(changes).toContainText('changed');
    const toggle = page.getByTestId('overview2-chain-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const chain = page.getByTestId('overview2-driver-chain');
    await expect(chain.getByRole('listitem').first()).toContainText('Permits');
    await expect(chain).toContainText('project finish');
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
      await expect(page.getByTestId('overview2-tile')).toHaveCount(4);
      await expect(page.getByTestId('not-computable')).toContainText('Cost variance');
      const why = await page.getByRole('link', { name: /Why this date\?/ }).boundingBox();
      expect(why?.height ?? 0).toBeGreaterThanOrEqual(44);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await expectNoA11yViolationsBothThemes(page, testInfo);
      // Each peer date holds one line, down to a 360px phone, without sideways scroll.
      for (const width of [390, 360]) {
        await page.setViewportSize({ width, height: 844 });
        const lines = await page
          .getByTestId('overview2-peer-date')
          .evaluateAll((els) =>
            els.map((el) => el.clientHeight / Number.parseFloat(getComputedStyle(el).lineHeight)),
          );
        expect(lines, `peer date lines at ${width}px`).toEqual([1, 1, 1]);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        ).toBeLessThanOrEqual(0);
      }
    });
  });
});

// The clock, zone and locale are pinned so "as of" and date text never drift.
test.describe('shell v2 project overview screenshots (#5148)', () => {
  test.skip(process.platform !== 'linux', 'baselines are Linux/Chromium (CI image)');
  test.use({ timezoneId: 'UTC', locale: 'en-US' });

  async function openForShot(page: Page, theme: 'light' | 'dark') {
    await page.clock.setFixedTime(new Date('2026-11-20T12:00:00Z'));
    await page.addInitScript((t) => localStorage.setItem('trueppm.theme', t), theme);
    await page.emulateMedia({ colorScheme: theme });
    await open(page, 'stale');
    // Every read that paints into the shot has landed, including the idle-deferred history.
    await expect(page.getByTestId('overview2-lead-figure')).toBeVisible();
    await expect(page.getByTestId('overview2-driver')).toContainText('Pour foundation');
    await expect(page.getByTestId('overview2-moved')).toBeVisible();
    await expect(page.getByTestId('overview2-tile')).toHaveCount(4);
    await expect(page.getByTestId('overview2-milestone-facts')).toContainText('Float');
    await expect(page.getByTestId('status-updates-empty')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
    await page.evaluate(() => document.fonts.ready);
  }

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${theme} theme`, () => {
      test.describe('desktop', () => {
        // Tall enough that the page content never needs to scroll inside the shell.
        test.use({ viewport: { width: 1440, height: 1500 } });
        test('overview content', async ({ page }) => {
          await openForShot(page, theme);
          await expect(page.getByTestId('overview2')).toHaveScreenshot(
            `overview2-1440-${theme}.png`,
            { animations: 'disabled' },
          );
        });
      });

      test.describe('phone', () => {
        // Phone width; extra height keeps the fixed bottom bar off the card.
        test.use({ viewport: { width: 390, height: 1100 } });
        test('lead card', async ({ page }) => {
          await openForShot(page, theme);
          const lead = page.getByTestId('overview2-lead');
          await expect(lead).toHaveAttribute('data-layout', 'phone');
          await expect(lead).toHaveScreenshot(`overview2-lead-390-${theme}.png`, {
            animations: 'disabled',
          });
        });
      });
    });
  }
});

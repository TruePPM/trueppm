/**
 * Flow analytics on the board E2E (issue 1188 / ADR-0137).
 *
 * Covers the collapsed-by-default flow panel (expand → charts + legible privacy
 * caption) and the always-on per-column WIP breach chip. flow-metrics is overridden
 * with populated data; a low IN_PROGRESS wip_limit forces a breach.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-flow-00000000-0000-0000-0000-000000000088';
const BASE_URL = `/projects/${PROJECT_ID}`;

const TASKS = [
  {
    id: 'f1', wbs_path: '1', name: 'Build', early_start: '2026-01-05',
    early_finish: '2026-01-16', planned_start: '2026-01-05', duration: 10,
    percent_complete: 40, is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'f2', wbs_path: '2', name: 'Refactor', early_start: '2026-01-06',
    early_finish: '2026-01-17', planned_start: '2026-01-06', duration: 10,
    percent_complete: 20, is_critical: false, is_milestone: false, is_summary: false,
    parent_id: null, status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

const POPULATED_FLOW = {
  window_days: 90,
  since: '2026-04-01',
  until: '2026-06-30',
  cycle_time: { p50: 4, p80: 7, p95: 12 },
  lead_time: { p50: 9, p80: 14, p95: 21 },
  cfd: [
    { date: '2026-06-29', counts: { BACKLOG: 5, NOT_STARTED: 3, IN_PROGRESS: 2, REVIEW: 1, COMPLETE: 24 } },
    { date: '2026-06-30', counts: { BACKLOG: 4, NOT_STARTED: 3, IN_PROGRESS: 2, REVIEW: 1, COMPLETE: 26 } },
  ],
  throughput: [
    { week_start: '2026-06-15', completed_count: 6 },
    { week_start: '2026-06-22', completed_count: 9 },
  ],
  data_integrity: { bulk_moved_count: 0, backdated_count: 0, missing_transition_count: 0 },
  flow_metrics_suppressed: false,
};

/**
 * A CFD whose IN_PROGRESS column climbs 0→2 over four days (issue 1213). With the
 * IN_PROGRESS wip_limit of 1 in this board config, the latest count is above the
 * limit and rising → the header shows a rising, at-risk WIP-creep trend arrow.
 */
const RISING_FLOW = {
  ...POPULATED_FLOW,
  cfd: [
    { date: '2026-06-27', counts: { BACKLOG: 5, NOT_STARTED: 3, IN_PROGRESS: 0, REVIEW: 0, COMPLETE: 20 } },
    { date: '2026-06-28', counts: { BACKLOG: 5, NOT_STARTED: 3, IN_PROGRESS: 0, REVIEW: 1, COMPLETE: 22 } },
    { date: '2026-06-29', counts: { BACKLOG: 5, NOT_STARTED: 3, IN_PROGRESS: 1, REVIEW: 2, COMPLETE: 24 } },
    { date: '2026-06-30', counts: { BACKLOG: 4, NOT_STARTED: 3, IN_PROGRESS: 2, REVIEW: 3, COMPLETE: 26 } },
  ],
};

/** A ready throughput-basis forecast (ADR-0130 D3). Dates are fixed; the board frames
 * P80 as "~N weeks" relative to the wall clock, so the spec asserts the pattern (not a
 * fixed count) — the card stays "ready" regardless of when the suite runs. */
const FORECAST_THROUGHPUT_READY = {
  status: 'ready',
  remaining_points: null,
  remaining_count: 18,
  sample_count: 8,
  p50_sprints: null,
  p80_sprints: null,
  p50_date: '2026-12-15',
  p80_date: '2026-12-29',
  p95_date: '2027-01-12',
  basis: 'monte_carlo',
  forecast_basis: 'throughput',
  velocity_suppressed: false,
};

interface SetupOpts {
  cadence?: 'sprint' | 'continuous';
  forecast?: Record<string, unknown>;
}

async function setup(
  page: import('@playwright/test').Page,
  flow = POPULATED_FLOW,
  opts: SetupOpts = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: PROJECT_ID,
        name: 'Flow Project',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
        board_cadence: opts.cadence ?? 'sprint',
      },
    ],
    projectId: PROJECT_ID,
    tasks: TASKS,
    statusSummary: { task_count: 2 },
    // IN_PROGRESS limit of 1 with two in-progress cards → an over-limit breach.
    boardConfig: {
      columns: [
        { status: 'BACKLOG', label: 'Backlog', visible: true, wip_limit: null, color: '#94A3B8' },
        { status: 'NOT_STARTED', label: 'To Do', visible: true, wip_limit: null, color: '#64748B' },
        { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: 1, color: '#3B82F6' },
        { status: 'REVIEW', label: 'Review', visible: true, wip_limit: 3, color: '#A855F7' },
        { status: 'COMPLETE', label: 'Done', visible: true, wip_limit: null, color: '#22C55E' },
      ],
    },
  });
  await page.route(`**/api/v1/projects/${PROJECT_ID}/flow-metrics/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(flow) }),
  );
  // Per-spec override wins over the setupApiMocks default warming-up forecast.
  if (opts.forecast) {
    await page.route(`**/api/v1/projects/${PROJECT_ID}/sprint-forecast/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.forecast) }),
    );
  }
}

test.describe('Flow analytics on the board', () => {
  test('the flow panel is collapsed by default and expands to charts + privacy caption', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });

    const toggle = page.getByTestId('flow-analytics-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('flow-analytics-body')).toHaveCount(0);

    await toggle.click();
    await expect(page.getByTestId('flow-analytics-charts')).toBeVisible();
    await expect(page.getByText(/aggregate only — no individual breakdown/i)).toBeVisible();
    await expect(page.getByTestId('cycle-lead-strip')).toBeVisible();
  });

  test('renders the content-free wall when flow metrics are suppressed', async ({ page }) => {
    await setup(page, { ...POPULATED_FLOW, flow_metrics_suppressed: true });
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('flow-analytics-toggle').click();
    await expect(page.getByTestId('flow-metrics-suppressed')).toBeVisible();
    await expect(page.getByTestId('flow-analytics-charts')).toHaveCount(0);
  });

  test('an over-limit column shows the always-on WIP breach chip', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    // The chip is independent of the "Show WIP limits" toggle.
    await expect(page.getByTestId('wip-breach-chip').first()).toBeVisible();
  });

  test('a column creeping toward its WIP limit shows the trend arrow (issue 1213)', async ({ page }) => {
    await setup(page, RISING_FLOW);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    const arrow = page.getByTestId('wip-trend-arrow').first();
    await expect(arrow).toBeVisible();
    await expect(arrow).toHaveAttribute('data-trend', 'rising');
    // Direction is carried by the glyph + accessible name, not color alone (WCAG 1.4.1).
    await expect(arrow).toHaveAccessibleName('trending up toward WIP limit');
  });

  test('the trend arrow is hidden when flow metrics are suppressed (issue 1213 / ADR-0104)', async ({ page }) => {
    // Same rising CFD, but the reader is below the flow_metrics audience — the
    // team-private trend must not leak even though the breach chip stays visible.
    await setup(page, { ...RISING_FLOW, flow_metrics_suppressed: true });
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('wip-trend-arrow')).toHaveCount(0);
    // The current-state breach chip is member-visible independent of suppression (ADR-0130 D2).
    await expect(page.getByTestId('wip-breach-chip').first()).toBeVisible();
  });

  test('a continuous-cadence board headlines the throughput forecast (issue 1280)', async ({ page }) => {
    await setup(page, POPULATED_FLOW, { cadence: 'continuous', forecast: FORECAST_THROUGHPUT_READY });
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('flow-analytics-toggle').click();
    const card = page.getByTestId('throughput-forecast-ready');
    await expect(card).toBeVisible();
    // P80 framed forward as "~N weeks" + the (P80) marker, plus the remaining scope.
    await expect(card).toContainText(/~\s*\d+\s*weeks?/);
    await expect(card).toContainText('(P80)');
    await expect(card).toContainText('18');
  });

  test('a sprint-cadence board shows no throughput forecast card (unaffected)', async ({ page }) => {
    // Even with a ready throughput forecast available, a sprint board keeps its
    // velocity forecast elsewhere and never mounts this card.
    await setup(page, POPULATED_FLOW, { cadence: 'sprint', forecast: FORECAST_THROUGHPUT_READY });
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('flow-analytics-toggle').click();
    await expect(page.getByTestId('flow-analytics-charts')).toBeVisible();
    await expect(page.getByTestId('throughput-forecast')).toHaveCount(0);
  });
});

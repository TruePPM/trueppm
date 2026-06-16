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

async function setup(page: import('@playwright/test').Page, flow = POPULATED_FLOW) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [{ id: PROJECT_ID, name: 'Flow Project', description: '', start_date: '2026-01-01', calendar: 'default' }],
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
});

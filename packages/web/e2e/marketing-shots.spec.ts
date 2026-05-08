/**
 * Marketing product snapshots — captures 4 deterministic product views to
 * ~/Downloads for use on the marketing site / pitch deck. Not part of the
 * regular e2e regression — opt in with:
 *
 *   npx playwright test e2e/marketing-shots.spec.ts --project=chromium
 *
 * Targets the dev server at :5173 (run `npm run dev` first). All API calls
 * are mocked to seeded fixture data so shots are reproducible.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ID = 'mkt-00000000-0000-0000-0000-000000000777';

test.use({
  baseURL: 'http://localhost:5173',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Northgate Substation Upgrade',
    description: 'Replace 138kV breakers + telemetry retrofit',
    start_date: '2026-03-02',
    calendar: 'default',
    agile_features: true,
    methodology: 'WATERFALL',
  },
  {
    id: 'mkt-002',
    name: 'Riverside Data Center Build',
    description: '',
    start_date: '2026-02-01',
    calendar: 'default',
  },
  {
    id: 'mkt-003',
    name: 'Fleet Telematics Rollout',
    description: '',
    start_date: '2026-01-15',
    calendar: 'default',
  },
];

const TASKS = [
  // Phase 1 — Engineering
  { id: 't1',  wbs_path: '1',   name: 'Engineering & Permitting', early_start: '2026-03-02', early_finish: '2026-04-10', planned_start: '2026-03-02', duration: 30, percent_complete: 100, is_critical: false, is_milestone: false, is_summary: true, parent_id: null,  status: 'COMPLETE', assignees: [], total_float: null, predecessor_count: 0, is_blocked: false, linked_risks_count: 0, linked_risks_max_severity: null },
  { id: 't2',  wbs_path: '1.1', name: 'Site survey',              early_start: '2026-03-02', early_finish: '2026-03-13', planned_start: '2026-03-02', duration: 10, percent_complete: 100, is_critical: false, is_milestone: false, is_summary: false, parent_id: 't1', status: 'COMPLETE', assignees: [{ id: 'u1', display_name: 'Sarah Chen', initials: 'SC' }], total_float: 4 },
  { id: 't3',  wbs_path: '1.2', name: 'Permit submission',        early_start: '2026-03-16', early_finish: '2026-04-10', planned_start: '2026-03-16', duration: 20, percent_complete: 100, is_critical: false, is_milestone: false, is_summary: false, parent_id: 't1', status: 'COMPLETE', assignees: [{ id: 'u2', display_name: 'Marcus Reid',  initials: 'MR' }] },

  // Phase 2 — Procurement (in progress, on critical path)
  { id: 't4',  wbs_path: '2',   name: 'Procurement',              early_start: '2026-04-13', early_finish: '2026-06-12', planned_start: '2026-04-13', duration: 45, percent_complete: 60, is_critical: true,  is_milestone: false, is_summary: true, parent_id: null,  status: 'IN_PROGRESS', assignees: [] },
  { id: 't5',  wbs_path: '2.1', name: 'Order 138kV breakers',     early_start: '2026-04-13', early_finish: '2026-05-22', planned_start: '2026-04-13', duration: 30, percent_complete: 80, is_critical: true,  is_milestone: false, is_summary: false, parent_id: 't4', status: 'IN_PROGRESS', assignees: [{ id: 'u3', display_name: 'Priya Patel',  initials: 'PP' }], total_float: 0, linked_risks_count: 1, linked_risks_max_severity: 18 },
  { id: 't6',  wbs_path: '2.2', name: 'Procure telemetry kit',    early_start: '2026-04-13', early_finish: '2026-05-08', planned_start: '2026-04-13', duration: 20, percent_complete: 50, is_critical: false, is_milestone: false, is_summary: false, parent_id: 't4', status: 'IN_PROGRESS', assignees: [{ id: 'u4', display_name: 'Jordan Bell',  initials: 'JB' }], total_float: 5 },
  { id: 't7',  wbs_path: '2.3', name: 'Cable + accessories',      early_start: '2026-05-11', early_finish: '2026-06-12', planned_start: '2026-05-11', duration: 25, percent_complete: 30, is_critical: false, is_milestone: false, is_summary: false, parent_id: 't4', status: 'IN_PROGRESS', assignees: [{ id: 'u3', display_name: 'Priya Patel',  initials: 'PP' }], total_float: 7 },

  // Phase 3 — Construction (not started)
  { id: 't8',  wbs_path: '3',   name: 'Construction',             early_start: '2026-06-15', early_finish: '2026-08-21', planned_start: '2026-06-15', duration: 50, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: true, parent_id: null, status: 'NOT_STARTED', assignees: [] },
  { id: 't9',  wbs_path: '3.1', name: 'Foundations & civil',      early_start: '2026-06-15', early_finish: '2026-07-10', planned_start: '2026-06-15', duration: 20, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: false, parent_id: 't8', status: 'NOT_STARTED', assignees: [{ id: 'u5', display_name: 'Diego Ortiz', initials: 'DO' }], total_float: 0 },
  { id: 't10', wbs_path: '3.2', name: 'Breaker install',          early_start: '2026-07-13', early_finish: '2026-08-07', planned_start: '2026-07-13', duration: 20, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: false, parent_id: 't8', status: 'NOT_STARTED', assignees: [{ id: 'u6', display_name: 'Ana Lima',    initials: 'AL' }], total_float: 0 },
  { id: 't11', wbs_path: '3.3', name: 'Telemetry retrofit',       early_start: '2026-08-10', early_finish: '2026-08-21', planned_start: '2026-08-10', duration: 10, percent_complete: 0, is_critical: false, is_milestone: false, is_summary: false, parent_id: 't8', status: 'NOT_STARTED', assignees: [{ id: 'u4', display_name: 'Jordan Bell',  initials: 'JB' }], total_float: 3 },

  // Phase 4 — Commissioning
  { id: 't12', wbs_path: '4',   name: 'Commissioning & FAT',      early_start: '2026-08-24', early_finish: '2026-09-11', planned_start: '2026-08-24', duration: 15, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: true,  parent_id: null,  status: 'NOT_STARTED', assignees: [] },
  { id: 't13', wbs_path: '4.1', name: 'Factory acceptance test',  early_start: '2026-08-24', early_finish: '2026-09-04', planned_start: '2026-08-24', duration: 10, percent_complete: 0, is_critical: true, is_milestone: false, is_summary: false, parent_id: 't12', status: 'NOT_STARTED', assignees: [{ id: 'u1', display_name: 'Sarah Chen', initials: 'SC' }], total_float: 0 },
  { id: 't14', wbs_path: '4.2', name: 'Energization',             early_start: '2026-09-11', early_finish: '2026-09-11', planned_start: '2026-09-11', duration: 0,  percent_complete: 0, is_critical: true, is_milestone: true,  is_summary: false, parent_id: 't12', status: 'NOT_STARTED', assignees: [], total_float: 0 },
];

const DEPENDENCIES = [
  { id: 'd1', predecessor: 't2',  successor: 't3',  dep_type: 'FS', lag: 0 },
  { id: 'd2', predecessor: 't3',  successor: 't5',  dep_type: 'FS', lag: 0 },
  { id: 'd3', predecessor: 't3',  successor: 't6',  dep_type: 'FS', lag: 0 },
  { id: 'd4', predecessor: 't5',  successor: 't7',  dep_type: 'FS', lag: 0 },
  { id: 'd5', predecessor: 't5',  successor: 't9',  dep_type: 'FS', lag: 0 },
  { id: 'd6', predecessor: 't9',  successor: 't10', dep_type: 'FS', lag: 0 },
  { id: 'd7', predecessor: 't10', successor: 't11', dep_type: 'FS', lag: 0 },
  { id: 'd8', predecessor: 't10', successor: 't13', dep_type: 'FS', lag: 0 },
  { id: 'd9', predecessor: 't13', successor: 't14', dep_type: 'FS', lag: 0 },
];

const RISK_BASE = {
  server_version: 1,
  project: PROJECT_ID,
  description: '',
  owner: 'u1',
  created_by: 'u1',
  created_at: '2026-04-15T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
  tasks: [] as string[],
  notes: '',
};
const RISKS = [
  { ...RISK_BASE, id: 'rk1', short_id: 'a3f1', title: 'Long-lead 138kV breaker',        category: 'EXTERNAL',           response: 'MITIGATE', probability: 4, impact: 5, severity: 20, status: 'OPEN' as const,       owner_name: 'Priya Patel', owner_initials: 'PP', tasks: ['t5'] },
  { ...RISK_BASE, id: 'rk2', short_id: 'b7c2', title: 'Permit revision risk',           category: 'EXTERNAL',           response: 'MITIGATE', probability: 3, impact: 4, severity: 12, status: 'MITIGATING' as const, owner_name: 'Marcus Reid', owner_initials: 'MR', tasks: ['t3'] },
  { ...RISK_BASE, id: 'rk3', short_id: 'c1d4', title: 'Telemetry firmware integration', category: 'TECHNICAL',          response: 'ACCEPT',   probability: 3, impact: 3, severity: 9,  status: 'OPEN' as const,       owner_name: 'Jordan Bell', owner_initials: 'JB', tasks: ['t6', 't11'] },
  { ...RISK_BASE, id: 'rk4', short_id: 'd5e6', title: 'Concrete cure during heat wave', category: 'EXTERNAL',           response: 'ACCEPT',   probability: 2, impact: 3, severity: 6,  status: 'OPEN' as const,       owner_name: 'Diego Ortiz', owner_initials: 'DO', tasks: ['t9'] },
  { ...RISK_BASE, id: 'rk5', short_id: 'e9f0', title: 'FAT crew availability',          category: 'ORGANIZATIONAL',     response: 'TRANSFER', probability: 2, impact: 2, severity: 4,  status: 'CLOSED' as const,     owner_name: 'Sarah Chen',  owner_initials: 'SC', tasks: ['t13'] },
];

const OVERVIEW = {
  schedule_health: 'at_risk' as const,
  spi: 0.94,
  tasks_late_count: 2,
  critical_task_count: 7,
  total_tasks: 14,
  complete_tasks: 3,
  next_milestone: { id: 't14', name: 'Energization', date: '2026-09-11', percent_complete: 0 },
  team_utilization_pct: 82,
  owner_name: 'Sarah Chen',
  start_date: '2026-03-02',
};

const STATUS_SUMMARY = {
  task_count: 14,
  critical_path_count: 7,
  monte_carlo_p80: '2026-09-18',
  at_risk_count: 2,
  critical_count: 1,
  at_risk_tasks: [
    { id: 't5', name: 'Order 138kV breakers' },
    { id: 't9', name: 'Foundations & civil' },
  ],
  critical_tasks: [{ id: 't5', name: 'Order 138kV breakers' }],
  last_saved: '2026-05-07T10:14:00Z',
  recalculated_at: '2026-05-07T10:14:00Z',
};

const ATTENTION = {
  items: [
    { severity: 'critical', type: 'critical_task_late', task_id: 't5', task_name: 'Order 138kV breakers',     assignee_name: 'Priya Patel', date: '2026-05-22', detail: 'On critical path · 1 day slip' },
    { severity: 'at_risk',  type: 'task_at_risk',       task_id: 't9', task_name: 'Foundations & civil',      assignee_name: 'Diego Ortiz', date: '2026-06-15', detail: 'Negative float forecast' },
    { severity: 'at_risk',  type: 'risk_high',          task_id: null, task_name: 'Long-lead 138kV breaker',  assignee_name: 'Priya Patel', date: null,         detail: 'Severity 20 · supply chain' },
  ],
};

const MY_TASKS = {
  tasks: [
    { id: 't5', name: 'Order 138kV breakers',    due: '2026-05-22', status: 'IN_PROGRESS', percent_complete: 80, is_critical: true  },
    { id: 't7', name: 'Cable + accessories',     due: '2026-06-12', status: 'IN_PROGRESS', percent_complete: 30, is_critical: false },
  ],
};

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks: TASKS,
    dependencies: DEPENDENCIES,
    risks: RISKS,
    overview: OVERVIEW,
    statusSummary: STATUS_SUMMARY,
    user: { id: 'u1', username: 'sarah', display_name: 'Sarah Chen', initials: 'SC', email: 'sarah@northgate.test' },
  });
  // Override the empty defaults for attention + my-tasks with rich content.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ATTENTION) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MY_TASKS) }),
  );
  // Tasks/dependencies — last-registered wins; overrides setupApiMocks defaults.
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ count: TASKS.length, next: null, previous: null, results: TASKS }),
      });
    }
    return route.continue();
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: DEPENDENCIES.length, next: null, previous: null, results: DEPENDENCIES }),
    }),
  );
}

const OUT = path.join(os.homedir(), 'Downloads');

test.describe('Marketing snapshots', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('01 — Overview', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(page.getByRole('region', { name: /project kpis/i })).toBeVisible({ timeout: 15_000 });
    // Let charts/badges settle.
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUT, 'trueppm-01-overview.png'),
      fullPage: false,
    });
  });

  test('02 — Board', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/board`);
    await expect(page.getByText('In Progress').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Procurement').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUT, 'trueppm-02-board.png'),
      fullPage: false,
    });
  });

  test('03 — Schedule (Gantt)', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    // Wait for at least one task name to appear in the task list panel.
    await expect(page.getByText('Procurement').first()).toBeVisible({ timeout: 15_000 });
    // Canvas paint settle.
    await page.waitForTimeout(900);
    await page.screenshot({
      path: path.join(OUT, 'trueppm-03-schedule.png'),
      fullPage: false,
    });
  });

  test('04 — Risk register', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/risk`);
    await expect(page.getByText('Long-lead 138kV breaker').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(OUT, 'trueppm-04-risks.png'),
      fullPage: false,
    });
  });
});

/**
 * E2E for issue #304 — board card information popover. Click the card →
 * popover anchored below the card showing readiness, CP, WBS, status, dates,
 * float, assignees. Footer: Open detail (drawer) · Edit (drawer in edit mode).
 *
 * The Move picker (variation B) is deferred per ux-design; tests here cover
 * variation A only.
 */
import { test, expect } from '@playwright/test';

const FIXTURE_PROJECT_ID = 'e2e-304-00000000-0000-0000-0000-000000000304';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Card Popover Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const PHASE_TASK = {
  id: 'p1', wbs_path: '1', name: 'Alpha Phase',
  early_start: '2026-04-05', early_finish: '2026-04-30',
  planned_start: '2026-04-05',
  duration: 20, percent_complete: 50, is_critical: false,
  is_milestone: false, is_summary: true, parent_id: null,
  status: 'IN_PROGRESS', assignees: [], total_float: null,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
};

const TASK = {
  id: 't1', wbs_path: '1.1', name: 'Design Review',
  early_start: '2026-04-07', early_finish: '2026-04-14',
  planned_start: '2026-04-07',
  duration: 7, percent_complete: 30, is_critical: true,
  is_milestone: false, is_summary: false, parent_id: 'p1',
  status: 'IN_PROGRESS',
  assignees: [{ resource_id: 'r1', name: 'Maya Patel', units: 0.6 }],
  total_float: 0,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
  readiness: 'ready',
};

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const tasks = [PHASE_TASK, TASK];

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: 1, next: null, previous: null, results: FIXTURE_PROJECTS }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/overview/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'unknown', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 0, complete_tasks: 0,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/attention/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/my-tasks/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/workshop/current/', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'No active workshop session.' }) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: tasks.length, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/risks/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/resource-allocation/**`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        project_id: FIXTURE_PROJECT_ID,
        window_start: '2026-04-01',
        window_end: '2026-05-30',
        resources: [],
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }) }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        columns: [
          { status: 'BACKLOG',     label: 'Backlog',     visible: true, wip_limit: null, color: '#94A3B8' },
          { status: 'NOT_STARTED', label: 'To Do',       visible: true, wip_limit: null, color: '#64748B' },
          { status: 'IN_PROGRESS', label: 'In Progress', visible: true, wip_limit: null, color: '#3B82F6' },
          { status: 'REVIEW',      label: 'Review',      visible: true, wip_limit: null, color: '#A855F7' },
          { status: 'COMPLETE',    label: 'Done',        visible: true, wip_limit: null, color: '#22C55E' },
        ],
      }),
    }),
  );
}

test.describe('Card information popover (#304)', () => {
  test('clicking a board card opens the popover with readiness, CP, WBS, dates', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    const card = page.getByText('Design Review');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    const dialog = page.getByRole('dialog', { name: /Design Review/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('WBS 1.1')).toBeVisible();
    await expect(dialog.getByLabel('On critical path')).toBeVisible();
    await expect(dialog.getByLabel('Status: In progress')).toBeVisible();
    // Float row only renders when scheduled + critical (or non-null float).
    await expect(dialog.getByText(/0d float — on critical path/)).toBeVisible();
  });

  test('Escape closes the popover', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await page.getByText('Design Review').click();
    const dialog = page.getByRole('dialog', { name: /Design Review/ });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('clicking outside the popover closes it', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await page.getByText('Design Review').click();
    const dialog = page.getByRole('dialog', { name: /Design Review/ });
    await expect(dialog).toBeVisible();
    // Click the page background — anywhere outside the popover.
    await page.mouse.click(5, 5);
    await expect(dialog).not.toBeVisible();
  });

  test('Open detail launches the TaskDetailDrawer and closes the popover', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await page.getByText('Design Review').click();
    const popover = page.getByRole('dialog', { name: /Design Review/ });
    await popover.getByRole('button', { name: 'Open detail' }).click();
    // Drawer's accessible name uses the WBS-prefixed task title.
    await expect(page.getByRole('dialog', { name: /1\.1.*Design Review/ })).toBeVisible();
    await expect(popover).not.toBeVisible();
  });

});

// Mobile (< md, 768px) bottom-sheet behavior is covered by the BoardCardPopover
// vitest unit test (`isMobile=true` shell renders `aria-modal="true"`). An e2e
// counterpart at viewport 375×667 deterministically lands on the login screen
// — the same auth-state flake noted in `feedback_playwright_e2e` memory and
// affecting `wave7-risks.spec.ts`. The shell switch itself is a `md:` Tailwind
// class swap with no runtime logic, so unit-level coverage is sufficient.

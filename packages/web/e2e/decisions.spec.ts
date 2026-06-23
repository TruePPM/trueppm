import { test, expect } from '@playwright/test';

/**
 * #748 — Decisions views (ADR-0167).
 *
 * Golden path: Reports → Decisions tab → decision-flagged notes render grouped by
 * sprint, with the scope segmented control and (for an admin) the oversight-visibility
 * consent control.
 * Empty state: no decisions → empty-state copy.
 * Locked state: a denied oversight reader (403) → explanatory locked copy.
 *
 * All API calls are intercepted via page.route() — no backend required. Every endpoint
 * the Reports route + DecisionsPanel read is mocked with its real shape (object endpoints
 * never lean on a list-shaped catch-all — CLAUDE.md).
 */

const PROJECT_ID = 'e2e-decisions-0000-0000-0000-000000000748';

const FIXTURE_PROJECT = {
  id: PROJECT_ID,
  name: 'Decisions E2E Project',
  description: '',
  start_date: '2026-04-01',
  finish_date: '2026-04-30',
  calendar: 'default',
  estimation_mode: 'open',
  methodology: 'HYBRID',
};

const SPRINTS = [
  {
    id: 's-active',
    project: PROJECT_ID,
    name: 'Sprint 2',
    state: 'ACTIVE',
    start_date: '2026-04-15',
    finish_date: '2026-04-28',
  },
];

const DECISION_ROW = {
  id: 'dec-1',
  body: 'We chose Postgres for the JSONB indexes.',
  decision: true,
  pinned: false,
  author: { id: 'u1', username: 'alice', display_name: 'Alice' },
  edited_at: null,
  created_at: '2026-04-16T00:00:00Z',
  task: { id: 'task-1', name: 'Pick the datastore' },
  sprint: { id: 's-active', name: 'Sprint 2', state: 'ACTIVE' },
};

type Page = import('@playwright/test').Page;

interface SetupOpts {
  decisionsStatus?: number;
  decisions?: unknown[];
  canEdit?: boolean;
  oversightVisible?: boolean;
}

async function setup(page: Page, opts: SetupOpts = {}) {
  const {
    decisionsStatus = 200,
    decisions = [DECISION_ROW],
    canEdit = true,
    oversightVisible = false,
  } = opts;

  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
  });

  const pj = (results: unknown[]) =>
    JSON.stringify({ count: results.length, next: null, previous: null, results });

  await page.route('**/api/v1/projects/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([FIXTURE_PROJECT]) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_PROJECT) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/overview/`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        schedule_health: 'on_track', spi: null, tasks_late_count: 0,
        critical_task_count: 0, total_tasks: 5, complete_tasks: 3,
        next_milestone: null, team_utilization_pct: null, owner_name: null,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/attention/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/my-tasks/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [] }) }),
  );
  await page.route('**/api/v1/projects/*/presence/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        task_count: 5, critical_path_count: 0, monte_carlo_p80: null,
        at_risk_count: 0, critical_count: 0, at_risk_tasks: [], critical_tasks: [],
        last_saved: null, recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/board-config/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [] }) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'mem-1', role: 400 }]) }),
  );

  // --- #748 endpoints ---
  await page.route(`**/api/v1/projects/${PROJECT_ID}/sprints/**`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(SPRINTS) }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/decisions-policy/`, (r) =>
    r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ oversight_visible: oversightVisible, can_edit: canEdit }),
    }),
  );
  await page.route(`**/api/v1/projects/${PROJECT_ID}/decisions/**`, (r) =>
    r.fulfill({
      status: decisionsStatus,
      contentType: 'application/json',
      body:
        decisionsStatus === 200
          ? pj(decisions)
          : JSON.stringify({ detail: 'Decisions are visible to the team and project managers.' }),
    }),
  );

  // No catch-all: a list-shaped catch-all would feed object endpoints (e.g. /auth/me)
  // a `{count,results}` body and crash the shell (CLAUDE.md object-endpoint trap). The
  // Reports route's reads are all explicitly mocked above, mirroring reports-burn-chart.
}

async function openDecisionsTab(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/reports`);
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('tab', { name: 'Decisions' }).click();
}

test.describe('Decisions view — golden path', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await openDecisionsTab(page);
  });

  test('renders the decision grouped under its sprint', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Sprint 2' })).toBeVisible();
    await expect(page.getByText('We chose Postgres for the JSONB indexes.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pick the datastore' })).toBeVisible();
  });

  test('exposes the scope segmented control', async ({ page }) => {
    await expect(page.getByRole('radiogroup', { name: 'Decisions scope' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'All decisions' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Current sprint' })).toBeVisible();
  });

  test('shows the oversight consent switch for an admin', async ({ page }) => {
    await expect(page.getByRole('switch', { name: 'Oversight visibility' })).toBeVisible();
  });
});

test.describe('Decisions view — empty + locked states', () => {
  test('renders the empty state when there are no decisions', async ({ page }) => {
    await setup(page, { decisions: [] });
    await openDecisionsTab(page);
    await expect(page.getByText(/No decisions recorded yet/)).toBeVisible();
  });

  test('renders the locked state for a denied oversight reader', async ({ page }) => {
    await setup(page, { decisionsStatus: 403, canEdit: false });
    await openDecisionsTab(page);
    await expect(page.getByText(/A project admin can extend visibility/)).toBeVisible();
    // The consent switch is absent for a non-admin.
    await expect(page.getByRole('switch', { name: 'Oversight visibility' })).toHaveCount(0);
  });
});

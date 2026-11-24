/**
 * E2E for the rolled-up phase status pill on the Table/Grid (#3531).
 *
 * A phase's status is computed server-side (`status_source`). The pill must read
 * as derived (dashed, the word "rolled up", a sr-only completion), an empty
 * phase must show an em dash rather than Not started, and a committed leaf keeps
 * the plain pill. Boilerplate mirrors grid-owner-status-facets.spec.ts.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-roll-00000000-0000-0000-0000-000000003531';
const GRID_URL = `/projects/${FIXTURE_PROJECT_ID}/grid`;

const REYES = { id: 'res-reyes', name: 'A. Reyes' };
const OSEI = { id: 'res-osei', name: 'M. Osei' };
// On the project roster, on none of the rows — the visible `0` case.
const CHEN = { id: 'res-chen', name: 'B. Chen' };

const BASE = {
  early_start: '2026-04-07',
  early_finish: '2026-04-14',
  planned_start: '2026-04-07',
  duration: 7,
  percent_complete: 0,
  is_critical: false,
  is_milestone: false,
  parent_id: null,
  assignments: [],
  total_float: 5,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
  labels: [],
};

const TASKS = [
  {
    ...BASE,
    id: 'p1',
    wbs_path: '1',
    name: 'Build phase',
    is_summary: true,
    is_phase: true,
    status: 'IN_PROGRESS',
    status_source: 'derived',
    status_rollup_count: 4,
  },
  {
    ...BASE,
    id: 'p2',
    wbs_path: '2',
    name: 'Empty phase',
    is_summary: true,
    is_phase: true,
    status: 'NOT_STARTED',
    status_source: 'none',
    status_rollup_count: 0,
  },
  {
    ...BASE,
    id: 't3',
    wbs_path: '3',
    name: 'Pour footings',
    is_summary: false,
    status: 'REVIEW',
    status_source: 'committed',
    status_rollup_count: 0,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Pin Flat mode so assertions do not depend on the methodology default.
    localStorage.setItem(
      'trueppm.grid.mode.e2e-roll-00000000-0000-0000-0000-000000003531.v1',
      'flat',
    );
  });

  // Catch-all FIRST so an unmocked endpoint cannot 401 and tear the app down
  // mid-render (#2366). The specific routes below win.
  await setupCatchAll(page);

  await page.route('**/api/v1/projects/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: FIXTURE_PROJECT_ID,
            name: 'Grid Facets Project',
            description: '',
            start_date: '2026-04-01',
            calendar: 'default',
          },
        ],
      }),
    }),
  );
  // The project detail MUST be mocked — a 404 unmounts the page as ProjectNotFound.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: FIXTURE_PROJECT_ID,
        name: 'Grid Facets Project',
        methodology: 'AGILE',
        agile_features: false,
        start_date: '2026-04-01',
      }),
    }),
  );
  // The Owner facet's catalog. The catch-all would return an empty list here,
  // which reads as "no roster" and silently disables the whole facet — exactly
  // the object-vs-list trap the catch-all rule warns about.
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 3,
        next: null,
        previous: null,
        results: [REYES, OSEI, CHEN].map((r, i) => ({
          id: `pr-${i}`,
          project: FIXTURE_PROJECT_ID,
          resource: r.id,
          resource_detail: {
            id: r.id,
            name: r.name,
            email: `${r.id}@example.test`,
            job_role: '',
            max_units: '1.00',
            calendar: null,
            skills: [],
          },
          role_title: '',
          units_override: null,
          effective_max_units: '1.00',
          notes: '',
        })),
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/labels/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/presence/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  );
  await page.route('**/api/v1/projects/*/status-summary/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        task_count: TASKS.length,
        health_band: 'on_track',
        monte_carlo_p80: null,
        at_risk_count: 0,
        critical_count: 0,
        at_risk_tasks: [],
        critical_tasks: [],
        last_saved: null,
        recalculated_at: null,
      }),
    }),
  );
  await page.route('**/api/v1/projects/*/sprints/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: TASKS.length, next: null, previous: null, results: TASKS }),
    }),
  );
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.route('**/api/v1/projects/*/members/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: route.request().url().includes('self=true')
        ? JSON.stringify([{ id: 'mem-self', role: 300, role_label: 'Project Manager' }])
        : JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 'mem-self', role: 300, role_label: 'Project Manager' }],
          }),
    }),
  );
}

async function gotoGrid(page: import('@playwright/test').Page) {
  await page.goto(GRID_URL);
  await expect(page.getByText('Pour footings')).toBeVisible();
}

test.describe('Rolled-up phase status (#3531)', () => {
  test('a derived phase reads as rolled up and offers no edit control', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    const pill = page.getByTestId('status-pill-derived');
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText('rolled up');
    await expect(pill).toContainText('In progress, rolled up from 4 tasks');
    await expect(pill).not.toHaveAttribute('tabindex', /.*/);
    await expect(pill.getByRole('button')).toHaveCount(0);
  });

  test('an empty phase shows an em dash, not Not started', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await expect(page.getByTestId('status-none')).toHaveText(/\u2014/);
    await expect(page.getByText('Not started')).toHaveCount(0);
  });

  test('a committed leaf keeps the plain pill', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await expect(page.getByText('Review', { exact: true }).first()).toBeVisible();
  });
});

/**
 * E2E for the Owner and Status facets on the Table/Grid (#2387, ADR-0624).
 *
 * The gap this closes is a reachability one: `?owner=` / `?status=` filtered
 * correctly and rendered removable chips, but nothing in the UI could *set*
 * them. So these tests are deliberately about the controls existing and working
 * end to end — the predicates and the keyboard model are covered at unit level
 * (`ownerFilter.test.ts`, `statusFilter.test.ts`, `OwnerFacet.test.tsx`).
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-fcts-00000000-0000-0000-0000-000000002387';
const GRID_URL = `/projects/${FIXTURE_PROJECT_ID}/grid`;

const REYES = { id: 'res-reyes', name: 'A. Reyes' };
const OSEI = { id: 'res-osei', name: 'M. Osei' };
// On the project roster, on none of the rows — the visible `0` case.
const CHEN = { id: 'res-chen', name: 'B. Chen' };

function task(
  id: string,
  wbs: string,
  name: string,
  status: string,
  assignees: { id: string; name: string }[],
) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-07',
    early_finish: '2026-04-14',
    planned_start: '2026-04-07',
    duration: 7,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status,
    assignments: assignees.map((a, i) => ({
      id: `as-${id}-${i}`,
      resource_id: a.id,
      resource_name: a.name,
      units: 1,
    })),
    total_float: 5,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    labels: [],
  };
}

const TASKS = [
  task('t1', '1', 'Pour footings', 'IN_PROGRESS', [REYES]),
  task('t2', '2', 'Rebar inspection sign-off', 'ON_HOLD', [OSEI]),
  task('t3', '3', 'Submit slab mix design', 'IN_PROGRESS', [REYES, OSEI]),
  task('t4', '4', 'Crane pad survey', 'NOT_STARTED', []),
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
      'trueppm.grid.mode.e2e-fcts-00000000-0000-0000-0000-000000002387.v1',
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
        critical_path_count: 0,
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

/** Wait for the Grid's rows, not just the toolbar — the chrome paints before the
 *  task read resolves, and clicking a trigger early races the render. */
async function gotoGrid(page: import('@playwright/test').Page, query = '') {
  await page.goto(`${GRID_URL}${query}`);
  await expect(page.getByText('Pour footings')).toBeVisible();
}

test.describe('Grid Owner facet', () => {
  test('the three facets are present and reachable from the toolbar', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    // The whole point of #2387: before it, Owner and Status could only be set by
    // hand-editing the URL.
    await expect(page.getByRole('button', { name: 'Owner: any' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Status: any' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Label: none yet' })).toBeVisible();
  });

  test('selecting an owner narrows the rows, shows a chip, and clears back', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);

    await page.getByRole('button', { name: 'Owner: any' }).click();
    // Roster split: people with rows first, everyone else after.
    await expect(page.getByRole('group', { name: 'On these rows · 2' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'All members · 1 more' })).toBeVisible();
    // A member with nothing here is visible with a truthful 0, before you pick.
    await expect(page.getByRole('menuitemcheckbox', { name: /B\. Chen/ })).toContainText('0');

    await page.getByRole('menuitemcheckbox', { name: /M\. Osei/ }).click();
    // Panel stays open across selections so results update behind it.
    await expect(page.getByRole('menu', { name: 'Filter by owner' })).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Pour footings')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Remove Owner: M. Osei filter' })).toBeVisible();
    expect(page.url()).toContain('owner=res-osei');

    await page.getByRole('button', { name: 'Remove Owner: M. Osei filter' }).click();
    await expect(page.getByText('Pour footings')).toBeVisible();
    expect(page.url()).not.toContain('owner=');
  });

  test('two owners OR within the facet', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Owner: any' }).click();
    await page.getByRole('menuitemcheckbox', { name: /A\. Reyes/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /M\. Osei/ }).click();
    await page.keyboard.press('Escape');
    // Everything assigned to either; the unassigned row still drops out.
    await expect(page.getByText('Pour footings')).toBeVisible();
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Crane pad survey')).toBeHidden();
    // One chip per value, so either can be dropped on its own.
    await expect(page.getByRole('button', { name: 'Remove Owner: A. Reyes filter' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Owner: M. Osei filter' })).toBeVisible();
  });
});

test.describe('Grid Status facet', () => {
  test('lists every status in pipeline order, zero counts included', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Status: any' }).click();
    const options = page.getByRole('menuitemcheckbox');
    await expect(options).toHaveCount(6);
    // Order is the pipeline, never sorted by count.
    await expect(options.nth(0)).toContainText('Backlog');
    await expect(options.nth(2)).toContainText('In progress');
    await expect(options.nth(5)).toContainText('Done');
    // A status nothing is in stays listed and selectable.
    await expect(options.nth(5)).toContainText('0');
  });

  test('two statuses OR within the facet and AND with Owner', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Status: any' }).click();
    await page.getByRole('menuitemcheckbox', { name: /In progress/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /On hold/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Crane pad survey')).toBeHidden();

    await page.getByRole('button', { name: 'Owner: any' }).click();
    await page.getByRole('menuitemcheckbox', { name: /M\. Osei/ }).click();
    await page.keyboard.press('Escape');
    // Osei ∧ (In progress ∨ On hold) — Reyes-only "Pour footings" is out.
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Submit slab mix design')).toBeVisible();
    await expect(page.getByText('Pour footings')).toBeHidden();
  });
});

test.describe('Grid facets — panels, links and the empty intersection', () => {
  test('one panel at a time — opening Status closes Owner', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Owner: any' }).click();
    await expect(page.getByRole('menu', { name: 'Filter by owner' })).toBeVisible();
    await page.getByRole('button', { name: 'Status: any' }).click();
    await expect(page.getByRole('menu', { name: 'Filter by owner' })).toBeHidden();
    await expect(page.getByRole('menu', { name: 'Filter by status' })).toBeVisible();
  });

  test('a multi-value link restores every facet, and Clear all empties the strip', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${GRID_URL}?owner=res-reyes,res-osei&status=IN_PROGRESS`);
    await expect(page.getByText('Pour footings')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Owner: A. Reyes filter' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Owner: M. Osei filter' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Remove Status: In progress filter' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByRole('button', { name: 'Clear all' })).toBeHidden();
    expect(page.url()).not.toContain('owner=');
    expect(page.url()).not.toContain('status=');
  });

  test('a pre-#2387 single-value ?owner=<name> link still resolves', async ({ page }) => {
    // `?owner=` shipped as a name match. Those links are still in bookmarks and
    // must not break just because the facet now emits ids.
    await setup(page);
    await page.goto(`${GRID_URL}?owner=M.%20Osei`);
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Pour footings')).toBeHidden();
  });

  test('an empty intersection names each facet and offers the most useful drop', async ({
    page,
  }) => {
    await setup(page);
    // Chen owns nothing; NOT_STARTED has a row. Neither is empty alone.
    await page.goto(`${GRID_URL}?owner=res-chen&status=NOT_STARTED`);
    await expect(page.getByText('No tasks match both filters')).toBeVisible();
    await expect(page.getByText(/Each filter has rows on its own/)).toBeVisible();

    // Dropping Owner brings the NOT_STARTED row back; dropping Status would
    // bring back nothing, so Owner is what gets offered.
    await page.getByRole('button', { name: /^Drop Owner:/ }).click();
    await expect(page.getByText('Crane pad survey')).toBeVisible();
  });
});

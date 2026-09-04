/**
 * E2E for the Label facet on the Table/Grid (#2383, ADR-0620).
 *
 * Covers the user-visible acceptance criteria: the golden path (open → select →
 * rows narrow → chip appears → clear), the zero-result state that a visible `0`
 * count made deliberate, and the empty-catalog state. The keyboard model
 * (roving tabindex, type-ahead, Home/End) is exercised at unit level in
 * `LabelFacet.test.tsx` — jsdom is the faithful surface for that, and repeating
 * it here would only re-test the same handlers through a slower harness.
 */
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-labl-00000000-0000-0000-0000-000000002383';
const GRID_URL = `/projects/${FIXTURE_PROJECT_ID}/grid`;

const LABELS = [
  { id: 'lab-review', name: 'Needs review', color: 'teal', position: 0, server_version: 1 },
  { id: 'lab-blocked', name: 'Blocked', color: 'rose', position: 1, server_version: 1 },
  // Present in the catalog, on no task — the row that must show a visible 0.
  { id: 'lab-rework', name: 'Rework', color: 'purple', position: 2, server_version: 1 },
];

function task(
  id: string,
  wbs: string,
  name: string,
  labels: { id: string; name: string; color: string }[],
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
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: 5,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    labels,
  };
}

const REVIEW = LABELS[0];
const BLOCKED = LABELS[1];

const TASKS = [
  task('t1', '1', 'Pour footings', [REVIEW]),
  task('t2', '2', 'Rebar inspection sign-off', [BLOCKED, REVIEW]),
  task('t3', '3', 'Crane pad survey', []),
];

async function setup(
  page: import('@playwright/test').Page,
  opts: { labels?: typeof LABELS } = {},
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    // Pin Flat mode so the assertions do not depend on the methodology default.
    localStorage.setItem(
      'trueppm.grid.mode.e2e-labl-00000000-0000-0000-0000-000000002383.v1',
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
            name: 'Label Filter Project',
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
        name: 'Label Filter Project',
        methodology: 'AGILE',
        agile_features: false,
        start_date: '2026-04-01',
      }),
    }),
  );
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/labels/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: (opts.labels ?? LABELS).length,
        next: null,
        previous: null,
        results: opts.labels ?? LABELS,
      }),
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

/** Wait for the Grid's rows, not just the trigger — the toolbar paints before
 *  the task read resolves, and clicking it early races the render. */
async function gotoGrid(page: import('@playwright/test').Page, query = '') {
  await page.goto(`${GRID_URL}${query}`);
  await expect(page.getByText('Pour footings')).toBeVisible();
}

test.describe('Grid label filter — golden path', () => {
  test('selecting a label narrows the rows, shows a chip, and clears back', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);

    await page.getByRole('button', { name: 'Label: any' }).click();

    // The full catalog is offered, with counts over the loaded rows — including
    // the visible 0 that makes a zero-result pick deliberate.
    const rework = page.getByRole('menuitemcheckbox', { name: /Rework/ });
    await expect(rework).toContainText('0');
    await expect(page.getByRole('menuitemcheckbox', { name: /Needs review/ })).toContainText('2');

    await page.getByRole('menuitemcheckbox', { name: /Blocked/ }).click();

    // Panel stays open across selections so results update behind it.
    await expect(page.getByRole('menu', { name: 'Filter by label' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Only the Blocked task survives; the unlabelled one is gone.
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Crane pad survey')).toBeHidden();

    // Chip strip carries the label by name, and the URL is shareable.
    await expect(page.getByRole('button', { name: 'Remove filter: label Blocked' })).toBeVisible();
    expect(page.url()).toContain('fl=lab-blocked');

    await page.getByRole('button', { name: 'Remove filter: label Blocked' }).click();
    await expect(page.getByText('Crane pad survey')).toBeVisible();
    expect(page.url()).not.toContain('fl=');
  });

  test('a ?fl= link restores the filter on load', async ({ page }) => {
    await setup(page);
    await page.goto(`${GRID_URL}?fl=lab-blocked`);
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Crane pad survey')).toBeHidden();
    await expect(page.getByRole('button', { name: /Label: Blocked/ })).toBeVisible();
  });

  test('several labels OR within the facet', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Label: any' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Needs review/ }).click();
    await page.getByRole('menuitemcheckbox', { name: /Blocked/ }).click();
    await page.keyboard.press('Escape');
    // Both labelled tasks match; the unlabelled one still does not.
    await expect(page.getByText('Pour footings')).toBeVisible();
    await expect(page.getByText('Rebar inspection sign-off')).toBeVisible();
    await expect(page.getByText('Crane pad survey')).toBeHidden();
  });
});

test.describe('Grid label filter — empty and error states', () => {
  test('a label on no task yields an empty result the chip explains', async ({ page }) => {
    await setup(page);
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Label: any' }).click();
    await page.getByRole('menuitemcheckbox', { name: /Rework/ }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('Pour footings')).toBeHidden();
    // The chip restates the label *and* its 0, so the empty table is explained
    // without reopening the panel.
    const chip = page.getByRole('button', { name: 'Remove filter: label Rework' });
    await expect(chip).toBeVisible();
    await expect(page.getByText('0 / 3 shown')).toBeVisible();
  });

  test('a project with no labels keeps the control discoverable', async ({ page }) => {
    await setup(page, { labels: [] });
    await gotoGrid(page);
    await page.getByRole('button', { name: 'Label: none yet' }).click();
    await expect(page.getByText('No labels in this project yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open label settings' })).toBeVisible();
  });
});

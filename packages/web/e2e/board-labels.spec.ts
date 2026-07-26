/**
 * Task labels on the board (ADR-0400, #1089).
 *
 * Golden path: colored label pills render on board cards, and the new Label
 * filter facet narrows the board to cards carrying a selected label (joining the
 * existing assignee/priority/due facets). Non-matching cards dim + aria-hidden,
 * so we assert card presence by role/name (ADR-0199 isFilteredOut semantics).
 *
 * Mock discipline (CLAUDE.md): the board reads its cards from /tasks/ (labels
 * ride the nested `labels` array), and the Label facet options are derived from
 * those task labels — not the /labels/ catalog endpoint — so the board flow needs
 * no extra mock beyond the task fixtures. Card interactions gate on a "board
 * rendered" signal first.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-labels-0000-0000-0000-000000001089';
const ROUTE = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Labels Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

function leaf(
  id: string,
  name: string,
  wbs: string,
  labels: Array<{ id: string; name: string; color: string; position: number }>,
) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'lb-1',
    status: 'NOT_STARTED',
    assignments: [],
    labels,
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const FIXTURE_TASKS = [
  {
    id: 'lb-1',
    wbs_path: '1',
    name: 'Delivery Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    planned_start: '2026-01-05',
    duration: 30,
    percent_complete: 20,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignments: [],
    labels: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  leaf('lb-2', 'Frontend Card', '1.1', [
    { id: 'lab-1', name: 'frontend', color: 'blue', position: 0 },
  ]),
  leaf('lb-3', 'Backend Card', '1.2', [
    { id: 'lab-2', name: 'backend', color: 'green', position: 1 },
  ]),
  leaf('lb-4', 'Unlabeled Card', '1.3', []),
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  // The board reads the label CATALOG to tell a deleted label from an unused
  // one in saved views (#2394). Default it to empty; the saved-view tests below
  // re-register this route with their own catalog.
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/labels/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

function card(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name}, \\d`) });
}

test.describe('Board task labels (ADR-0400)', () => {
  test('renders label pills and filters the board by label', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);

    // Board rendered signal.
    await expect(card(page, 'Frontend Card')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'Backend Card')).toBeVisible();
    await expect(card(page, 'Unlabeled Card')).toBeVisible();

    // Pills render on their cards.
    await expect(page.getByText('frontend').first()).toBeVisible();
    await expect(page.getByText('backend').first()).toBeVisible();

    // Open the filter panel and apply the Label facet = frontend.
    await page.getByTestId('board-filter-trigger').click();
    await expect(page.getByTestId('board-filter-panel')).toBeVisible();
    await page.getByTestId('facet-label-lab-1').check();

    // Only the frontend-labeled card remains in the a11y tree.
    await expect(page.getByTestId('board-filter-count')).toHaveText('1');
    await expect(card(page, 'Frontend Card')).toBeVisible();
    await expect(card(page, 'Backend Card')).toHaveCount(0);
    await expect(card(page, 'Unlabeled Card')).toHaveCount(0);

    // The active-filter chip bar shows the label.
    await expect(page.getByTestId('board-filter-chips')).toContainText('Label: frontend');
  });
});

/**
 * Saved-view label swatch + deleted-label tombstone (#2394, frames D1–D2).
 *
 * The board-views menu and the notice are the only places a user learns that a
 * saved filter is no longer being applied, so both are asserted on the rendered
 * surface rather than through the store.
 */
test.describe('Saved views — label swatch and deleted-label tombstone (#2394)', () => {
  const LIVE = 'lbl-live-0000-0000-0000-000000000001';
  const GONE = 'lbl-gone-0000-0000-0000-000000000002';

  async function setupWithSavedView(page: import('@playwright/test').Page) {
    await setup(page);
    // The catalog is the ONLY name source (#2394) — `GONE` is deliberately
    // absent from it, which is exactly what "deleted" looks like to the client.
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/labels/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            { id: LIVE, name: 'Needs review', color: 'amber', position: 0, server_version: 1 },
          ],
        }),
      }),
    );
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        // A BARE ARRAY: `useBoardSavedViews` reads `res.data.map(...)`, so a
        // paginated envelope yields zero views and the menu renders nothing.
        body: JSON.stringify([
          {
            id: 'view-1',
            name: 'Q3 triage',
            config: {
              sort: 'priority',
              show_wip: true,
              show_col_tints: true,
              evm_mode: 'off',
              show_cost: false,
              risk_linked_only: false,
              filter_assignees: [],
              filter_priority: [],
              filter_due: [],
              filter_labels: [LIVE, GONE],
            },
            schema_version: 3,
            created_by: null,
            server_version: 1,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ]),
      }),
    );
  }

  test('the views menu shows a live label by name and tombstones a deleted one', async ({
    page,
  }) => {
    await setupWithSavedView(page);
    await page.goto(ROUTE);

    await page.getByRole('button', { name: /Board view/ }).click();

    const menu = page.getByRole('menu');
    await expect(menu.getByText('Q3 triage')).toBeVisible();
    // D1: the live label resolves to its real name from the catalog...
    await expect(menu.getByText('Needs review')).toBeVisible();
    // ...and the deleted one is anonymous, because its name is genuinely gone.
    await expect(menu.getByTestId(`deleted-label-${GONE}`)).toBeVisible();
  });

  test('opening the view explains the unapplied filter and offers three exits', async ({
    page,
  }) => {
    await setupWithSavedView(page);
    await page.goto(ROUTE);

    await page.getByRole('button', { name: /Board view/ }).click();
    await page.getByRole('menuitem', { name: /Q3 triage/ }).click();

    const notice = page.getByTestId('deleted-label-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Your other filters are unchanged');
    await expect(notice).toContainText('label filter not applied');
    await expect(notice.getByRole('button', { name: 'Remove it from this view' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Create a replacement label' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Keep for now' })).toBeVisible();
  });

  test('"Keep for now" dismisses the notice without changing the saved view', async ({ page }) => {
    await setupWithSavedView(page);
    let patched = false;
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-views/view-1/`, (route) => {
      if (route.request().method() === 'PATCH') patched = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(ROUTE);

    await page.getByRole('button', { name: /Board view/ }).click();
    await page.getByRole('menuitem', { name: /Q3 triage/ }).click();
    await page
      .getByTestId('deleted-label-notice')
      .getByRole('button', { name: 'Keep for now' })
      .click();

    await expect(page.getByTestId('deleted-label-notice')).toHaveCount(0);
    // The dangling id is the only record the view ever filtered on that label;
    // dismissing must not silently rewrite the stored config.
    expect(patched).toBe(false);
  });
});

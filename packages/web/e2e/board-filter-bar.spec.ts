/**
 * Board filter bar — facet layer (issue 1091).
 *
 * Golden path: open the filter panel, apply two facets (assignee + priority),
 * watch the active-count badge and chip bar, hit the zero-match state, and
 * clear all. Non-matching cards are dimmed + aria-hidden, so they drop out of
 * the accessibility tree — assertions locate cards by role/name, which honors
 * aria-hidden.
 *
 * Mock discipline (CLAUDE.md): every endpoint the board reads is mocked with its
 * real shape via setupApiMocks + a catch-all 401-guard; card interactions are
 * gated on a "board rendered" signal (a card visible by role) before touching
 * the toolbar.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-filter-0000-0000-0000-000000001091';
const ROUTE = `/projects/${FIXTURE_PROJECT_ID}/board`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Filter Bar Test',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// One phase + three leaf cards spanning two assignees and two priority bands:
//   Alice High  → assignee r1, priority_rank 2 (High)
//   Alice Low   → assignee r1, priority_rank 9 (Low)
//   Bob Low     → assignee r2, priority_rank 9 (Low)
// So (Alice ∧ High) matches exactly one card; (Bob ∧ High) matches none.
const FIXTURE_TASKS = [
  {
    id: 'fb-1',
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
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'fb-2',
    wbs_path: '1.1',
    name: 'Alice High',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 50,
    priority_rank: 2,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'fb-1',
    status: 'IN_PROGRESS',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: '1.00' }],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'fb-3',
    wbs_path: '1.2',
    name: 'Alice Low',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10,
    percent_complete: 0,
    priority_rank: 9,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'fb-1',
    status: 'NOT_STARTED',
    assignments: [{ resource_id: 'r1', resource_name: 'Alice', units: '1.00' }],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'fb-4',
    wbs_path: '1.3',
    name: 'Bob Low',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10,
    percent_complete: 0,
    priority_rank: 9,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'fb-1',
    status: 'NOT_STARTED',
    assignments: [{ resource_id: 'r2', resource_name: 'Bob', units: '1.00' }],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
}

// Card accessible name is `${task.name}, ${progress}% complete`. Anchor to that
// shape so the matcher never also grabs the card's "Actions for <name>" menu button.
function card(page: import('@playwright/test').Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name}, \\d`) });
}

test.describe('Board filter bar (issue 1091)', () => {
  test('applies two facets, dims non-matching cards, shows count + chips, clears all', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(ROUTE);

    // Board rendered signal — all three cards present in the a11y tree.
    await expect(card(page, 'Alice High')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'Alice Low')).toBeVisible();
    await expect(card(page, 'Bob Low')).toBeVisible();

    // Open the filter panel via its toolbar trigger.
    const trigger = page.getByTestId('board-filter-trigger');
    await trigger.click();
    await expect(page.getByTestId('board-filter-panel')).toBeVisible();

    // Facet 1 — Assignee = Alice. Bob's card leaves the a11y tree (aria-hidden).
    await page.getByTestId('facet-assignee-r1').check();
    await expect(page.getByTestId('board-filter-count')).toHaveText('1');
    await expect(card(page, 'Alice High')).toBeVisible();
    await expect(card(page, 'Bob Low')).toHaveCount(0);

    // Facet 2 — Priority = High. Now only "Alice High" matches.
    await page.getByTestId('facet-priority-high').check();
    await expect(page.getByTestId('board-filter-count')).toHaveText('2');
    await expect(card(page, 'Alice High')).toBeVisible();
    await expect(card(page, 'Alice Low')).toHaveCount(0);

    // Active-filter chip bar is present and inescapable.
    await expect(page.getByTestId('board-filter-chips')).toBeVisible();

    // Clear all from the panel restores every card.
    await page.getByTestId('board-filter-clear-all').click();
    await expect(page.getByTestId('board-filter-count')).toHaveCount(0);
    await expect(card(page, 'Alice High')).toBeVisible();
    await expect(card(page, 'Alice Low')).toBeVisible();
    await expect(card(page, 'Bob Low')).toBeVisible();
  });

  test('zero-match state shows a banner with a clear action', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);
    await expect(card(page, 'Bob Low')).toBeVisible({ timeout: 10_000 });

    // `f` opens the panel (routed through isTypingInInput + useBoardKeyboard).
    await page.locator('body').press('f');
    await expect(page.getByTestId('board-filter-panel')).toBeVisible();

    // Bob has no High-priority card → zero match.
    await page.getByTestId('facet-assignee-r2').check();
    await page.getByTestId('facet-priority-high').check();

    const banner = page.getByTestId('board-zero-match');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('No cards match these filters');

    // Clear from the banner restores the board.
    await page.getByTestId('board-zero-match-clear').click();
    await expect(page.getByTestId('board-zero-match')).toHaveCount(0);
    await expect(card(page, 'Bob Low')).toBeVisible();
  });

  test('facet state survives a reload via the URL (shareable link)', async ({ page }) => {
    await setup(page);
    await page.goto(ROUTE);
    await expect(card(page, 'Bob Low')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('board-filter-trigger').click();
    await page.getByTestId('facet-priority-high').check();
    await expect(page.getByTestId('board-filter-count')).toHaveText('1');
    await expect(page).toHaveURL(/fp=high/);

    await page.reload();
    // The URL carried the facet, so it re-applies after reload.
    await expect(page.getByTestId('board-filter-chips')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'Alice High')).toBeVisible();
    await expect(card(page, 'Bob Low')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Saved-view filter facet persistence (issue #1918)
// ---------------------------------------------------------------------------

test.describe('Saved board views persist filter facets (issue #1918)', () => {
  test('applying a saved view restores its stored assignee facet', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
      // A view saved before this spec's golden path — its config carries the
      // assignee facet (r1 = Alice) the way a real save would have written it.
      boardViews: [
        {
          id: 'sv-alice',
          name: 'Alice only',
          config: {
            sort: 'priority',
            show_wip: true,
            show_col_tints: true,
            evm_mode: 'off',
            show_cost: false,
            risk_linked_only: false,
            filter_assignees: ['r1'],
            filter_priority: [],
            filter_due: [],
          },
          schema_version: 2,
          created_by: 'e2e-user',
          server_version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await page.goto(ROUTE);

    // Board rendered signal.
    await expect(card(page, 'Alice High')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'Bob Low')).toBeVisible();

    // No facets active yet.
    await expect(page.getByTestId('board-filter-chips')).toHaveCount(0);

    // Open the "View" dropdown and select the saved view.
    await page.getByRole('button', { name: /board view/i }).click();
    await page.getByText('Alice only').click();

    // Its stored assignee facet is now applied: Bob drops out, count badge shows 1.
    await expect(page.getByTestId('board-filter-count')).toHaveText('1');
    await expect(page.getByTestId('board-filter-chips')).toBeVisible();
    await expect(card(page, 'Alice High')).toBeVisible();
    await expect(card(page, 'Alice Low')).toBeVisible();
    await expect(card(page, 'Bob Low')).toHaveCount(0);
  });
});

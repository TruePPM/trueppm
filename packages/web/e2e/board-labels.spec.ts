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
import { test, expect } from '@playwright/test';
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

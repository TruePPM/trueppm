/**
 * Board render ceiling E2E (#1538, #2340).
 *
 * A board cell never mounts more than 50 cards, including after a card is moved
 * INTO an already-full cell: the moved card is the focused card, so it stays
 * mounted without dragging every card ahead of it into the DOM.
 *
 * Uses `setupTaskStore` so the refetch the app fires after the PATCH echoes the
 * write (a stateless list mock would re-serve the pre-move rows and erase it).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const FIXTURE_PROJECT_ID = 'e2e-ceil-00000000-0000-0000-0000-000000001538';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Render Ceiling Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(id: string, wbs: string, name: string, status: string) {
  return {
    id,
    wbs_path: wbs,
    name,
    parent_id: 'phase-1',
    status,
    early_start: '2026-04-05',
    early_finish: '2026-04-10',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const PHASE = {
  ...row('phase-1', '1', 'Build phase', 'IN_PROGRESS'),
  parent_id: null,
  is_summary: true,
};

const FILLERS = Array.from({ length: 120 }, (_, i) =>
  row(`fill-${i}`, `1.${i + 1}`, `Filler ${i + 1}`, 'NOT_STARTED'),
);
const MOVER = row('mover', '1.999', 'Mover card', 'IN_PROGRESS');

test.describe('Board render ceiling (#1538, #2340)', () => {
  test('a card moved into a 120-card cell stays mounted and the cell stays bounded', async ({
    page,
  }) => {
    const tasks = [PHASE, ...FILLERS, MOVER];
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks,
      statusSummary: { task_count: tasks.length },
    });
    const store = await setupTaskStore(page, { tasks });

    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Mover card')).toBeVisible({ timeout: 10_000 });

    const fillerActions = page.getByRole('button', { name: /^Actions for Filler / });
    await expect(page.getByTestId('cell-ceiling-more')).toBeVisible();
    await expect(fillerActions).toHaveCount(50);

    await page.getByRole('button', { name: 'Actions for Mover card' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.getByRole('menuitem', { name: /^to do$/i }).click();

    await expect.poll(() => store.patches.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(store.patches[0]).toMatchObject({ status: 'NOT_STARTED' });

    // The moved card is mounted in the target cell, which is still bounded: 50
    // windowed fillers plus the one pinned card.
    const moverActions = page.getByRole('button', { name: 'Actions for Mover card' });
    await expect(moverActions).toHaveCount(1);
    await expect(fillerActions).toHaveCount(50);
    await expect(page.getByTestId('cell-ceiling-more')).toBeVisible();
  });
});

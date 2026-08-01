import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * E2E for the collapsed-lane / collapsed-column drop targets (issue #2679).
 *
 * Before this fix, a collapsed board lane rendered `CollapsedLaneCell` — a
 * plain div with no `useDroppable` — for every column, and a board-wide
 * collapsed column rendered `LaneColumnStubTrack` with the same gap. Dragging
 * a backlog card onto either surface silently failed: the card lifted, no
 * target ever highlighted, and it snapped back on release. On a board where
 * every lane starts collapsed (the common single-lane new-project case) there
 * were zero drop targets anywhere on the board.
 *
 * dnd-kit drag-and-drop is real-pointer-driven here (not `dispatchEvent`):
 * `page.mouse.down/move/up` fire trusted pointer events that dnd-kit's
 * `PointerSensor` (wrapped as `SpaceAwarePointerSensor`, `distance: 4`
 * activation) listens to directly, so a real drag exercises the same
 * collision-detection path production does. This is the one state no other
 * test layer covers: `BoardView.test.tsx` deliberately excludes drag-driven
 * paths (dnd-kit sensors need real layout rects), `BacklogBand.test.tsx`
 * mounts cards with no droppables and no `onDragEnd`, and
 * `board-backlog-band.spec.ts` explicitly defers drag rules to "the BoardView
 * unit tests" — which don't cover them.
 */

const FIXTURE_PROJECT_ID = 'e2e-collapsed-00000000-0000-0000-0000-000000002679';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Collapsed Lane Drop Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function commonTaskShape() {
  return {
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

const SUMMARY_TASK = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Discovery',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 30,
  is_critical: false,
  is_milestone: false,
  is_summary: true,
  parent_id: null,
  status: 'IN_PROGRESS',
  assignees: [],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const COMMITTED_TASK = {
  id: 'committed-1',
  wbs_path: '1.1',
  name: 'Stakeholder interviews',
  parent_id: 'phase-1',
  status: 'IN_PROGRESS',
  ...commonTaskShape(),
};

const BACKLOG_IDEA = {
  id: 'backlog-a',
  wbs_path: '1.2',
  name: 'Spike auth provider',
  parent_id: 'phase-1',
  status: 'BACKLOG',
  readiness: 'idea',
  ...commonTaskShape(),
  status_changed_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
};

/**
 * Registers auth/catch-all/common mocks, then a single `**\/api\/v1\/tasks\/**`
 * handler that serves a mutable in-memory task list AND answers a PATCH to
 * `/tasks/{id}/` by updating that same list.
 *
 * `useUpdateTaskStatus` applies its move optimistically, but `onSuccess` also
 * calls `queryClient.invalidateQueries(['tasks', projectId])`, which refetches
 * the list endpoint. A mock that always returns the *original* fixture array
 * would overwrite the optimistic move with stale data on that refetch — the
 * card would flash into the target column and then snap back to backlog. A
 * live list keeps the refetch consistent with the PATCH the same way a real
 * backend would.
 */
async function setup(page: Page, initialTasks: Record<string, unknown>[]) {
  const liveTasks = initialTasks.map((t) => ({ ...t }));
  let patchBody: Record<string, unknown> | null = null;

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: liveTasks,
    statusSummary: { task_count: liveTasks.length },
  });
  // Registered AFTER setupApiMocks so it's the most-recently-registered match
  // for both the list GET and any `/tasks/{id}/` PATCH — Playwright checks
  // the most-recently-registered matching handler first.
  await page.route('**/api/v1/tasks/**', async (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const segments = new URL(req.url()).pathname.split('/').filter(Boolean);
      const taskId = segments[segments.length - 1];
      const body = (await req.postDataJSON()) as Record<string, unknown>;
      patchBody = body;
      const idx = liveTasks.findIndex((t) => t.id === taskId);
      if (idx !== -1) liveTasks[idx] = { ...liveTasks[idx], ...body };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(liveTasks[idx] ?? { id: taskId, ...body }),
      });
    }
    if (req.method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: liveTasks.length,
        next: null,
        previous: null,
        results: liveTasks,
      }),
    });
  });

  return { getPatchBody: () => patchBody };
}

/** Seed the per-project collapsed-lane / collapsed-column localStorage keys
 *  (issue #190 / #1459) before the app boots, so the board renders already
 *  collapsed rather than requiring a UI toggle click first. */
async function seedCollapsedState(
  page: Page,
  opts: { collapsedLanes?: string[]; collapsedColumns?: string[] },
) {
  await page.addInitScript(
    ({ projectId, lanes, columns }) => {
      if (lanes) {
        localStorage.setItem(`trueppm.board.${projectId}.collapsedLanes`, JSON.stringify(lanes));
      }
      if (columns) {
        localStorage.setItem(
          `trueppm.board.${projectId}.collapsedColumns`,
          JSON.stringify(columns),
        );
      }
    },
    {
      projectId: FIXTURE_PROJECT_ID,
      lanes: opts.collapsedLanes,
      columns: opts.collapsedColumns,
    },
  );
}

/** Drags the backlog idea card onto the given target element via real pointer
 *  events (dnd-kit's `PointerSensor`, `distance: 4` activation constraint —
 *  BoardView.tsx `sensors`). Multiple intermediate `steps` on each move so
 *  dnd-kit's collision detection gets enough pointermove ticks to register
 *  the hover before release. */
async function dragBacklogCardOnto(page: Page, cardName: string, target: Locator) {
  const card = page.getByRole('button', { name: new RegExp(`^${cardName}, backlog idea`) });
  await expect(card).toBeVisible();
  const targetBox = await target.boundingBox();
  const cardBox = await card.boundingBox();
  if (!targetBox || !cardBox) throw new Error('missing bounding box for drag source or target');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  // Cross the 4px activation-distance constraint before aiming at the target.
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y + cardBox.height / 2, {
    steps: 3,
  });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
}

test.describe('Board drop targets stay live on collapsed surfaces (#2679)', () => {
  test('dragging a backlog card onto a collapsed lane promotes it', async ({ page }) => {
    await seedCollapsedState(page, { collapsedLanes: ['phase-1'] });

    const { getPatchBody } = await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_IDEA]);

    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail.getByText('Spike auth provider')).toBeVisible({ timeout: 10_000 });

    // The lane is collapsed: its "To Do" cell shows the collapsed-count
    // treatment, not the full BoardCell, and starts at the empty "0" state.
    const collapsedCell = page.getByTestId('board-cell-phase-1-NOT_STARTED');
    await expect(collapsedCell).toBeVisible();
    await expect(collapsedCell.getByText('0 cards, empty')).toBeVisible();

    await dragBacklogCardOnto(page, 'Spike auth provider', collapsedCell);

    // The PATCH landed — before the fix, `over` was always null on a
    // collapsed lane and `dropOnCell` was never reached.
    await expect.poll(getPatchBody).not.toBeNull();
    expect(getPatchBody()!.status).toBe('NOT_STARTED');

    // Optimistic cache update (useUpdateTaskStatus) moves the card out of the
    // backlog rail and the collapsed cell's count flips from empty to 1 —
    // confirms the drop was routed to the right phase+status, not just that
    // some PATCH fired.
    await expect(rail.getByText('Spike auth provider')).not.toBeVisible();
    await expect(collapsedCell.getByText('1 task')).toBeVisible();
  });

  test('dragging a backlog card onto a board-wide collapsed column promotes it', async ({
    page,
  }) => {
    await seedCollapsedState(page, { collapsedColumns: ['NOT_STARTED'] });

    const { getPatchBody } = await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_IDEA]);

    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail.getByText('Spike auth provider')).toBeVisible({ timeout: 10_000 });

    // The lane itself is expanded; only the NOT_STARTED column is folded to
    // its board-wide stub track.
    const stub = page.getByTestId('lane-stub-phase-1-NOT_STARTED');
    await expect(stub).toBeVisible();

    await dragBacklogCardOnto(page, 'Spike auth provider', stub);

    await expect.poll(getPatchBody).not.toBeNull();
    expect(getPatchBody()!.status).toBe('NOT_STARTED');

    // The stub stays narrow (it must not fight the shared column-width grid
    // template that the header and every lane's milestone rail also use —
    // see LaneColumnStubTrack's docstring), but its sr-only count now reflects
    // the moved card.
    await expect(rail.getByText('Spike auth provider')).not.toBeVisible();
    await expect(stub.getByText('1 task')).toBeVisible();
  });
});

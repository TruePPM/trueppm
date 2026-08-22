import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

/**
 * Named board lanes over the five canonical statuses (#2967).
 *
 * The claim the whole feature rests on is a *wire* claim: a card moved from
 * Review into QA sends `board_lane`, and sends `status: "REVIEW"` unchanged —
 * so burndown, throughput rollup, MS Project export and every integration keep
 * reading the same five values they always have. That is asserted here on the
 * real PATCH body, because it is the one thing no unit test can see: the
 * serializer test proves the server accepts the shape, `statusLanes.test.ts`
 * proves the track math, and only a real drag proves the board actually sends
 * it.
 *
 * The drag is real-pointer-driven (`page.mouse`), not `dispatchEvent`: dnd-kit's
 * `PointerSensor` (wrapped as `SpaceAwarePointerSensor`, `distance: 4`) listens
 * for trusted pointer events, so anything synthetic never activates a drag.
 */

const FIXTURE_PROJECT_ID = 'e2e-lanes-000000000-0000-0000-0000-000000002967';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Status Lanes Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

/** Five canonical columns, with REVIEW split into two named lanes. */
const LANED_BOARD_CONFIG = {
  columns: [
    {
      status: 'BACKLOG',
      label: 'Backlog',
      visible: true,
      wip_limit: null,
      color: '#94A3B8',
      lanes: [],
    },
    {
      status: 'NOT_STARTED',
      label: 'To Do',
      visible: true,
      wip_limit: null,
      color: '#64748B',
      lanes: [],
    },
    {
      status: 'IN_PROGRESS',
      label: 'In Progress',
      visible: true,
      wip_limit: null,
      color: '#3B82F6',
      lanes: [],
    },
    {
      status: 'REVIEW',
      label: 'Review',
      visible: true,
      wip_limit: null,
      color: '#A855F7',
      lanes: [
        { key: 'review', label: 'Peer review', wip_limit: null },
        { key: 'qa', label: 'QA', wip_limit: null },
      ],
    },
    {
      status: 'COMPLETE',
      label: 'Done',
      visible: true,
      wip_limit: null,
      color: '#22C55E',
      lanes: [],
    },
  ],
};

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

const PHASE = {
  id: 'phase-1',
  wbs_path: '1',
  name: 'Commissioning',
  early_start: '2026-04-05',
  early_finish: '2026-04-30',
  duration: 25,
  percent_complete: 20,
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

/** Sits in the FIRST Review lane — it names no lane at all, which must resolve there. */
const UNASSIGNED_CARD = {
  id: 'card-unassigned',
  wbs_path: '1.1',
  name: 'Verify torque values',
  parent_id: 'phase-1',
  status: 'REVIEW',
  board_lane: '',
  ...commonTaskShape(),
};

/** Sits in the SECOND Review lane by explicit key. */
const QA_CARD = {
  id: 'card-qa',
  wbs_path: '1.2',
  name: 'Regression sweep',
  parent_id: 'phase-1',
  status: 'REVIEW',
  board_lane: 'qa',
  ...commonTaskShape(),
};

/** Points at a lane that no longer exists — must resolve to the first lane. */
const ORPHAN_CARD = {
  id: 'card-orphan',
  wbs_path: '1.3',
  name: 'Legacy handover',
  parent_id: 'phase-1',
  status: 'REVIEW',
  board_lane: 'deleted-lane',
  ...commonTaskShape(),
};

/**
 * Mocks every endpoint the board reads, then a stateful `**\/api\/v1\/tasks\/**`
 * handler registered LAST so it wins for both the list GET and the detail PATCH.
 *
 * Statefulness is not optional here: `useUpdateTaskStatus` invalidates
 * `['tasks', projectId]` in `onSuccess`, so a stateless list mock re-serves the
 * pre-move fixture and erases the write within tens of milliseconds — green
 * locally, nondeterministically red on a loaded runner (#2752).
 */
async function setup(page: Page, initialTasks: Record<string, unknown>[]) {
  const liveTasks = initialTasks.map((t) => ({ ...t }));
  const patches: Record<string, unknown>[] = [];

  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: liveTasks,
    boardConfig: LANED_BOARD_CONFIG,
    statusSummary: { task_count: liveTasks.length },
  });

  await page.route('**/api/v1/tasks/**', async (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const segments = new URL(req.url()).pathname.split('/').filter(Boolean);
      const taskId = segments[segments.length - 1];
      const body = req.postDataJSON() as Record<string, unknown>;
      patches.push({ id: taskId, ...body });
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

  return { patches };
}

/** Wait for the board grid itself, not just any element — the cells are what these assert on. */
async function gotoBoard(page: Page) {
  await page.goto(`${BASE_URL}/board`);
  await expect(page.getByTestId('board-cell-phase-1-REVIEW#review')).toBeVisible();
}

async function dragCardOnto(page: Page, cardName: string, targetTestId: string) {
  const card = page.getByRole('button', { name: new RegExp(`^${cardName}`) }).first();
  await expect(card).toBeVisible();
  const target = page.getByTestId(targetTestId);
  // Splitting Review into two tracks widens the grid past the default viewport,
  // and `page.mouse` is viewport-relative — an off-screen bounding box yields
  // coordinates the browser silently discards, so the drag looks like it ran and
  // sent nothing. Bring the target on-screen, then measure. (The describe block
  // also widens the viewport; both are needed once a board has enough tracks.)
  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  const cardBox = await card.boundingBox();
  if (!targetBox || !cardBox) throw new Error('missing bounding box for drag source or target');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  // Cross dnd-kit's 4px activation distance before aiming at the target.
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 10, cardBox.y + cardBox.height / 2, {
    steps: 3,
  });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
}

test.describe('Named board lanes over the canonical statuses (#2967)', () => {
  // A laned board is wider than the default 1280px: the backlog rail plus five
  // tracks overflow it, and a drag target outside the viewport cannot be hit.
  test.use({ viewport: { width: 1800, height: 900 } });

  test('a laned column renders one track per lane, still under one status', async ({ page }) => {
    await setup(page, [PHASE, UNASSIGNED_CARD, QA_CARD]);
    await gotoBoard(page);

    // Two Review tracks…
    await expect(page.getByTestId('board-cell-phase-1-REVIEW#review')).toBeVisible();
    await expect(page.getByTestId('board-cell-phase-1-REVIEW#qa')).toBeVisible();
    // …and no undivided Review cell, which is what would appear if the track
    // expansion silently fell back to the column list.
    await expect(page.getByTestId('board-cell-phase-1-REVIEW')).toHaveCount(0);

    // The unladen columns are untouched — lanes are opt-in per column.
    await expect(page.getByTestId('board-cell-phase-1-IN_PROGRESS')).toBeVisible();
    await expect(page.getByTestId('board-cell-phase-1-COMPLETE')).toBeVisible();
  });

  test('a lane header names the lane and prefixes its column for a screen reader', async ({
    page,
  }) => {
    await setup(page, [PHASE, UNASSIGNED_CARD, QA_CARD]);
    await gotoBoard(page);

    // "QA" alone does not say which column it belongs to; the accessible name
    // carries the column so the header row is legible read in isolation.
    await expect(page.getByRole('heading', { name: /^Review, QA, 1 task/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Review, Peer review, / })).toBeVisible();
  });

  test('cards land in their configured lane, and an unset lane falls to the first', async ({
    page,
  }) => {
    await setup(page, [PHASE, UNASSIGNED_CARD, QA_CARD, ORPHAN_CARD]);
    await gotoBoard(page);

    const first = page.getByTestId('board-cell-phase-1-REVIEW#review');
    const qa = page.getByTestId('board-cell-phase-1-REVIEW#qa');

    await expect(first.getByText('Verify torque values')).toBeVisible();
    await expect(qa.getByText('Regression sweep')).toBeVisible();
    // A key left behind by a deleted lane resolves to the first lane rather than
    // vanishing — which is what makes deleting a lane need no data migration.
    await expect(first.getByText('Legacy handover')).toBeVisible();
  });

  test('dragging between lanes sends board_lane and leaves status canonical', async ({ page }) => {
    const { patches } = await setup(page, [PHASE, UNASSIGNED_CARD, QA_CARD]);
    await gotoBoard(page);

    await dragCardOnto(page, 'Verify torque values', 'board-cell-phase-1-REVIEW#qa');

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const patch = patches[patches.length - 1];
    expect(patch.id).toBe('card-unassigned');
    expect(patch.board_lane).toBe('qa');
    // The load-bearing assertion of the whole issue: the status did not move.
    expect(patch.status).toBe('REVIEW');

    // And the card is where it was dropped, after the success refetch lands.
    await expect(
      page.getByTestId('board-cell-phase-1-REVIEW#qa').getByText('Verify torque values'),
    ).toBeVisible();
  });

  test('dropping into an unladen column clears the lane', async ({ page }) => {
    const { patches } = await setup(page, [PHASE, QA_CARD]);
    await gotoBoard(page);

    await dragCardOnto(page, 'Regression sweep', 'board-cell-phase-1-COMPLETE');

    await expect.poll(() => patches.length).toBeGreaterThan(0);
    const patch = patches[patches.length - 1];
    expect(patch.status).toBe('COMPLETE');
    // '' is meaningful, not a missing field: a retained key would resurrect the
    // card into QA if it ever came back to Review.
    expect(patch.board_lane).toBe('');
  });
});

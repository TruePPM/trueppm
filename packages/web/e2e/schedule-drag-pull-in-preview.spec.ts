/**
 * Drag-preview downstream fidelity, end to end (#3586, covering #3535/!2401).
 *
 * !2401 fixed two defects that both made the preview under-report what a move
 * costs, and shipped with component-level coverage only. This is the deferred
 * user-visible half: the same two mechanisms plus the milestone announcement,
 * driven through the real keyboard-reschedule gesture, the real `buildSubgraph`,
 * the real CPM Web Worker, and the real `PreviewOverlay` render site.
 *
 *  1. Relaxation is bidirectional. Pulling a zero-slack sole-predecessor chain
 *     EARLIER moves its successor earlier too. Before !2401 `relaxForward` wrote
 *     a successor's window only when it landed LATER, so the ordinary "we
 *     finished early, pull it in" gesture showed nothing downstream at all.
 *  2. A successor gated on a SUMMARY is in the preview at all. Before !2401
 *     `buildSubgraph` BFS'd literal `TaskLink` rows, and a summary's children
 *     are WBS containment — so a drag starting inside a phase never reached the
 *     work waiting on that phase. The successor was ABSENT, not miscalculated.
 *  3. The milestone headline reads "moves N days earlier" for a pull-in. The
 *     scan that picks the headline seeded its best delta at 0 and discarded
 *     every negative one, so the announcement said "on schedule" about a
 *     milestone the drag had just pulled in by a week.
 *
 * WHAT MADE `worstMilestone` NULL — three independent causes, all live at once.
 *
 * #3586 records that the first attempt at this spec was abandoned because
 * `worstMilestone` stayed null and the cause could not be established. It is not
 * one cause. Each of these three produces a null milestone on its own, so fixing
 * any one of them leaves the symptom exactly as it was:
 *
 *  a. THE WORKER NEVER RAN (#3593, fixed in this branch). `createCpmWorker` built
 *     its `new Worker(new URL(...))` in two statements, which kept Vite's worker
 *     plugin from compiling `cpmWorker.ts` but not its asset plugin from copying
 *     it in verbatim — so every production build shipped the worker as a
 *     `data:video/mp2t;base64,<raw TypeScript>` URL the browser cannot execute.
 *     No RESULT message was ever posted, in any build, for any fixture: not just
 *     no milestone, no preview at all. Everything below is downstream of this.
 *  b. THE FIXTURE'S SNET PINNED EVERY SUCCESSOR. `planned_start` is a
 *     start-no-earlier-than date, and !2401 made it load-bearing precisely
 *     because the pass can now pull tasks earlier. A fixture that sets
 *     `planned_start` equal to each task's own `early_start` — which is what
 *     `schedule-preview-overlay.spec.ts` does — therefore clamps every successor
 *     back to where it already sits: `deltaDays` is 0, and a 0 delta yields no
 *     headline by the engine's documented "nothing moved => no milestone"
 *     contract. Confirmed against the real `buildSubgraph` + `runCpmForwardPass`
 *     pair: with SNET mirrored onto the successor `worstMilestone` is null; with
 *     it absent the same drag reports `deltaDays: -7`. So do not "tidy"
 *     `planned_start: null` here into mirroring `early_start` — the anchor
 *     carries a committed start and its CPM-scheduled successors do not, which
 *     is also the realistic shape (`missingCommittedStart.ts` exists because
 *     downstream work routinely has no SNET of its own).
 *  c. THE DATA DATE DEFAULTED TO TODAY. `ScheduleView` falls back to today when a
 *     project serializes `status_date: null`, and ADR-0132 §1 floors the dragged
 *     task's previewed start at it — so a fixture dated in the past previews
 *     every drag as a jump to today (~1860px here) and nothing downstream means
 *     anything. Hence `status_date` on the project fixture below.
 *
 * Only (a) is a product defect. (b) and (c) are fixture faults, and both are
 * the kind that produce a plausible-looking null rather than an error.
 *
 * Geometry note: `ScheduleAriaOverlay`'s options and `PreviewOverlay`'s ghost
 * bars are two `inset: 0` layers over the same canvas host, and an option is
 * positioned at exactly the box the canvas paints that task's bar in — so a
 * ghost bar belongs to the task whose option shares its top edge. That is how a
 * bar is attributed to a task below without hardcoding `ROW_HEIGHT`, which is a
 * live binding that changes with the pointer class.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-pullin-0000-0000-0000-000000003586';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Pull-In Preview Project',
    description: '',
    start_date: '2026-03-02',
    // The data date, and NOT optional. `ScheduleView` falls back to TODAY when a
    // project serializes `status_date: null`, and ADR-0132 §1 floors the dragged
    // task's previewed start at it — so against a fixture whose dates are in the
    // past every drag previews as a jump to today, ~1860px of it here, and none
    // of the downstream assertions below mean anything. Pin it before the
    // fixture's own dates so the drag is the only thing moving.
    status_date: '2026-03-02',
    calendar: 'default',
  },
];

interface TaskOverrides {
  planned_start?: string | null;
  parent_id?: string | null;
  is_summary?: boolean;
  is_milestone?: boolean;
  duration?: number;
}

/**
 * A schedule row in the API's task shape.
 *
 * `planned_start` defaults to null — see the SNET note in the file header. Only
 * the task a test actually drags is given a committed start.
 */
function task(
  id: string,
  name: string,
  wbs: string,
  start: string,
  finish: string,
  overrides: TaskOverrides = {},
) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: start,
    early_finish: finish,
    planned_start: null,
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    assignments: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    notes: '',
    ...overrides,
  };
}

function dependency(id: string, predecessor: string, successor: string) {
  return { id, predecessor, successor, dep_type: 'FS', lag: 0, is_critical: false };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * The viewport top of a task's bar, read from its ARIA-overlay option.
 *
 * `ScheduleAriaOverlay` positions each option at exactly the geometry the canvas
 * paints that task's bar with, so the option's top IS the row's bar top — which
 * is what attributes a ghost bar to a task below without hardcoding `ROW_HEIGHT`
 * (a live binding that changes with the pointer class).
 */
async function barTopFor(page: Page, taskName: string): Promise<number> {
  const option = page.locator(`[role="option"][aria-label*="${taskName}"]`).first();
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  expect(box, `bar box for ${taskName}`).not.toBeNull();
  return box!.y;
}

/**
 * Every preview ghost bar currently painted, as viewport-space boxes.
 *
 * A preview bar is the only thing in this overlay drawn with a SOLID border of
 * non-zero width: the rule-52 origin ghost and the #344 build ghost are both
 * `dashed`, and the bars band and the three corner chips have no border at all.
 * The width test is load-bearing — Tailwind's preflight sets `border-style:
 * solid` globally, so `borderStyle` alone matches every div in the overlay.
 */
async function previewBars(page: Page): Promise<{ top: number; left: number }[]> {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="preview-overlay"]');
    if (!overlay) return [];
    return Array.from(overlay.querySelectorAll('div'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return style.borderStyle === 'solid' && parseFloat(style.borderTopWidth) > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, left: rect.left };
      });
  });
}

/** The left edge of the preview bar on the row whose bar top is `barTop`, or null. */
async function previewBarLeft(page: Page, barTop: number): Promise<number | null> {
  const bars = await previewBars(page);
  const hit = bars.find((b) => Math.abs(b.top - barTop) <= 1);
  return hit ? hit.left : null;
}

/** Focus a task's bar and start a keyboard reschedule on it (the `r` binding). */
async function enterReschedule(page: Page, taskName: string): Promise<void> {
  // Focus, don't click: the ARIA overlay is pointer-events-none by design (rule
  // 27) and the interaction canvas underneath takes the pointer, so a click
  // never lands on an option.
  await page.locator(`[role="option"][aria-label*="${taskName}"]`).first().focus();
  await page.keyboard.press('r');
  await expect(page.getByTestId('preview-overlay')).toBeVisible();
}

/**
 * Settle the preview at delta 0 and return the bar positions there.
 *
 * The first RECALC only fires on an arrow key, so nudge one working day out and
 * straight back. Delta 0 re-runs the pass at the task's own committed start,
 * which is the preview's picture of "nothing has moved" — and, for a pull-in,
 * the state the pre-!2401 build never left. The settle condition is the dragged
 * task's preview bar coinciding with its rule-52 origin ghost, which is pinned
 * to the pre-nudge position and therefore is the one on-screen fact that says
 * the delta-0 result has landed rather than the delta+1 one.
 */
async function settleAtZeroDelta(page: Page, anchorTop: number) {
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');

  const originLeft = await page
    .getByTestId('preview-overlay')
    .locator('div[style*="dashed"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().left);

  await expect
    .poll(async () => {
      const left = await previewBarLeft(page, anchorTop);
      return left === null ? null : Math.round(left - originLeft);
    })
    .toBe(0);

  return originLeft;
}

// ---------------------------------------------------------------------------
// Mechanisms 1 and 3 — a zero-slack chain pulled earlier
// ---------------------------------------------------------------------------

// Foundation → Framing → Structure complete, FS lag 0, contiguous Mon–Fri weeks
// and therefore zero slack. Only Foundation carries a committed start.
const CHAIN_TASKS = [
  task('pull-anchor', 'Foundation', '1', '2026-04-06', '2026-04-10', {
    planned_start: '2026-04-06',
  }),
  task('pull-successor', 'Framing', '2', '2026-04-13', '2026-04-17'),
  task('pull-milestone', 'Structure complete', '3', '2026-04-20', '2026-04-20', {
    is_milestone: true,
    duration: 0,
  }),
];

const CHAIN_DEPS = [
  dependency('pull-dep-1', 'pull-anchor', 'pull-successor'),
  dependency('pull-dep-2', 'pull-successor', 'pull-milestone'),
];

test.describe('Drag preview propagates a pull-in downstream (#3535 mechanism 1)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: CHAIN_TASKS,
      dependencies: CHAIN_DEPS,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    // Gate on the canvas overlay having rendered its rows, not on the toolbar:
    // the preview overlay mounts inside CanvasScheduleTimeline and only exists
    // once the task read has resolved.
    await expect(page.getByRole('option', { name: /Foundation/ })).toBeVisible();
  });

  test('a zero-slack sole successor moves earlier with its predecessor', async ({ page }) => {
    const anchorTop = await barTopFor(page, 'Foundation');
    const successorTop = await barTopFor(page, 'Framing');

    await enterReschedule(page, 'Foundation');
    await settleAtZeroDelta(page, anchorTop);

    const baselineAnchor = await previewBarLeft(page, anchorTop);
    const baselineSuccessor = await previewBarLeft(page, successorTop);
    expect(baselineAnchor, 'anchor preview bar at delta 0').not.toBeNull();
    expect(baselineSuccessor, 'successor preview bar at delta 0').not.toBeNull();

    // Pull the anchor a full working week earlier.
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');

    // The chain has zero slack, so it shifts RIGIDLY: the successor's bar must
    // travel exactly as far as the dragged bar did. Stating it as an equality
    // rather than "moved left a bit" is what makes the pre-!2401 answer legible
    // in the failure message — forward-only relaxation leaves the successor at
    // shift 0 while the anchor has moved a week.
    await expect
      .poll(async () => {
        const anchor = await previewBarLeft(page, anchorTop);
        const successor = await previewBarLeft(page, successorTop);
        if (anchor === null) return 'anchor bar missing';
        if (successor === null) return 'successor bar missing';
        const anchorShift = Math.round(baselineAnchor! - anchor);
        const successorShift = Math.round(baselineSuccessor! - successor);
        if (anchorShift <= 0) return `anchor has not moved yet (shift ${anchorShift}px)`;
        return successorShift === anchorShift
          ? 'chain shifted rigidly'
          : `successor shifted ${successorShift}px, anchor shifted ${anchorShift}px`;
      })
      .toBe('chain shifted rigidly');
  });

  test('the milestone headline says the pull-in moves it earlier, not "on schedule"', async ({
    page,
  }) => {
    const anchorTop = await barTopFor(page, 'Foundation');

    await enterReschedule(page, 'Foundation');
    await settleAtZeroDelta(page, anchorTop);

    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');

    // `PreviewOverlay` and the delta tooltip are both aria-hidden (rule 27), so
    // this polite region is the ONLY channel that reaches a screen reader. The
    // magnitude is in calendar days, which is what `deltaDays` measures: a
    // five-working-day pull spans the weekend and moves the milestone from
    // 2026-04-20 to 2026-04-13.
    await expect(page.getByTestId('schedule-act-live')).toHaveText(
      'Structure complete moves 7 days earlier',
    );
  });
});

// ---------------------------------------------------------------------------
// Mechanism 2 — a successor gated on a summary
// ---------------------------------------------------------------------------

// Design Phase is a summary over two leaves; the work waiting on the phase is
// linked to the SUMMARY, not to either leaf. Dragging a leaf inside the phase
// has to reach it.
const SUMMARY_TASKS = [
  task('sum-phase', 'Design Phase', '1', '2026-04-06', '2026-04-17', { is_summary: true }),
  task('sum-leaf-a', 'Wireframes', '1.1', '2026-04-06', '2026-04-10', {
    parent_id: 'sum-phase',
    planned_start: '2026-04-06',
  }),
  task('sum-leaf-b', 'Mockups', '1.2', '2026-04-13', '2026-04-17', { parent_id: 'sum-phase' }),
  task('sum-gated', 'Client handover', '2', '2026-04-20', '2026-04-24'),
];

// The link the whole mechanism turns on: summary → leaf. There is no literal
// `TaskLink` row out of Wireframes at all.
const SUMMARY_DEPS = [dependency('sum-dep-1', 'sum-phase', 'sum-gated')];

test.describe('Drag preview reaches a summary-gated successor (#3535 mechanism 2)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: PROJECT_ID,
      tasks: SUMMARY_TASKS,
      dependencies: SUMMARY_DEPS,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(BASE_URL);
    await expect(page.getByRole('option', { name: /Wireframes/ })).toBeVisible();
  });

  test('the task waiting on the phase is previewed when a leaf inside it moves', async ({
    page,
  }) => {
    const gatedTop = await barTopFor(page, 'Client handover');

    await enterReschedule(page, 'Wireframes');
    // One nudge is enough: the preview payload carries every task in the
    // subgraph, so the question this asks is whether the BFS reached the gated
    // task at all — which is the defect. Before !2401 the subgraph out of a leaf
    // with no literal outgoing link was the leaf alone.
    await page.keyboard.press('ArrowRight');

    await expect
      .poll(() => previewBarLeft(page, gatedTop))
      .not.toBeNull();

    // And nothing else was dragged in with it: the drag root plus the one task
    // the summary link expands onto.
    await expect.poll(async () => (await previewBars(page)).length).toBe(2);
  });
});

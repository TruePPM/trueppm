/**
 * Declaring the hybrid split, end to end (#2736 + #2737).
 *
 * The act and its result ship together on purpose: a cascade with no visible
 * outcome is a popover that appears to do nothing. So each flow here ends on
 * what the outline shows, not on the request that was sent.
 *
 * Reads and the cascade share one stateful store (`setupTaskStore`). The
 * popover invalidates `['tasks', projectId]` on success, so a stateless task
 * mock would re-serve the pre-cascade fixture and the mode chip would appear
 * and then vanish — the #2752 class of flake, which no timeout can fix.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-class-0000-0000-0000-000000002736';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Hybrid Split Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(
  id: string,
  wbs: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...extra,
  };
}

// Phase 4 with three children, one of which is a gate. Mirrors the design
// handoff's case 04: 4.1 keeps a gated override, 4.2/4.3 go sprint-driven,
// and the gate must survive untouched.
const TASKS = [
  row('t4', '4', 'Build & integration', { is_summary: true }),
  row('t41', '4.1', 'Structural steel', {
    parent_id: 't4',
    governance_class: 'gated',
    parent_governance_inherited: false,
  }),
  row('t42', '4.2', 'Control software', { parent_id: 't4' }),
  row('t43', '4.3', 'Comms cutover', { parent_id: 't4' }),
  row('t4g', '4.4', 'Integration gate', {
    parent_id: 't4',
    is_milestone: true,
    delivery_mode: 'milestone',
    duration: 0,
  }),
];

test.describe('Hybrid classification — declare it once, then see it (#2736/#2737)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECT_ID,
      tasks: TASKS,
    });
    // Registered last so it owns the task reads AND the cascade write.
    await setupTaskStore(page, { tasks: TASKS });
  });

  test('⌘⇧M on the focused row opens the popover naming the subtree', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Build & integration');
    await expect(popover).toContainText('4 descendants');
  });

  test('says nothing about the undo floor to a caller who can undo (#3357)', async ({ page }) => {
    // The negative half of the disclosure. `setupApiMocks` defaults
    // `can_undo_batch_operations` to true, which is the Admin this whole describe
    // models — so the note must be absent, and its absence must be gated on the
    // popover having actually rendered or it passes against an empty DOM.
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('classification-preview')).toBeVisible();
    await expect(popover.getByTestId('classification-undo-floor')).toHaveCount(0);
  });

  test('the row menu reaches the same popover without knowing the shortcut', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Classification/ })
      .click();
    await expect(page.getByTestId('classification-popover')).toBeVisible();
  });

  test('the preview names the milestone it will not touch, before applying', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-preset-scrum').click();

    const preview = page.getByTestId('classification-preview');
    await expect(preview).toContainText('1 milestone unchanged');
    await expect(preview).toContainText('a gate is not a delivery mode');
    // Only governance can report an override count; delivery mode says why not.
    await expect(preview).toContainText('governance overrides kept');
    await expect(preview).toContainText('has no inherit bit');
  });

  test('applying a preset makes the split visible in the outline', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    // Just this row, so the phase ends up genuinely mixed.
    await page.getByTestId('classification-cascade').uncheck();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    await expect(page.getByTestId('classification-popover')).toHaveCount(0);

    // The result, not the request: 4.2 reads SCRUM and its parent reads MIXED
    // because 4.1/4.3 are still gated.
    const row42 = page.getByRole('row').filter({ hasText: 'Control software' });
    await expect(row42.getByTestId('mode-chip')).toHaveText('SCRUM');
    const phase = page.getByRole('row').filter({ hasText: 'Build & integration' });
    await expect(phase.getByTestId('mode-chip')).toHaveText('MIXED');
  });

  test('⌘Z on the toast undoes the cascade and restores the prior mode chip (#2756)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-cascade').uncheck();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    const row42 = page.getByRole('row').filter({ hasText: 'Control software' });
    await expect(row42.getByTestId('mode-chip')).toHaveText('SCRUM');

    const toast = page.getByRole('status').filter({ hasText: 'Classified' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Undo' }).click();

    // The result, not the request: 4.2's chip is gone — it reverted to
    // waterfall (the baseline draws no chip at all).
    await expect(page.getByRole('status').filter({ hasText: 'Undone' })).toBeVisible();
    await expect(row42.getByTestId('mode-chip')).toHaveCount(0);
  });

  test('the gate keeps its delivery mode through a cascade over the whole phase', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    // Every non-milestone row is now scrum, so the phase reads SCRUM rather
    // than MIXED — the gate contributed nothing, which is the invariant.
    const phase = page.getByRole('row').filter({ hasText: 'Build & integration' });
    await expect(phase.getByTestId('mode-chip')).toHaveText('SCRUM');
    const gate = page.getByRole('row').filter({ hasText: 'Integration gate' });
    await expect(gate.getByTestId('mode-chip')).toHaveCount(0);
  });

  // #3040: the canvas is aria-hidden, so the overlay's option IS the timeline's
  // only text channel. It used to build its mode suffix from the row's own
  // stored field while the chip two feet to the left was built from the rolled-up
  // subtree — so the mixed state reached a sighted user as a color band and a
  // texture and reached a screen-reader user not at all (WCAG 1.4.1).
  test('the timeline announces the phase as MIXED, in the same words as the outline chip', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-cascade').uncheck();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    const phase = page.getByRole('row').filter({ hasText: 'Build & integration' });
    await expect(phase.getByTestId('mode-chip')).toHaveText('MIXED');

    const phaseBar = page.locator('[role="option"][data-task-id="t4"]');
    await expect(phaseBar).toHaveAttribute('aria-label', /Mixed delivery/);
    // Names the constituents, not just that something is mixed.
    await expect(phaseBar).toHaveAttribute('aria-label', /waterfall and scrum/);

    // And the leaf that was actually cascaded says the single mode, so the two
    // rows are distinguishable by speech alone.
    const leafBar = page.locator('[role="option"][data-task-id="t42"]');
    await expect(leafBar).toHaveAttribute('aria-label', /Scrum delivery/);
  });

  test('a waterfall plan carries no mode chips at all', async ({ page }) => {
    // The baseline draws nothing, matching the canvas. A 400-row waterfall plan
    // must not carry 400 identical marks.
    await page.goto(BASE_URL);
    await expect(page.getByText('Build & integration')).toBeVisible();
    await expect(page.getByTestId('mode-chip')).toHaveCount(0);
    await expect(page.getByTestId('mode-gutter')).toHaveCount(0);
  });

  /**
   * The refusal path (#3302).
   *
   * Registered inside each test rather than in `beforeEach`, so it lands AFTER
   * `setupTaskStore`'s own classification route and wins — Playwright matches in
   * reverse registration order. A stateless refusal is correct here: the cascade
   * is rejected, nothing is written, and nothing refetches, so there is no
   * post-write DOM state for a stateless mock to erase.
   */
  async function refuseCascade(
    page: Page,
    status: number,
    body: Record<string, unknown>,
  ): Promise<void> {
    await page.route(/\/api\/v1\/projects\/[^/]+\/tasks\/classification\/$/, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      return route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
  }

  async function openAndApply(page: Page): Promise<void> {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await expect(page.getByTestId('classification-popover')).toBeVisible();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();
  }

  test('a 403 reaches the planner as the server wrote it, with no Retry offered', async ({
    page,
  }) => {
    await refuseCascade(page, 403, {
      detail: 'Your role cannot author 3 of the 4 tasks in this subtree.',
    });
    await openAndApply(page);

    // The sentence, not the generic fallback — a PM refused on a permission
    // boundary can now see which part of the subtree blocked it.
    const slot = page.getByTestId('classification-error');
    await expect(slot).toContainText('Your role cannot author 3 of the 4 tasks in this subtree.');
    // Announced as an alert, and NOT nested in the preview's atomic status region.
    await expect(slot).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('classification-preview')).not.toContainText(
      'Your role cannot author',
    );
    // Retrying an authorization decision is refused identically, so it is not offered.
    await expect(page.getByTestId('classification-apply')).toHaveText('Apply to subtree');
    // The popover stays open holding the reason, and nothing pretends a write landed.
    await expect(page.getByTestId('classification-popover')).toBeVisible();
    await expect(page.getByTestId('mode-chip')).toHaveCount(0);
  });

  test('subtree_too_large renders the counts it refused on', async ({ page }) => {
    await refuseCascade(page, 400, {
      code: 'subtree_too_large',
      detail: 'Subtree resolves 2500 tasks, above the 2000-task cap.',
      matched: '2500',
      max: '2000',
    });
    await openAndApply(page);

    const slot = page.getByTestId('classification-error');
    await expect(slot).toContainText('2500');
    await expect(slot).toContainText('2000');
    // And what to do about it, which the bare cap violation never said.
    await expect(slot).toContainText('Cascade to descendants');
    await expect(page.getByTestId('classification-apply')).toHaveText('Apply to subtree');

    // Taking the remedy retires the message: it described a request the planner
    // is no longer making, and the button has already recomputed.
    await page.getByTestId('classification-cascade').uncheck();
    await expect(slot).toHaveCount(0);
    await expect(page.getByTestId('classification-apply')).toHaveText('Apply to task');
  });

  test('a 5xx still offers a Retry — the suppression is targeted, not blanket', async ({
    page,
  }) => {
    await refuseCascade(page, 500, { detail: 'Server error.' });
    await openAndApply(page);

    await expect(page.getByTestId('classification-apply')).toHaveText('Retry');
  });

  test('Escape closes the popover without writing anything', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await expect(page.getByTestId('classification-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('classification-popover')).toHaveCount(0);
    await expect(page.getByTestId('mode-chip')).toHaveCount(0);
  });
});

/**
 * The Undo the caller's role may actually use (#3304).
 *
 * A separate describe because it needs a different `setupTaskStore` — the store
 * has no role of its own, so the server's `can_undo` verdict is an option on it.
 * The Admin case is already covered by the "⌘Z on the toast undoes the cascade"
 * test above, which runs against the default `can_undo: true`.
 *
 * Asserted at the toast, not at the endpoint: the undo endpoint has always
 * refused a Member correctly (pytest pins that). The defect was that the client
 * offered the control anyway, in an 8-second window with no second route to the
 * undo — so a spec that only drove the 403 would have passed on the broken build.
 */
test.describe('Classification undo — withheld when the server says the role cannot (#3304)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    // A Member, stated on BOTH payloads because the client reads two (#3357). The
    // project detail's `can_undo_batch_operations` drives the pre-act disclosure in
    // the popover; the apply response's `can_undo` drives the post-act Undo on the
    // toast. They are the same server predicate, so a fixture that set only one
    // would model a state the real server cannot produce.
    await setupApiMocks(page, {
      projects: PROJECTS.map((p) => ({ ...p, can_undo_batch_operations: false })),
      projectId: PROJECT_ID,
      tasks: TASKS,
    });
    // A Member: `IsProjectPlanAuthor` admits the cascade, Admin+ gates the undo.
    await setupTaskStore(page, { tasks: TASKS, canUndoBatchOperations: false });
  });

  test('the popover says so BEFORE the cascade is applied (#3357)', async ({ page }) => {
    // The half #3304 deliberately left: it stopped offering an Undo this caller
    // could not use, which left them told nothing at all. Asserted on the Schedule
    // as well as the backlog because the prop reaches the popover by a different
    // route here — threaded down through `ScheduleOverlayLayer`, which renders the
    // popover and does not hold `projectDetail` itself. A dropped link in that
    // chain is a `tsc`-clean `undefined`, and `undefined` renders no note.
    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    const note = popover.getByTestId('classification-undo-floor');
    await expect(note).toBeVisible();
    await expect(note).toContainText('someone with Project Manager rights can');
    // The act itself is untouched — only its reversal is disclosed (rule 373(c)).
    // The preset click is what makes this non-vacuous: Apply is disabled until an
    // axis is named for every role, so asserting it on the initial render would
    // pass on a build that had disabled it for this caller too.
    await popover.getByTestId('classification-preset-scrum').click();
    await expect(popover.getByTestId('classification-apply')).toBeEnabled();
  });

  test('a Member gets the success toast with no Undo action', async ({ page }) => {
    // Registered before navigation: nothing should ever reach the Admin-only undo
    // route, and "no button" and "a button that quietly no-ops" look identical in a
    // DOM assertion alone.
    const undoAttempts: string[] = [];
    await page.route(/\/api\/v1\/cascade-classification-operations\/[^/]+\/undo\/$/, (route) => {
      undoAttempts.push(route.request().url());
      return route.fallback();
    });

    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-cascade').uncheck();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    // The cascade still happened, and the receipt still says so — this withholds
    // the undo, it does not withhold the confirmation.
    const row42 = page.getByRole('row').filter({ hasText: 'Control software' });
    await expect(row42.getByTestId('mode-chip')).toHaveText('SCRUM');

    const toast = page.getByRole('status').filter({ hasText: 'Classified' });
    await expect(toast).toBeVisible();
    // Gate on the toast being rendered (above) before asserting the button's
    // absence, so this cannot pass by racing an empty DOM.
    await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    // …and the 403 the user would have hit never happens.
    expect(undoAttempts).toHaveLength(0);
  });
});

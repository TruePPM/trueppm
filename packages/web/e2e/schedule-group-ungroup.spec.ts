/**
 * Group and Ungroup on the Schedule outline (#2955, epic #2946).
 *
 * The invariant worth a browser is **structural**: after a group the rows are one level
 * deeper under a new container and the level is renumbered; after `⌘Z` the outline is
 * byte-for-byte what it was. Not "a POST fired" — a request firing is exactly what a
 * broken restructure and a correct one have in common, which is the lesson #2957 and
 * #2974 both paid for. So every assertion here reads the tree back off the DOM
 * (`aria-level` plus the WBS code the planner actually reads) and compares.
 *
 * The mocks are **stateful**, for the reason `fixtures/task-store.ts` documents: the app
 * invalidates `['tasks', projectId]` in its own success handler, so a stateless list
 * route re-serves the pre-write rows and erases the very change under test — green
 * locally, nondeterministic on a loaded runner (#2752). `setupTaskStore` is not reused
 * because it models `PATCH /tasks/{id}/` and falls through `tasks/group/`,
 * `tasks/ungroup/` and `structural-operations/{id}/undo/`; the store below applies the
 * same principle to those three.
 *
 * The toolbar buttons ship **off** (`displayOptions.structureButtons`), so the spec opts
 * in the way a user does — and one test asserts the default from the other side, because
 * a ruling nothing checks is one the next toolbar change quietly reverses.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import {
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  setupScheduleDisplayOptions,
} from './fixtures';

const PROJECT_ID = 'e2e-group-0000000-0000-0000-0000-000000002955';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;
const GROUP_OP_ID = 'op-group-0000-0000-0000-000000002955';
const UNGROUP_OP_ID = 'op-ungrp-0000-0000-0000-000000002955';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Grouping Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

interface FixtureTask extends Record<string, unknown> {
  id: string;
  wbs_path: string;
  name: string;
  parent_id: string | null;
}

function taskRow(
  over: Partial<FixtureTask> & { id: string; wbs_path: string; name: string },
): FixtureTask {
  return {
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    is_phase: false,
    is_subtask: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...over,
  };
}

/**
 *   1  Survey
 *   2  Permits
 *   3  Closeout
 *
 * Flat on purpose: the issue exists because a flat list can only become structured from
 * the top down today, and the missing primitive is wrap. This is that list.
 */
const TASKS: FixtureTask[] = [
  taskRow({ id: 'gsurvey', wbs_path: '1', name: 'Survey' }),
  taskRow({ id: 'gpermits', wbs_path: '2', name: 'Permits' }),
  taskRow({ id: 'gcloseout', wbs_path: '3', name: 'Closeout' }),
];

interface GroupStore {
  groups: { task_ids: string[]; name?: string | null }[];
  ungroups: string[];
  undos: string[];
  /** Rows the next group response should report as left alone. */
  leftAlone: { id: string; reason: string; ancestor_id: string | null }[];
  /** Set to make the next group report a condition worth knowing about. */
  warning: string | null;
  /** Set to make the next group refuse the way a real selection rule does. */
  refuseWith: { code: string; detail: string } | null;
}

/**
 * A stateful outline: `group/` wraps rows in a new container, `ungroup/` dissolves one,
 * `undo/` restores the snapshot taken before the act.
 *
 * The undo is modeled as a snapshot restore rather than as an inverse because that is
 * what the server's ledger does (ADR-0880) and because it is the only version that can
 * fail the assertion honestly — an inverse computed from the same code that did the
 * forward act would agree with itself even when both are wrong.
 */
async function setupGroupStore(page: Page): Promise<GroupStore> {
  let rows: FixtureTask[] = TASKS.map((t) => ({ ...t }));
  let snapshot: FixtureTask[] | null = null;
  const store: GroupStore = {
    groups: [],
    ungroups: [],
    undos: [],
    leftAlone: [],
    warning: null,
    refuseWith: null,
  };
  let seq = 0;

  const recomputeFlags = () => {
    for (const row of rows) {
      const children = rows.filter((c) => c.parent_id === row.id);
      row.is_summary = children.length > 0;
      row.is_phase = children.some((c) => c.is_subtask !== true);
    }
  };

  /** Renumber a level top-to-bottom, carrying every subtree with it. */
  const renumber = () => {
    const byParent = (parentId: string | null) => rows.filter((r) => r.parent_id === parentId);
    const walk = (parentId: string | null, prefix: string) => {
      byParent(parentId).forEach((row, i) => {
        row.wbs_path = prefix ? `${prefix}.${i + 1}` : String(i + 1);
        walk(row.id, row.wbs_path);
      });
    };
    walk(null, '');
    // Depth-first order, so the outline reads the way the tree does.
    const ordered: FixtureTask[] = [];
    const push = (parentId: string | null) => {
      for (const row of byParent(parentId)) {
        ordered.push(row);
        push(row.id);
      }
    };
    push(null);
    rows = ordered;
  };

  await page.route('**/api/v1/tasks/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !url.pathname.endsWith('/tasks/')) {
      await route.fallback();
      return;
    }
    recomputeFlags();
    await route.fulfill({
      json: { count: rows.length, next: null, previous: null, results: rows },
    });
  });

  await page.route('**/api/v1/projects/*/tasks/group/', async (route) => {
    const body = route.request().postDataJSON() as { task_ids: string[]; name?: string | null };
    store.groups.push(body);
    if (store.refuseWith) {
      // A refusal writes nothing — the whole point of the transactional endpoint — so
      // the store must not mutate either, or the spec cannot tell the two apart.
      await route.fulfill({ status: 400, json: store.refuseWith });
      return;
    }
    snapshot = rows.map((r) => ({ ...r }));

    const wrapped = rows.filter((r) => body.task_ids.includes(r.id));
    const first = wrapped[0];
    seq += 1;
    const container = taskRow({
      id: `gcontainer-${seq}`,
      wbs_path: first.wbs_path,
      name: body.name?.trim() || 'New phase',
      parent_id: first.parent_id,
      is_summary: true,
      is_phase: true,
    });
    rows.splice(rows.indexOf(first), 0, container);
    for (const row of wrapped) row.parent_id = container.id;
    renumber();
    recomputeFlags();

    await route.fulfill({
      json: {
        container: {
          id: container.id,
          name: container.name,
          wbs_path: container.wbs_path,
          structure_role: 'container',
          parent_id: container.parent_id,
        },
        grouped_ids: wrapped.map((r) => r.id),
        left_alone: store.leftAlone,
        updated: rows.map((r) => ({ id: r.id, wbs_path: r.wbs_path })),
        warning: store.warning,
        operation_id: GROUP_OP_ID,
      },
    });
  });

  await page.route('**/api/v1/projects/*/tasks/ungroup/', async (route) => {
    const body = route.request().postDataJSON() as { task_id: string };
    store.ungroups.push(body.task_id);
    snapshot = rows.map((r) => ({ ...r }));

    const container = rows.find((r) => r.id === body.task_id);
    const children = rows.filter((r) => r.parent_id === body.task_id);
    for (const child of children) child.parent_id = container?.parent_id ?? null;
    rows = rows.filter((r) => r.id !== body.task_id);
    renumber();
    recomputeFlags();

    await route.fulfill({
      json: {
        container_id: body.task_id,
        lifted_ids: children.map((c) => c.id),
        removed_dependency_ids: [],
        updated: rows.map((r) => ({ id: r.id, wbs_path: r.wbs_path })),
        warning: null,
        operation_id: UNGROUP_OP_ID,
      },
    });
  });

  await page.route('**/api/v1/structural-operations/*/undo/', async (route) => {
    store.undos.push(new URL(route.request().url()).pathname.split('/').slice(-3, -2)[0]);
    if (snapshot) rows = snapshot.map((r) => ({ ...r }));
    snapshot = null;
    recomputeFlags();
    await route.fulfill({
      json: {
        status: 'undone',
        undo: {
          restored: rows.length,
          created_removed: 1,
          deleted_restored: 0,
          dependencies_restored: 0,
          dependencies_skipped: 0,
        },
      },
    });
  });

  return store;
}

/**
 * The outline's shape as the DOM reports it: row name → `"<wbs code>@<depth>"`.
 *
 * Two independent signals per row, because either alone can miss a real change.
 * `aria-level` is the nesting the tree exposes to assistive tech; the WBS code is what
 * the planner reads. A group both nests the wrapped rows *and* renumbers the level — a
 * restore that put the levels back but not the numbering would pass on one and fail on
 * the other.
 *
 * A row nested under a freshly-made phase reports `absent`: the Schedule folds a row the
 * moment it becomes a summary, so the child is genuinely not on screen. That is a real
 * part of the shape, and the assertion that matters — undo returns the outline to exactly
 * what it was — holds regardless of which side of the fold a row is on.
 */
async function outlineShape(page: Page, names: string[]): Promise<Record<string, string>> {
  const shape: Record<string, string> = {};
  for (const name of names) {
    const row = page.getByRole('row').filter({ hasText: name }).first();
    if ((await row.count()) === 0) {
      shape[name] = 'absent';
      continue;
    }
    const level = (await row.getAttribute('aria-level')) ?? '?';
    const code = new RegExp(`([\\d.]+)${name}`).exec((await row.textContent()) ?? '')?.[1] ?? '?';
    shape[name] = `${code}@${level}`;
  }
  return shape;
}

const NAMES = ['Survey', 'Permits', 'Closeout'];

async function outlineReady(page: Page) {
  for (const name of NAMES) {
    await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible();
  }
}

/**
 * Select Survey and Permits, then group them through the toolbar button.
 *
 * Deliberately the button rather than the ⌥⌘G chord. Both route through the same
 * handler, so the act under test is identical — but a global keystroke depends on
 * ambient DOM focus, and `useScheduleTasks`' 2 s `refetchInterval` re-renders the row
 * list on its own schedule; when that lands between the shift-click and the chord, the
 * roving tabindex re-seats focus and the selection is gone. The result is "nothing
 * happened", intermittently, only under worker contention (the #2974 lesson). ⌘Z *is*
 * exercised as a keystroke below, because that binding is the thing under test there.
 */
async function groupSurveyAndPermits(page: Page, store: GroupStore) {
  await page.getByRole('row').filter({ hasText: 'Survey' }).first().click();
  // A plain click on a row lands on its Name cell, which opens inline edit — so the
  // outline is now behind a focused `<input>`. Escape returns to RowFocused. Without it
  // the next act either types into the field or is swallowed by `isTypingInInput`.
  await leaveCellEdit(page);
  await page
    .getByRole('row')
    .filter({ hasText: 'Permits' })
    .first()
    .click({ modifiers: ['Shift'] });
  // The selection is the precondition for the act, so gate on it rather than on the
  // button's own enabled state — the button is enabled for a single focused row too.
  await expect(page.getByRole('row').filter({ hasText: 'Survey' }).first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('row').filter({ hasText: 'Permits' }).first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('group-rows-button').click();
  // Assert the act left the browser before assuming anything about the DOM: a click that
  // lands mid-re-render hits a node the handler is already detached from, and Playwright
  // reports a successful click either way.
  await expect.poll(() => store.groups.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // The phase opens straight into its name cell — "name it last" is the design, and this
  // is where it happens. Gating on the input is also what makes the Escape below
  // deterministic: `store.groups.length` rises when the REQUEST is recorded, which is
  // before `onSuccess` opens the editor, so an unconditional Escape here would fire into
  // the gap and the row would still be an `<input>` when the assertions read its text.
  const nameInput = page.getByRole('textbox', { name: /Rename task New phase/ });
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.press('Escape');
}

/** Escape out of an inline cell edit, leaving the row focused. */
async function leaveCellEdit(page: Page) {
  await page.keyboard.press('Escape');
}

test.describe('Schedule outline — Group and Ungroup (#2955)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupScheduleDisplayOptions(page, PROJECT_ID, { structureButtons: true });
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  });

  test('a group and its ⌘Z leave the outline in the same shape', async ({ page }) => {
    const store = await setupGroupStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    const before = await outlineShape(page, NAMES);
    expect(before).toEqual({ Survey: '1@1', Permits: '2@1', Closeout: '3@1' });

    await groupSurveyAndPermits(page, store);

    // Visible order, not click order — the server's majority-parent tie-break is defined
    // on request order, so a Set's insertion order would pick a different parent.
    expect(store.groups[0].task_ids).toEqual(['gsurvey', 'gpermits']);
    // No name in the request: the design names the phase LAST.
    expect(store.groups[0].name ?? null).toBeNull();

    // The act landed as *structure*, on both signals: the two rows are one level deeper
    // under a new container (`1.1@2`, `1.2@2`) and Closeout renumbered from 3 to 2. The
    // new phase stays expanded — a group that folded the work away the instant it was
    // wrapped would hide the thing the user just acted on.
    await expect
      .poll(async () => await outlineShape(page, NAMES), { timeout: 20_000 })
      .toEqual({ Survey: '1.1@2', Permits: '1.2@2', Closeout: '2@1' });
    await expect(page.getByRole('row').filter({ hasText: 'New phase' }).first()).toBeVisible();

    // ⌘Z, as a keystroke, because the promise the copy makes is about that keystroke.
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => store.undos).toEqual([GROUP_OP_ID]);

    // The assertion the issue is about: the *structure* came back, not just a 200.
    await expect
      .poll(async () => await outlineShape(page, NAMES), { timeout: 20_000 })
      .toEqual(before);
  });

  test('the outcome states the consequence, and names the rows it left alone', async ({
    page,
  }) => {
    const store = await setupGroupStore(page);
    // The rule the design is explicit about: a row whose own ancestor is also selected is
    // already inside the phase, so the server drops it — and the user has to be told, or
    // a group that wrapped two of three reads as a bug.
    store.leftAlone = [{ id: 'gcloseout', reason: 'ancestor_selected', ancestor_id: 'gsurvey' }];
    await page.goto(BASE_URL);
    await outlineReady(page);

    await groupSurveyAndPermits(page, store);

    const notice = page.getByTestId('group-outcome-notice');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('2 items are now a phase.');
    await expect(notice).toContainText('roll up from the work inside');
    await expect(notice).toContainText('⌘Z undoes the whole group');
    await expect(page.getByTestId('group-left-alone')).toContainText(
      '1 row stayed where it was',
    );
    await expect(page.getByTestId('group-left-alone')).toContainText(
      'already sits inside another row you selected',
    );
  });

  test('an ungroup lifts the rows back out, and ⌘Z puts the phase back', async ({ page }) => {
    const store = await setupGroupStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    const before = await outlineShape(page, NAMES);
    // Pinned to a literal, not just captured: `outlineShape` falls back to `'?'` when its
    // WBS regex misses, so an unpinned `before` would become `{…:'?@1'}` on BOTH sides of
    // the round-trip and `toEqual(before)` would pass having compared nothing.
    expect(before).toEqual({ Survey: '1@1', Permits: '2@1', Closeout: '3@1' });
    await groupSurveyAndPermits(page, store);
    await expect
      .poll(async () => (await outlineShape(page, NAMES)).Closeout, { timeout: 20_000 })
      .toBe('2@1');

    // Focus the phase and dissolve it. Its own key, not ⌥← — outdenting one row moves
    // that row; dissolving a phase moves everything it held.
    const phase = page.getByRole('row').filter({ hasText: 'New phase' }).first();
    await expect(phase).toBeVisible();
    // Click, and do NOT Escape: the row's own Esc handler is `focus.clear()`, which would
    // throw away the very target the button reads. A row click opens its Name cell, and
    // `deriveUngroupTarget` reads the focused row either way — cell-edit is a state of
    // the same focused row, not a different one.
    await phase.click();
    await expect(page.getByTestId('ungroup-rows-button')).toBeEnabled();
    await page.getByTestId('ungroup-rows-button').click();
    await expect.poll(() => store.ungroups.length, { timeout: 10_000 }).toBe(1);

    // Only the wrapper went: the rows are back at the top level, in their original order.
    await expect
      .poll(async () => await outlineShape(page, NAMES), { timeout: 20_000 })
      .toEqual(before);
    await expect(page.getByRole('row').filter({ hasText: 'New phase' })).toHaveCount(0);
    await expect(page.getByTestId('group-outcome-notice')).toContainText(
      'New phase is no longer a phase.',
    );

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => store.undos).toEqual([UNGROUP_OP_ID]);
    await expect(page.getByRole('row').filter({ hasText: 'New phase' }).first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('⌥⌘G groups the selection from the keyboard alone', async ({ page }) => {
    // The chord is the *primary* route — the buttons ship off — so it needs its own
    // coverage rather than riding on the button's.
    const store = await setupGroupStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    const survey = page.getByRole('row').filter({ hasText: 'Survey' }).first();
    await survey.click();
    await leaveCellEdit(page);
    // Row-level keys are React handlers on the row element, so the row must hold DOM
    // focus — Escape leaves the cell's input, which does not put it back.
    await survey.focus();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.getByRole('row').filter({ hasText: 'Permits' }).first()).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('ControlOrMeta+Alt+g');

    await expect.poll(() => store.groups.length, { timeout: 10_000 }).toBe(1);
    expect(store.groups[0].task_ids).toEqual(['gsurvey', 'gpermits']);
    await expect
      .poll(async () => (await outlineShape(page, NAMES)).Closeout, { timeout: 20_000 })
      .toBe('2@1');
  });

  test('a refused group says which rule it hit, and changes nothing', async ({ page }) => {
    // A refusal is a *designed* outcome here — a selection entirely nested inside itself,
    // a phase carrying drawer subtasks — and the endpoint's whole shape exists so that
    // one writes nothing. "Nothing was changed" is only worth saying if it is true, and
    // this is the only place that can be shown rather than asserted in prose.
    const store = await setupGroupStore(page);
    store.refuseWith = { code: 'nothing_to_group', detail: 'server sentence the client ignores' };
    await page.goto(BASE_URL);
    await outlineReady(page);
    const before = await outlineShape(page, NAMES);
    expect(before).toEqual({ Survey: '1@1', Permits: '2@1', Closeout: '3@1' });

    await page.getByRole('row').filter({ hasText: 'Survey' }).first().click();
    await leaveCellEdit(page);
    await page
      .getByRole('row')
      .filter({ hasText: 'Permits' })
      .first()
      .click({ modifiers: ['Shift'] });
    await expect(page.getByRole('row').filter({ hasText: 'Permits' }).first()).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByTestId('group-rows-button').click();
    await expect.poll(() => store.groups.length, { timeout: 10_000 }).toBe(1);

    await expect(page.getByText(/sits inside another one you selected/i)).toBeVisible({
      timeout: 15_000,
    });
    // Refusing means refusing: the outline is untouched, and no outcome strip claims a
    // phase was made.
    expect(await outlineShape(page, NAMES)).toEqual(before);
    await expect(page.getByTestId('group-outcome-notice')).toHaveCount(0);
  });

  test('a group that leaves assignments on the parent says so', async ({ page }) => {
    const store = await setupGroupStore(page);
    store.warning = 'has_assignments';
    await page.goto(BASE_URL);
    await outlineReady(page);

    await groupSurveyAndPermits(page, store);

    await expect(page.getByTestId('group-outcome-warning')).toContainText(
      'assigned to it directly',
      { timeout: 15_000 },
    );
    // Never the raw token — humanized or explained, never leaked (web rule 301(c)).
    await expect(page.getByTestId('group-outcome-warning')).not.toContainText('has_assignments');
  });

  test('the structure buttons are absent until the Display option turns them on', async ({
    browser,
  }) => {
    // The default from the other side. `⌥⌘G` and `⇥` already make phases, so the leaner
    // reading won (#2959) — and a ruling nothing asserts is one the next toolbar change
    // quietly reverses.
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await setupAuth(fresh);
    await setupCatchAll(fresh);
    await setupApiMocks(fresh, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
    await fresh.goto(BASE_URL);
    await expect(fresh.getByRole('treegrid', { name: 'Task list' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(fresh.getByTestId('group-rows-button')).toHaveCount(0);
    await expect(fresh.getByTestId('ungroup-rows-button')).toHaveCount(0);
    await context.close();
  });
});

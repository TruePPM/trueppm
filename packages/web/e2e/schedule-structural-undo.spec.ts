/**
 * Undo a structural act on the Schedule outline (#2974, epic #2946, ADR-0880).
 *
 * The invariant worth a browser: **an act and its undo leave the same structure.** Not
 * "an undo request fired" — #2974 was filed precisely because a control can fire a
 * request and reverse nothing, and the trail's own copy said an Undo that silently did
 * nothing would be worse than no Undo. So every assertion here reads the tree back off
 * the DOM (`aria-level`, which is the outline's depth) and compares it to what it was
 * before the act.
 *
 * The mocks are **stateful**, for the reason `fixtures/task-store.ts` documents: the
 * app invalidates `['tasks', projectId]` in its own success handler, so a stateless list
 * route re-serves the pre-write rows and erases the very change under test — green
 * locally, nondeterministic on a loaded runner (#2752). `setupTaskStore` is not used
 * because it models `PATCH /tasks/{id}/` and falls through the two endpoints this spec
 * turns on (`tasks/{id}/indent/` and `structural-operations/{id}/undo/`); the store
 * below applies the same principle to those routes instead.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-undo-000000000-0000-0000-0000-000000002974';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;
const OPERATION_ID = 'op-00000000-0000-0000-0000-000000002974';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Structural Undo Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

interface FixtureTask extends Record<string, unknown> {
  id: string;
  wbs_path: string;
  name: string;
}

function taskRow(over: Partial<FixtureTask> & { id: string; wbs_path: string; name: string }): FixtureTask {
  return {
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
    ...over,
  };
}

/**
 *   1   Mobilization
 *   2   Survey        ← indenting this makes it a child of Mobilization
 *   3   Closeout
 */
const TASKS = [
  taskRow({ id: 'umob', wbs_path: '1', name: 'Mobilization' }),
  taskRow({ id: 'usurvey', wbs_path: '2', name: 'Survey' }),
  taskRow({ id: 'utail', wbs_path: '3', name: 'Closeout' }),
];

interface UndoStore {
  /** Indent requests the app sent, in order. */
  indents: string[];
  /** Undo requests the app sent, in order. */
  undos: string[];
  /** Set to make the next undo refuse the way a real collaborator conflict does. */
  refuseWith: { code: string; detail: string; changed?: unknown[] } | null;
}

/**
 * A stateful outline: `indent/` reparents the row, `undo/` puts it back.
 *
 * The list route is re-registered here so the GET the app fires after each write
 * serves the *mutated* rows. Playwright matches routes in reverse registration order,
 * so this must run after `setupApiMocks`.
 */
async function setupStructuralStore(page: Page): Promise<UndoStore> {
  const rows = TASKS.map((t) => ({ ...t }));
  const store: UndoStore = { indents: [], undos: [], refuseWith: null };

  await page.route('**/api/v1/tasks/**', async (route) => {
    const url = new URL(route.request().url());
    // Only the collection read is this store's; anything nested or non-GET falls
    // through so existing mocks keep working.
    if (route.request().method() !== 'GET' || !url.pathname.endsWith('/tasks/')) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { count: rows.length, next: null, previous: null, results: rows },
    });
  });

  await page.route('**/api/v1/projects/*/tasks/*/indent/', async (route) => {
    const taskId = new URL(route.request().url()).pathname.split('/').slice(-3, -2)[0];
    store.indents.push(taskId);
    const idx = rows.findIndex((r) => r.id === taskId);
    const above = rows[idx - 1];
    rows[idx] = { ...rows[idx], parent_id: above.id, wbs_path: `${above.wbs_path}.1` };
    rows[idx - 1] = { ...above, is_summary: true };
    await route.fulfill({
      json: {
        updated: [{ id: taskId, wbs_path: rows[idx].wbs_path }],
        warning: null,
        operation_id: OPERATION_ID,
      },
    });
  });

  await page.route('**/api/v1/structural-operations/*/undo/', async (route) => {
    store.undos.push(new URL(route.request().url()).pathname.split('/').slice(-3, -2)[0]);
    if (store.refuseWith) {
      await route.fulfill({ status: 409, json: store.refuseWith });
      return;
    }
    // Put the outline back exactly as it was — the thing under test.
    rows.splice(0, rows.length, ...TASKS.map((t) => ({ ...t })));
    await route.fulfill({
      json: {
        id: OPERATION_ID,
        status: 'undone',
        undo: {
          restored: 1,
          created_removed: 0,
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
 * the planner reads. Indenting Survey both nests it *and* renumbers Closeout from 3 to
 * 2 — a restore that put the level back but not the numbering would pass on one and
 * fail on the other.
 *
 * A row nested under a freshly-made phase reports `absent`: the Schedule folds a row
 * the moment it becomes a summary, so the child is genuinely not on screen. That is a
 * real part of the shape, and the assertion that matters — undo returns the outline to
 * exactly what it was — holds regardless of which side of the fold a row is on.
 */
async function outlineShape(page: Page): Promise<Record<string, string>> {
  const shape: Record<string, string> = {};
  for (const name of ['Mobilization', 'Survey', 'Closeout']) {
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

/**
 * Indent Survey under Mobilization, via the row's own Indent control.
 *
 * Deliberately the button rather than the ⌥→ keybinding. Both route through the same
 * `buildMode.indent`, so the act under test is identical — but the keystroke depends on
 * ambient DOM focus, and `useScheduleTasks`' 2 s `refetchInterval` re-renders the row
 * list on its own schedule. When that lands between focusing the row and pressing the
 * key, the roving tabindex re-seats focus on the first row and ⌥→ tries to indent
 * *Mobilization*, which is first at its level and refuses. The result is "nothing
 * happened", intermittently, only under worker contention — and no timeout can fix it,
 * because the keystroke was already delivered to the wrong row.
 *
 * The keybinding itself is not left untested: `⌘Z` is exercised as a keystroke below,
 * and `TaskListRow`'s own specs cover ⌥→. This spec is about whether an act and its
 * undo restore the same structure, so it triggers the act the stable way.
 */
async function indentSurvey(page: Page, store: UndoStore) {
  const row = page.getByRole('row').filter({ hasText: 'Survey' }).first();
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: /^Indent Survey/ }).click();
  // Assert the act actually left the browser before assuming anything about the DOM.
  // A click that lands while the row list is mid-re-render can hit a node the handler
  // has already been detached from — Playwright reports a successful click either way,
  // and the failure surfaces ten seconds later as "the outline never changed", which
  // reads like a bug in the feature rather than a lost gesture.
  await expect.poll(() => store.indents.length, { timeout: 10_000 }).toBeGreaterThan(0);
  // Then gate on the app having *processed* the response, not merely sent the request.
  // The trail button only exists once `recordAct` has run, which happens in the same
  // pass that binds the ledger handle — so its appearance is the earliest point at
  // which reading the outline back is meaningful. Without this the next assertion
  // races the refetch and fails as "the outline never changed".
  await expect(
    page.getByRole('button', { name: /structural change.* this session/i }),
  ).toBeVisible({ timeout: 15_000 });
}

/** Gate on the whole outline being on screen before reading a baseline from it. */
async function outlineReady(page: Page) {
  for (const name of ['Mobilization', 'Survey', 'Closeout']) {
    await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible();
  }
}

async function openTrail(page: Page) {
  await page.getByRole('button', { name: /structural change.* this session/i }).click();
  await expect(page.getByRole('dialog', { name: 'Structural changes this session' })).toBeVisible();
}

test.describe('Schedule outline — structural undo (#2974)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID, tasks: TASKS });
  });

  test('an indent and its undo leave the outline in the same shape', async ({ page }) => {
    const store = await setupStructuralStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    const before = await outlineShape(page);
    expect(before).toEqual({ Mobilization: '1@1', Survey: '2@1', Closeout: '3@1' });

    await indentSurvey(page, store);

    // The act landed: Survey went into Mobilization, and Closeout took its number.
    await expect
      .poll(async () => await outlineShape(page), { timeout: 20_000 })
      .toEqual({ Mobilization: '1@1', Survey: 'absent', Closeout: '2@1' });

    await openTrail(page);
    await page.getByRole('button', { name: /^Undo:/ }).click();

    await expect.poll(() => store.undos.length).toBe(1);
    // The assertion the issue is about: the *structure* came back, not just a 200.
    await expect
      .poll(async () => await outlineShape(page), { timeout: 20_000 })
      .toEqual(before);
  });

  test('⌘Z reverses the same act the trail button targets', async ({ page }) => {
    const store = await setupStructuralStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    const before = await outlineShape(page);
    await indentSurvey(page, store);
    await expect
      .poll(async () => (await outlineShape(page)).Closeout, { timeout: 20_000 })
      .toBe('2@1');

    await page.keyboard.press('ControlOrMeta+z');

    await expect.poll(() => store.undos).toEqual([OPERATION_ID]);
    await expect
      .poll(async () => await outlineShape(page), { timeout: 20_000 })
      .toEqual(before);
  });

  test('a refused undo says what happened and changes nothing', async ({ page }) => {
    // The designed outcome when a collaborator has been restructuring the same level:
    // the server refuses rather than reverting partially, because a partial WBS restore
    // can mint a duplicate path that corrupts the next structural write.
    const store = await setupStructuralStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    await indentSurvey(page, store);
    await expect
      .poll(async () => (await outlineShape(page)).Closeout, { timeout: 20_000 })
      .toBe('2@1');
    const afterIndent = await outlineShape(page);

    store.refuseWith = {
      code: 'shape_changed',
      detail: 'server sentence the client does not use',
      changed: [{ task_id: 'utail', change: 'moved' }],
    };

    await openTrail(page);
    await page.getByRole('button', { name: /^Undo:/ }).click();

    await expect(page.getByText(/can no longer be undone/i)).toBeVisible();
    // Refusing means refusing: the indent is still in place.
    expect(await outlineShape(page)).toEqual(afterIndent);
  });

  test('the trail states the boundary rather than promising a general undo', async ({
    page,
  }) => {
    // #2974: advertising ⌘Z for an act that cannot be reversed is the defect. The
    // panel must name what is outside the boundary, not imply everything is inside.
    const store = await setupStructuralStore(page);
    await page.goto(BASE_URL);
    await outlineReady(page);

    await indentSurvey(page, store);
    await openTrail(page);

    const panel = page.getByRole('dialog', { name: 'Structural changes this session' });
    await expect(panel.getByText(/cannot be undone/i)).toBeVisible();
  });
});

/**
 * Schedule build-mode v1 (#338 #339 #341 #342, gated by #349).
 *
 * Covers the user-visible acceptance criteria:
 * - Flag-on shows the always-on toolbar pill and the cheatsheet on `?`
 * - Hint strip is contextual (#1250): hidden when idle (NoSelection), revealed
 *   once a row is focused so the Forecast bar owns the idle bottom band
 * - Flag-off leaves the Schedule toolbar, list, and footer unchanged (regression)
 * - Right-click on a row opens the context menu with the expected items
 *
 * Deeper structural / mutation flows (Tab → indent server call, EditableCell
 * commit/rollback semantics, focus reducer state machine) are exercised at
 * the vitest layer where they can be asserted without canvas/network coupling.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-build-00000000-0000-0000-0000-000000000349';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Build Mode Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'bm1', wbs_path: '1', name: 'Foundation',
    early_start: '2026-04-05', early_finish: '2026-04-09',
    planned_start: '2026-04-05',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'bm2', wbs_path: '2', name: 'Framing',
    early_start: '2026-04-12', early_finish: '2026-04-16',
    planned_start: '2026-04-12',
    duration: 5, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: null,
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function enableBuildMode(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm.featureFlags',
      JSON.stringify({ schedule_build_mode_v1: true }),
    );
  });
}

test.describe('Schedule build-mode — flag off (regression)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('toolbar does not show the Build mode pill when flag is off', async ({ page }) => {
    await page.goto(BASE_URL);
    // Wait for tasks to render so we know the Schedule view mounted.
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(page.getByTestId('build-mode-pill')).toHaveCount(0);
    await expect(page.getByTestId('build-mode-hint-strip')).toHaveCount(0);
  });
});

test.describe('Schedule build-mode — flag on', () => {
  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('toolbar pill is visible and opens the cheatsheet', async ({ page }) => {
    await page.goto(BASE_URL);
    const pill = page.getByTestId('build-mode-pill');
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);
  });

  test('hint strip is hidden when idle and reveals contextual hints once a row is focused (#1250)', async ({ page }) => {
    await page.goto(BASE_URL);
    // Gate on the page having rendered before asserting the strip's absence.
    await expect(page.getByText('Foundation')).toBeVisible();
    const strip = page.getByTestId('build-mode-hint-strip');
    // Idle (NoSelection): no strip — the Forecast bar owns the bottom band.
    await expect(strip).toHaveCount(0);
    // Focusing a row reveals the strip in RowFocused with its contextual hints.
    await page.getByText('Foundation').click();
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-mode', 'RowFocused');
    await expect(strip).toContainText('Indent');
  });

  test('? opens cheatsheet from anywhere outside an input', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
    // ? toggles closed too.
    await page.keyboard.press('Shift+?');
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toHaveCount(0);
  });

  test('cheatsheet renders every section (Quick actions + Dependencies added in #475+#477)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByTestId('build-mode-pill').click();
    const dialog = page.getByRole('dialog', { name: 'Schedule shortcuts' });
    await expect(dialog.getByText('Selecting rows')).toBeVisible();
    await expect(dialog.getByText('Editing cells')).toBeVisible();
    await expect(dialog.getByText('Structuring (the WBS tree)')).toBeVisible();
    await expect(dialog.getByText('Quick actions')).toBeVisible();
    await expect(dialog.getByText('Dependencies')).toBeVisible();
    await expect(dialog.getByText('Help')).toBeVisible();
  });

  test('right-click on a row opens the row menu with expected items', async ({ page }) => {
    await page.goto(BASE_URL);
    const row = page.getByText('Foundation');
    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Edit/ })).toBeVisible();
    // Items added in #477 — Mark complete, Add predecessor / successor, Duplicate.
    await expect(menu.getByRole('menuitem', { name: /Mark complete/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Indent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Outdent/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Add predecessor/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Add successor/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Duplicate/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Delete/ })).toBeVisible();
    // Esc dismisses.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #806 — deleting a row must not block right-click on subsequent rows.
//
// Reported as "deleting a phase on the critical path grays out the row and
// right-click stops working until manual refresh". Root cause was a race
// between cache invalidation (which unmounts the deleted row) and the
// BuildModeRowMenu portal that lived on its parent — the portal's global
// Escape/click-outside listeners outlived the row and blocked new menu opens.
// ───────────────────────────────────────────────────────────────────────────
test.describe('Schedule build-mode — delete does not block subsequent right-clicks (#806)', () => {
  // Module-scope mutable list so the post-delete handler can splice it out
  // before the catch-all GET refetch reads it back — mirrors the live
  // invalidation path that unmounts the deleted row.
  let currentTasks: typeof FIXTURE_TASKS;

  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    currentTasks = [...FIXTURE_TASKS];
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: currentTasks,
    });
    // Register AFTER setupApiMocks: Playwright matches routes in LIFO order,
    // so this DELETE-specific handler wins over the catch-all `tasks/**` GET
    // registered inside setupApiMocks. The GET catch-all reads the same
    // `currentTasks` array by reference, so the post-splice refetch returns
    // the truncated list and the deleted row unmounts as it does in prod.
    await page.route('**/api/v1/tasks/bm1/', (route) => {
      if (route.request().method() === 'DELETE') {
        const idx = currentTasks.findIndex((t) => t.id === 'bm1');
        if (idx >= 0) currentTasks.splice(idx, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.continue();
    });
  });

  test('after deleting one row, right-click on a sibling row still opens its menu', async ({ page }) => {
    await page.goto(BASE_URL);
    const firstRow = page.getByText('Foundation');
    await expect(firstRow).toBeVisible();

    // Open the menu on Foundation, then activate Delete.
    await firstRow.click({ button: 'right' });
    const firstMenu = page.getByRole('menu', { name: 'Row actions' });
    await expect(firstMenu).toBeVisible();
    await firstMenu.getByRole('menuitem', { name: /Delete/ }).click();

    // The deleted row eventually drops out of the list (cache invalidates,
    // refetch returns the truncated set). Scope to the grid row, not any text:
    // the #1762 delete-undo toast also names the task ("Deleted “Foundation”").
    await expect(page.getByRole('row').filter({ hasText: 'Foundation' })).toHaveCount(0);

    // The bug: right-click on the surviving sibling did nothing until a full
    // page refresh. With the fix the menu opens normally.
    const secondRow = page.getByText('Framing');
    await secondRow.click({ button: 'right' });
    await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #1762 — build-mode delete is destructive with no confirm (Backspace/Delete
// keybinding and the ⋮ menu both fire it). The safety net the keybinding always
// assumed but never had is a "Deleted — Undo" toast that recreates the task.
// Both entry points route through the same buildMode.deleteTask, so exercising
// the (reliable) menu path covers the keybinding's undo net too; the keybinding
// → deleteTask call itself is asserted at the vitest layer.
// ───────────────────────────────────────────────────────────────────────────
test.describe('Schedule build-mode — delete surfaces an Undo toast (#1762)', () => {
  let currentTasks: Array<Record<string, unknown>>;
  let restoreCalls: string[];

  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    currentTasks = FIXTURE_TASKS.map((t) => ({ ...t }));
    restoreCalls = [];
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: currentTasks,
    });

    // DELETE bm1 → splice the shared array the GET catch-all reads by reference,
    // so the refetch after invalidation unmounts the row (mirrors #806).
    await page.route('**/api/v1/tasks/bm1/', (route) => {
      if (route.request().method() === 'DELETE') {
        const idx = currentTasks.findIndex((t) => t.id === 'bm1');
        if (idx >= 0) currentTasks.splice(idx, 1);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });

    // POST /tasks/bm1/restore/ → the faithful Undo (#2078). Push the SAME task
    // back into the shared list under its original id so the refetch re-renders it,
    // and record the restore call so the test can assert the endpoint (not a
    // create-a-new-row) was hit.
    await page.route('**/api/v1/tasks/bm1/restore/', (route) => {
      if (route.request().method() === 'POST') {
        restoreCalls.push('bm1');
        const restored = { ...FIXTURE_TASKS[0] };
        currentTasks.push(restored);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(restored),
        });
      }
      return route.fallback();
    });
  });

  test('deleting a row surfaces a "Deleted — Undo" toast', async ({ page }) => {
    await page.goto(BASE_URL);
    const row = page.getByText('Foundation');
    await expect(row).toBeVisible();

    await row.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Delete/ }).click();

    // The grid row unmounts on refetch (scope to role=row: the toast also names
    // the task, so a bare getByText would still match it)…
    await expect(page.getByRole('row').filter({ hasText: 'Foundation' })).toHaveCount(0);
    // …and the schedule action toast offers the Undo safety net. Scope to the
    // action toast (the page has several live `role=status` regions).
    const toast = page.getByRole('status').filter({ hasText: 'Deleted' });
    await expect(toast).toContainText('Foundation');
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  test('clicking Undo restores the deleted task via the restore endpoint (#2078)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Delete/ })
      .click();
    const foundationRow = page.getByRole('row').filter({ hasText: 'Foundation' });
    await expect(foundationRow).toHaveCount(0);

    await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();

    // Undo POSTs to the restore endpoint (not a create), and the row returns; the
    // faithful-recovery toast is a plain "Restored".
    await expect(foundationRow).toHaveCount(1);
    expect(restoreCalls).toEqual(['bm1']);
    await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #2029 — deleting a SUMMARY/phase row takes its whole subtree, so that specific
// delete is gated behind a confirm naming the descendant count (leaf deletes,
// above, stay confirm-free). Since #2078 the Undo faithfully restores the whole
// subtree, so the confirm is a "you're about to move a lot" heads-up, not a
// point-of-no-return — but still worth surfacing the blast radius.
// ───────────────────────────────────────────────────────────────────────────
test.describe('Schedule build-mode — subtree delete confirms, Undo restores it (#2029/#2078)', () => {
  const SUBTREE_TASKS = [
    {
      id: 'phase', wbs_path: '1', name: 'Design Phase',
      early_start: '2026-04-05', early_finish: '2026-04-20', planned_start: '2026-04-05',
      duration: 12, percent_complete: 0, is_critical: false,
      is_milestone: false, is_summary: true, parent_id: null,
      status: 'IN_PROGRESS', assignees: [], total_float: null,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
    {
      id: 'child-a', wbs_path: '1.1', name: 'Wireframes',
      early_start: '2026-04-05', early_finish: '2026-04-09', planned_start: '2026-04-05',
      duration: 5, percent_complete: 0, is_critical: false,
      is_milestone: false, is_summary: false, parent_id: 'phase',
      status: 'NOT_STARTED', assignees: [], total_float: null,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
    {
      id: 'child-b', wbs_path: '1.2', name: 'Mockups',
      early_start: '2026-04-10', early_finish: '2026-04-14', planned_start: '2026-04-10',
      duration: 5, percent_complete: 0, is_critical: false,
      is_milestone: false, is_summary: false, parent_id: 'phase',
      status: 'NOT_STARTED', assignees: [], total_float: null,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
  ];

  let currentTasks: Array<Record<string, unknown>>;
  let deleteCount: number;

  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    currentTasks = SUBTREE_TASKS.map((t) => ({ ...t }));
    deleteCount = 0;
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: currentTasks,
    });

    // DELETE phase → drop the summary and its children so the refetch unmounts them.
    await page.route('**/api/v1/tasks/phase/', (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCount += 1;
        for (let i = currentTasks.length - 1; i >= 0; i -= 1) {
          if (currentTasks[i].id === 'phase' || currentTasks[i].parent_id === 'phase') {
            currentTasks.splice(i, 1);
          }
        }
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fallback();
    });

    // POST /tasks/phase/restore/ → the faithful Undo (#2078): the whole subtree
    // comes back (phase + both children), not just the parent row. Push all three
    // back under their original ids and return the restored summary.
    await page.route('**/api/v1/tasks/phase/restore/', (route) => {
      if (route.request().method() === 'POST') {
        currentTasks.push(...SUBTREE_TASKS.map((t) => ({ ...t })));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(SUBTREE_TASKS[0]),
        });
      }
      return route.fallback();
    });
  });

  test('deleting a phase row raises a confirm naming the descendant count', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Design Phase')).toBeVisible();

    await page.getByText('Design Phase').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Delete/ })
      .click();

    // The subtree confirm — not an immediate delete.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete “Design Phase” and its 2 subtasks?');
    expect(deleteCount).toBe(0);
  });

  test('Backspace on a focused phase row also confirms (the CRITICAL one-keypress case)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    const phaseRow = page.locator('[data-row-id="phase"]');
    await expect(phaseRow).toBeVisible();
    await phaseRow.focus();
    await page.keyboard.press('Backspace');

    // The keybinding routes through the same guard as the menu — no immediate
    // destroy; the confirm names the subtree.
    await expect(page.getByRole('alertdialog')).toContainText(
      'Delete “Design Phase” and its 2 subtasks?',
    );
    expect(deleteCount).toBe(0);
  });

  test('canceling the confirm keeps the phase and issues no delete', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Design Phase').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Delete/ })
      .click();

    await page.getByRole('alertdialog').getByRole('button', { name: /Cancel/ }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByText('Design Phase')).toBeVisible();
    expect(deleteCount).toBe(0);
  });

  test('confirming deletes the subtree and Undo faithfully restores it (#2078)', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Design Phase').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Delete/ })
      .click();

    await page.getByRole('alertdialog').getByRole('button', { name: /Delete 3 rows/ }).click();

    await expect(page.getByRole('row').filter({ hasText: 'Design Phase' })).toHaveCount(0);
    expect(deleteCount).toBe(1);
    // Toast names the blast radius and offers Undo.
    const toast = page.getByRole('status').filter({ hasText: 'Deleted' });
    await expect(toast).toContainText('Deleted “Design Phase” and its 2 subtasks');
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();

    // Clicking Undo now faithfully restores the WHOLE subtree (#2078) — the parent
    // AND both children come back — so the copy is a plain "Restored", no caveat.
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Design Phase' })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: 'Wireframes' })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: 'Mockups' })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #1666 — Enter = new sibling row (the previously broken insertBelow/Enter
// binding). Enter on a focused row creates a sibling under the SAME parent
// (not the WBS root) and drops the cursor into its Name cell; Enter in the
// Name cell commits and continues (a fresh sibling below); Enter on a blank
// new row is a no-op (double-Enter guard); Escape reverts without deleting.
// ───────────────────────────────────────────────────────────────────────────
test.describe('Schedule build-mode — Enter inserts a sibling row (#1666)', () => {
  // A nested fixture so "sibling under the same parent, not root" is
  // observable: focusing the child and pressing Enter must POST parent_id =
  // the summary, never null/root.
  const NESTED_TASKS = [
    {
      id: 'phase', wbs_path: '1', name: 'Design Phase',
      early_start: '2026-04-05', early_finish: '2026-04-20',
      planned_start: '2026-04-05',
      duration: 12, percent_complete: 0, is_critical: false,
      is_milestone: false, is_summary: true, parent_id: null,
      status: 'IN_PROGRESS', assignees: [], total_float: null,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
    {
      id: 'task-a', wbs_path: '1.1', name: 'Wireframes',
      early_start: '2026-04-05', early_finish: '2026-04-09',
      planned_start: '2026-04-05',
      duration: 5, percent_complete: 0, is_critical: false,
      is_milestone: false, is_summary: false, parent_id: 'phase',
      status: 'NOT_STARTED', assignees: [], total_float: null,
      predecessor_count: 0, is_blocked: false,
      linked_risks_count: 0, linked_risks_max_severity: null,
    },
  ];

  let currentTasks: Array<Record<string, unknown>>;
  let postBodies: Array<{ parent_id?: string | null; name?: string }>;
  let createdCount: number;
  let deleteCount: number;

  test.beforeEach(async ({ page }) => {
    await enableBuildMode(page);
    await setupAuth(page);
    await setupCatchAll(page);
    currentTasks = NESTED_TASKS.map((t) => ({ ...t }));
    postBodies = [];
    createdCount = 0;
    deleteCount = 0;
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: currentTasks,
    });

    // Stateful tasks endpoint (registered AFTER setupApiMocks so it wins, LIFO).
    // GET returns the live list; POST appends a new task (mirroring the create
    // → invalidate → refetch cycle so the new row mounts); PATCH updates a name.
    await page.route('**/api/v1/tasks/**', (route) => {
      const req = route.request();
      const method = req.method();
      if (method === 'POST') {
        const body = req.postDataJSON() as { name?: string; duration?: number; parent_id?: string | null };
        postBodies.push({ parent_id: body.parent_id, name: body.name });
        createdCount += 1;
        const id = `new-${createdCount}`;
        const parentId = body.parent_id ?? null;
        currentTasks.push({
          id, wbs_path: `1.${createdCount + 1}`, name: body.name ?? '',
          early_start: '2026-04-10', early_finish: '2026-04-10',
          planned_start: '2026-04-10',
          duration: body.duration ?? 1, percent_complete: 0, is_critical: false,
          is_milestone: false, is_summary: false, parent_id: parentId,
          status: 'NOT_STARTED', assignees: [], total_float: null,
          predecessor_count: 0, is_blocked: false,
          linked_risks_count: 0, linked_risks_max_severity: null,
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id, name: body.name ?? '', project: FIXTURE_PROJECT_ID,
            wbs_path: `1.${createdCount + 1}`, duration: body.duration ?? 1,
            status: 'NOT_STARTED', percent_complete: 0,
          }),
        });
      }
      if (method === 'PATCH') {
        const url = req.url();
        const idMatch = url.match(/tasks\/([^/]+)\//);
        const body = req.postDataJSON() as { name?: string };
        if (idMatch) {
          const t = currentTasks.find((x) => x.id === idMatch[1]);
          if (t && typeof body.name === 'string') t.name = body.name;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: idMatch?.[1], name: body.name ?? '', project: FIXTURE_PROJECT_ID,
            wbs_path: '1.1', duration: 5, status: 'NOT_STARTED', percent_complete: 0,
          }),
        });
      }
      if (method === 'DELETE') {
        deleteCount += 1;
        return route.fulfill({ status: 204, body: '' });
      }
      // GET
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: currentTasks.length, next: null, previous: null, results: currentTasks }),
      });
    });
  });

  const nameInput = (page: import('@playwright/test').Page) =>
    page.locator('input[aria-label^="Rename task"]');

  test('Enter on a focused child row inserts a sibling under the same parent and opens its Name cell', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    const row = page.locator('[data-row-id="task-a"]');
    await expect(row).toBeVisible();

    await row.focus();
    await page.keyboard.press('Enter');

    // Sibling insert: the POST carries the focused row's parent (the summary),
    // NOT null/root — the depth assertion that proves the fix.
    await expect.poll(() => postBodies.length).toBe(1);
    expect(postBodies[0].parent_id).toBe('phase');

    // Focus lands in the new row's Name cell in edit mode.
    await expect(nameInput(page)).toBeVisible();
  });

  test('typing a name + Enter commits and continues; Enter on the blank new row is a no-op', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    const row = page.locator('[data-row-id="task-a"]');
    await expect(row).toBeVisible();
    await row.focus();
    await page.keyboard.press('Enter');

    const input = nameInput(page);
    await expect(input).toBeVisible();
    await expect.poll(() => createdCount).toBe(1);

    // Commit-and-continue: name + Enter commits the edit and spawns a second
    // sibling below, cursor into ITS Name cell.
    await input.fill('Homepage');
    await input.press('Enter');
    await expect.poll(() => createdCount).toBe(2);
    // Both new siblings live under the same parent as the focused child.
    expect(postBodies[1].parent_id).toBe('phase');
    // A fresh editing Name cell is present for the second new row.
    await expect(nameInput(page)).toBeVisible();

    // Double-Enter guard: Enter on the still-blank second row spawns nothing.
    await nameInput(page).press('Enter');
    await page.waitForTimeout(300);
    expect(createdCount).toBe(2);
    // Cursor stays — the editing cell is still open.
    await expect(nameInput(page)).toBeVisible();
  });

  test('Escape in the new row Name cell reverts to the row without deleting it', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    const row = page.locator('[data-row-id="task-a"]');
    await expect(row).toBeVisible();
    await row.focus();
    await page.keyboard.press('Enter');

    const input = nameInput(page);
    await expect(input).toBeVisible();
    await expect.poll(() => currentTasks.length).toBe(3); // phase + task-a + new-1

    // Escape reverts the edit and drops to RowFocused — it does NOT delete the
    // just-created row.
    await input.press('Escape');
    await expect(nameInput(page)).toHaveCount(0);
    await page.waitForTimeout(200);
    expect(deleteCount).toBe(0);
    expect(currentTasks.length).toBe(3);
  });
});

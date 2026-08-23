/**
 * The dependency picker's keyboard contract (#3024).
 *
 * The capability this file exists to hold is **two links in one open, from the
 * keyboard alone**. Before #3024 `Enter` was the picker's only commit and it
 * closes on success, so the picker was one-link-per-open *by construction* —
 * linking three predecessors meant three round trips through the row menu.
 * `Space` is what makes it multi-add, and it is only safe because it does
 * nothing until `↓` has walked the caret into the list (the field is a search
 * field; a planner composing `site plan` must not link a row mid-phrase).
 *
 * Also covers, because none of it is checkable from `tsc`: `aria-activedescendant`
 * moving over a `role="listbox"` with the FIRST `↓` landing on the FIRST row,
 * the `<mark>` that says why a row matched, and the `N of M` count.
 */
import { test, expect } from './fixtures/coverage';
import {
  expectNoA11yViolations,
  setupAuth,
  setupApiMocks,
  setupCatchAll,
  setupTaskStore,
} from './fixtures';

const PROJECT_ID = 'e2e-depkbd-0000-0000-0000-000000003024';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECT = {
  id: PROJECT_ID,
  name: 'Depot Fit-out',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  program: null,
};

function taskRow(id: string, wbs: string, name: string) {
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
  };
}

const FIXTURE_TASKS = [
  taskRow('bm1', '1', 'Cutover'),
  taskRow('bm2', '2', 'Lay-down area survey'),
  taskRow('bm3', '3', 'Site plan approval'),
  taskRow('bm4', '4', 'Power drop'),
];

/**
 * A **stateful** `/dependencies/` mock: a POST is appended and the subsequent
 * GET serves it back.
 *
 * The stateless default would re-serve an empty list on the refetch that
 * `useAddDependency`'s own `onSuccess` invalidation fires, so any DOM assertion
 * made after a write would be racing that refetch rather than observing a
 * settled state (#2752, the same class `setupTaskStore` exists for).
 */
async function mockDependencies(page: import('@playwright/test').Page) {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/v1/dependencies/**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      const created = {
        id: `dep-${posted.length + 1}`,
        predecessor: body.predecessor,
        successor: body.successor,
        dep_type: body.dep_type ?? 'FS',
        lag: body.lag ?? 0,
        pending_acceptance: false,
      };
      posted.push(created);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(created),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: posted.length, next: null, previous: null, results: posted }),
    });
  });
  return posted;
}

async function openPredecessorPicker(page: import('@playwright/test').Page) {
  await page.goto(BASE_URL);
  // Gate on a rendered row (not a spinner) before driving the context menu.
  await expect(page.getByText('Cutover')).toBeVisible({ timeout: 10_000 });
  await page.getByText('Cutover').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Row actions' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: /Add predecessor/ }).click();
  const dialog = page.getByRole('dialog', { name: /Add predecessor/ });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Dependency picker keyboard contract (#3024)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [PROJECT],
      projectId: PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
    await setupTaskStore(page, { tasks: FIXTURE_TASKS });
  });

  test('adds TWO links in one open, from the keyboard alone', async ({ page }) => {
    const posted = await mockDependencies(page);
    const dialog = await openPredecessorPicker(page);
    const search = dialog.getByLabel('Search tasks');

    // Three linkable rows (the source task is never its own counterpart).
    await expect(dialog.getByText('3 of 3 matches')).toBeVisible();

    // ↓ walks into the list and lands on the FIRST row — not the second.
    await search.press('ArrowDown');
    const firstOption = dialog.getByRole('option').first();
    await expect(search).toHaveAttribute('aria-activedescendant', /.+/);
    expect(await search.getAttribute('aria-activedescendant')).toBe(
      await firstOption.getAttribute('id'),
    );

    // Space adds and KEEPS THE PICKER OPEN — this is the whole capability.
    await search.press(' ');
    await expect(dialog.getByText('Added “Lay-down area survey” — 1 link added')).toBeVisible();
    await expect(dialog).toBeVisible();
    // The linked row leaves the list; the count follows it down.
    await expect(dialog.getByText('2 of 2 matches')).toBeVisible();

    // Second add, same open, no pointer and no reopen.
    await search.press(' ');
    await expect(dialog.getByText('Added “Site plan approval” — 2 links added')).toBeVisible();
    await expect(dialog.getByText('1 of 1 match')).toBeVisible();

    expect(posted).toHaveLength(2);
    expect(posted.map((d) => d.predecessor)).toEqual(['bm2', 'bm3']);
    expect(posted.every((d) => d.successor === 'bm1')).toBe(true);

    // Esc still closes, and nothing else was committed on the way out.
    await search.press('Escape');
    await expect(dialog).toBeHidden();
    expect(posted).toHaveLength(2);
  });

  test('Space types into the query until ↓ enters the list', async ({ page }) => {
    const posted = await mockDependencies(page);
    const dialog = await openPredecessorPicker(page);
    const search = dialog.getByLabel('Search tasks');

    // A two-word query typed straight into the field: every Space here belongs
    // to the text, and none of them may create a dependency.
    await search.pressSequentially('site plan');
    await expect(search).toHaveValue('site plan');
    expect(posted).toHaveLength(0);
    await expect(dialog.getByText('1 of 1 match')).toBeVisible();

    // ⏎ takes the sole match and closes (unchanged behavior).
    await search.press('Enter');
    await expect(dialog).toBeHidden();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ predecessor: 'bm3', successor: 'bm1' });
  });

  test('marks WHY a row matched — WBS prefix vs name substring', async ({ page }) => {
    await mockDependencies(page);
    const dialog = await openPredecessorPicker(page);
    const search = dialog.getByLabel('Search tasks');

    // A leading digit is a WBS prefix: the mark lands in the code column.
    await search.fill('2');
    const wbsRow = dialog.getByRole('option').first();
    await expect(wbsRow.locator('mark')).toHaveText('2');
    await expect(wbsRow).toContainText('Lay-down area survey');

    // Anything else is a name substring: the mark moves to the name, with the
    // row's own casing preserved.
    await search.fill('lay');
    const nameRow = dialog.getByRole('option').first();
    await expect(nameRow.locator('mark')).toHaveText('Lay');
  });

  test('the open picker has no axe violations, in either keyboard mode', async ({
    page,
  }, testInfo) => {
    // The listbox → group → option structure and the combobox wiring are the
    // subject of this change, and nothing scanned this dialog before —
    // `a11y.spec.ts` only ever opened the command palette.
    //
    // `#root` is excluded because the picker is PORTALED to `document.body`, so
    // excluding the app root leaves exactly the dialog. The Schedule underneath
    // carries its own pre-existing `aria-required-children` debt (the row `div`s
    // hold `button`s that their grid roles do not allow); scanning it here would
    // fail this test for something this branch neither caused nor touches, and
    // the usual outcome of that is the scan getting deleted rather than the debt
    // getting paid.
    const scanDialogOnly = { exclude: ['#root'] };
    await mockDependencies(page);
    const dialog = await openPredecessorPicker(page);
    const search = dialog.getByLabel('Search tasks');
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await expectNoA11yViolations(page, testInfo, scanDialogOnly);

    // Again with the caret inside the list, which is when `aria-activedescendant`
    // is populated and the marks are rendered — a different DOM to scan, and the
    // one where the mark's contrast is on the hook.
    await search.fill('lay');
    await search.press('ArrowDown');
    await expect(dialog.locator('mark').first()).toBeVisible();
    await expectNoA11yViolations(page, testInfo, scanDialogOnly);
  });
});

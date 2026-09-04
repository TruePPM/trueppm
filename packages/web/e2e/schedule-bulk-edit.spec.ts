/**
 * The ⌘⇧K bulk-edit sheet, end to end (#2756 pt.2, ADR-0810).
 *
 * Each flow ends on what the outline shows, not on the request that was sent:
 * a sheet that posts a correct batch and leaves the grid unchanged is a sheet
 * that appears to do nothing.
 *
 * Reads and the batch write share one stateful store (`setupTaskStore`). The
 * sheet invalidates `['tasks', projectId]` on success, so the stateless default
 * list mock would re-serve the pre-edit fixture and the mode chip would appear
 * and then vanish — the #2752 class of flake, which no timeout can fix.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore, type TaskStoreHandle } from './fixtures/task-store';

const PROJECT_ID = 'e2e-bulk-0000-0000-0000-000000002756';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;
const ANA_ID = 'res-ana-2756';

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Bulk Edit Project',
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
    assignments: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    ...extra,
  };
}

// Three plain rows plus one the server says this user may not edit — enough for
// a genuinely partial batch, which is the shape the sheet exists to report.
const TASKS = [
  row('t1', '1', 'Survey the site'),
  row('t2', '2', 'Pour foundations'),
  row('t3', '3', 'Frame the walls'),
  row('t4', '4', 'Locked handover', { can_edit: false }),
];

const ROSTER = [
  {
    id: 'pr-ana',
    project: PROJECT_ID,
    resource: ANA_ID,
    resource_detail: {
      id: ANA_ID,
      name: 'Ana Rivera',
      email: 'ana@example.com',
      job_role: 'Analyst',
      max_units: '1.00',
      calendar: null,
      skills: [],
    },
    role_title: 'Analyst',
    units_override: null,
    effective_max_units: '1.00',
    notes: '',
  },
];

async function setup(page: Page): Promise<TaskStoreHandle> {
  await setupAuth(page);
  await setupCatchAll(page);
  // No `tasks:` — setupTaskStore owns every /tasks/ read below, and leaving the
  // stateless default registered too would put two sources of truth for the
  // same list one route-precedence change apart.
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECT_ID });

  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: ROSTER.length, next: null, previous: null, results: ROSTER }),
    }),
  );

  return setupTaskStore(page, {
    tasks: TASKS,
    // `owners` is write-only on TaskSerializer; the read projection is
    // `assignments`. A shallow merge would echo back a field the real API never
    // returns, and the spec would assert a shape the server cannot produce.
    applyPatch: (body, current) => {
      const { owners, ...rest } = body as {
        owners?: { resource: string; units: number }[];
      } & Record<string, unknown>;
      return {
        ...current,
        ...rest,
        ...(owners
          ? {
              assignments: owners.map((o) => ({
                resource_id: o.resource,
                resource_name: 'Ana Rivera',
                units: String(o.units),
              })),
            }
          : {}),
      };
    },
  });
}

/**
 * Click `ids[0]`, then Shift+↓ down the list until exactly `ids` are selected.
 *
 * Each press waits for the **previous** edge row to actually hold DOM focus
 * first. `tryBuildModeSelectExtend` extends from whichever row is focused and
 * then moves focus to the new edge — so a press sent before that focus lands
 * re-extends from the row before it, and the selection stops growing *for good*
 * rather than arriving late. That is why this is not a timeout problem: under
 * `--workers=10` the count sat at 3 for the full 5 s, because the dropped press
 * had already been spent re-extending to a row that was selected. Waiting on the
 * precondition is the only thing that fixes it — a longer timeout cannot.
 */
async function selectRows(page: Page, ids: string[]) {
  // Click the Name cell's text, not the row box: a click at the row's centre
  // lands on whichever cell sits there and can open it for edit, and
  // `handleBuildModeKeyDown` returns early while any cell is in edit — so the
  // Shift+↓ that follows is swallowed and the selection never grows.
  const firstName = TASKS.find((t) => t.id === ids[0])?.name as string;
  await expect(page.getByText(firstName)).toBeVisible();
  await page.getByText(firstName).click();
  const selected = page.locator('[role="row"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  for (let n = 1; n < ids.length; n++) {
    // `:focus-within`, not `:focus`: the row handler is reached by bubbling, and
    // a click lands on a cell inside the row rather than the row element itself,
    // so the row only ever *contains* focus on that path. What matters is which
    // row would receive the next keydown — and that is the one focus is inside.
    await expect(page.locator(`[data-row-id="${ids[n - 1]}"]:focus-within`)).toHaveCount(1);
    await page.keyboard.press('Shift+ArrowDown');
    await expect(selected).toHaveCount(n + 1);
  }
}

test.describe('Bulk-edit sheet — ⌘⇧K over a multi-row selection (#2756)', () => {
  let store: TaskStoreHandle;

  test.beforeEach(async ({ page }) => {
    store = await setup(page);
  });

  test('⌘⇧K opens the sheet naming the selection size', async ({ page }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2', 't3']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    const sheet = page.getByTestId('bulk-edit-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Edit 3 items' })).toBeVisible();
    // The scope promise: this sheet never touches descendants.
    await expect(sheet).toContainText('no cascade');
  });

  test('⌘⇧K on a single focused row treats it as a selection of one', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Pour foundations').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await expect(
      page.getByTestId('bulk-edit-sheet').getByRole('heading', { name: 'Edit 1 item' }),
    ).toBeVisible();
  });

  test('golden path: one classification change lands on every selected row', async ({ page }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2', 't3']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await page.getByTestId('bulk_delivery_mode-scrum').click();
    // The blast radius is on the button, not buried in body copy.
    await expect(page.getByTestId('bulk-edit-apply')).toContainText('Apply to 3 items');
    await page.getByTestId('bulk-edit-apply').click();

    await expect(page.getByTestId('bulk-edit-result')).toContainText('3 changes applied');
    await page.getByTestId('bulk-edit-done').click();
    await expect(page.getByTestId('bulk-edit-sheet')).toHaveCount(0);

    // The outcome, not the request: all three rows read SCRUM after the refetch.
    for (const name of ['Survey the site', 'Pour foundations', 'Frame the walls']) {
      const outlineRow = page.getByRole('row').filter({ hasText: name });
      await expect(outlineRow.getByTestId('mode-chip')).toHaveText('SCRUM');
    }
  });

  test('the owner write goes through owners, never a bare assignee', async ({ page }) => {
    // A bare `assignee` contributes ZERO to every capacity, utilization and
    // heat-map number (ADR-0774) — asserting the request shape is the only way
    // to catch a regression that is otherwise silent and permanent.
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await page.getByTestId('bulk-owner-add').click();
    await page.getByTestId('bulk-edit-owner').selectOption(ANA_ID);
    await expect(page.getByTestId('bulk-edit-review')).toContainText('Add Ana Rivera (100%)');
    await page.getByTestId('bulk-edit-apply').click();
    await expect(page.getByTestId('bulk-edit-result')).toContainText('2 changes applied');

    const written = store.rows().find((r) => r.id === 't1') as {
      assignments?: { resource_id: string }[];
      assignee?: unknown;
    };
    expect(written.assignments?.[0]?.resource_id).toBe(ANA_ID);
    expect(written.assignee).toBeUndefined();
  });

  test('a partial batch reports the rejected row and re-selects it on Review', async ({ page }) => {
    await page.goto(BASE_URL);
    // Reach across all four rows, the last of which the server refuses.
    await selectRows(page, ['t1', 't2', 't3', 't4']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    // The lock is called out before Apply, not only after it fails.
    await expect(page.getByTestId('bulk-edit-warning-not-editable')).toContainText(
      '1 item you can’t edit',
    );
    await page.getByTestId('bulk_governance_class-flow').click();
    await page.getByTestId('bulk-edit-apply').click();

    const result = page.getByTestId('bulk-edit-result');
    // `S19` — the header counts CHANGES, and `S18`'s equation is on screen:
    // 3 updated + 1 refused = the field's own denominator of 4.
    await expect(result).toContainText('3 changes applied');
    await expect(result).toContainText('3 updated, 1 refused of 4 items');
    await expect(result).toContainText('You may not edit this task.');

    // Retry makes the failures the selection — how a planner gets back to
    // scattered rows in a virtualized outline without scrolling for them.
    await page.getByTestId('bulk-edit-review-failed').click();
    await expect(page.getByTestId('bulk-edit-sheet')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');
    await expect(
      page.getByTestId('bulk-edit-sheet').getByRole('heading', { name: 'Edit 1 item' }),
    ).toBeVisible();
  });

  test('Esc closes the sheet without writing anything', async ({ page }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    // `S22` — Escape reverts the last touched field FIRST, then closes. The
    // sheet writes nothing before Apply, so there is no unsaved work to protect.
    await page.getByTestId('bulk_delivery_mode-kanban').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bulk-edit-sheet')).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('bulk-edit-sheet')).toHaveCount(0);
    expect(store.rows().every((r) => r.delivery_mode !== 'kanban')).toBe(true);
  });

  test('Apply stays disabled until something actually changes', async ({ page }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await expect(page.getByTestId('bulk-edit-apply')).toBeDisabled();
    await page.getByTestId('bulk-planned-start-clear').click();
    await expect(page.getByTestId('bulk-edit-apply')).toBeEnabled();
  });

  test('a bulk duration edit lands on every selected item (#3152)', async ({ page }) => {
    // The field a weekly re-plan actually changes, end to end — and the reason
    // the payload is now per row: `+3` resolves against each item's OWN duration,
    // so one shared `data` object could not express it.
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2', 't3']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await page.getByTestId('bulk-duration-set').click();
    // `S6` — the typed sign flips the worded operator; the select is the primary
    // route and this is only a shortcut, so both must agree afterwards.
    await page.getByTestId('bulk-duration-amount').fill('+3');
    await expect(page.getByTestId('bulk-duration-op')).toHaveValue('plus');
    await expect(page.getByTestId('bulk-edit-review')).toContainText('Increase by 3d');
    await expect(page.getByTestId('bulk-edit-line-duration')).toContainText(
      '3 to update of 3 items',
    );

    await page.getByTestId('bulk-edit-apply').click();
    await expect(page.getByTestId('bulk-edit-result')).toContainText('3 changes applied');
    await page.getByTestId('bulk-edit-done').click();
    await expect(page.getByTestId('bulk-edit-sheet')).toHaveCount(0);

    // The outcome, not the request. Every fixture row starts at 5 days, so the
    // relative op has to have been resolved per row for all three to read 8.
    for (const id of ['t1', 't2', 't3']) {
      const written = store.rows().find((r) => r.id === id) as { duration?: number };
      expect(written.duration).toBe(8);
    }
    await expect(page.locator('[data-row-id="t1"]')).toContainText('8');
  });

  test('the inert Replace arm refuses at the attempt, across a multi-row selection (#3153)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2', 't3']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    const sheet = page.getByTestId('bulk-edit-sheet');
    // `S9` — the 0.4 geometry is final: all four arms, present and labelled.
    for (const arm of ['leave', 'add', 'remove', 'replace']) {
      await expect(sheet.getByTestId(`bulk-owner-${arm}`)).toBeVisible();
    }
    // `S12` — `aria-disabled`, NEVER `disabled`, so the arm keeps its tab stop
    // and its accessible name and the refusal is reachable by keyboard too.
    const replace = sheet.getByTestId('bulk-owner-replace-input');
    await expect(replace).toHaveAttribute('aria-disabled', 'true');
    // The real `disabled` IDL property, not Playwright's `toBeEnabled()` — that
    // helper treats `aria-disabled` as disabled, which is exactly the state this
    // assertion has to be able to tell apart from a hard `disabled` attribute.
    await expect(replace).toHaveJSProperty('disabled', false);
    await expect(sheet.getByTestId('bulk-owner-replace-badge')).toHaveText('0.5');
    // The reason is stated AT REST, before anyone attempts anything.
    await expect(sheet).toContainText('Remove and Replace ship in 0.5');

    // Driven by KEYBOARD, and not incidentally: `aria-disabled` is what makes an
    // arm keep its tab stop, and Playwright's own actionability treats an
    // aria-disabled control as un-clickable — so a pointer click here would
    // assert the opposite of the property under test. Space on a focused radio
    // is the attempt, and the `preventDefault` is what makes it refuse.
    await replace.focus();
    await expect(replace).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sheet.getByTestId('bulk-owner-refusal')).toContainText('ships in 0.5');
    // Nothing was selected and nothing became applicable — the refusal fires at
    // the moment of the attempt, never silently at Apply.
    await expect(replace).not.toBeChecked();
    await expect(sheet.getByTestId('bulk-owner-leave-input')).toBeChecked();
    await expect(page.getByTestId('bulk-edit-apply')).toBeDisabled();
  });

  test('the selection strip offers Edit N items as a control (#3152 S23)', async ({ page }) => {
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2']);

    const entry = page.getByTestId('build-mode-bulk-edit');
    await expect(entry).toContainText('Edit 2 items');
    await entry.click();
    await expect(
      page.getByTestId('bulk-edit-sheet').getByRole('heading', { name: 'Edit 2 items' }),
    ).toBeVisible();
  });

  test('the cheatsheet advertises the binding', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Survey the site')).toBeVisible();
    await page.keyboard.press('?');

    await expect(
      page.getByText('Edit every selected item — dates, duration, progress, sprint, owner'),
    ).toBeVisible();
  });
});

/**
 * A whole-request refusal, end to end (#3332, web-rule 372).
 *
 * Distinct from the 207 partial above: a 207 is a *report*, and the sheet has
 * always presented it well. This is the other branch — the batch never ran at
 * all — and until #3332 it rendered the server's sentence nowhere, in a bare
 * `<div>` inside the review block with no live region on the sheet, and relabeled
 * Apply to "Retry" whatever the server had said.
 */
test.describe('Bulk-edit sheet — a refused batch (#3332)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  /** Refuse the whole batch with `status` and a DRF body, before the 207 route can answer. */
  async function refuseBatch(page: Page, status: number, body: unknown) {
    await page.route(/\/api\/v1\/projects\/[^/]+\/tasks\/bulk\/$/, (route) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      }),
    );
  }

  test('a 403 shows the server’s own sentence in a live region and KEEPS the verb', async ({
    page,
  }) => {
    await refuseBatch(page, 403, { detail: 'Only a Scheduler may edit this plan.' });
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2', 't3']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await page.getByTestId('bulk_delivery_mode-scrum').click();
    await page.getByTestId('bulk-edit-apply').click();

    const alert = page.getByTestId('bulk-edit-error');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveAttribute('role', 'alert');
    await expect(alert).toHaveText('Only a Scheduler may edit this plan.');
    // A sibling of the review block, not a child of it: `aria-atomic` on the
    // description would otherwise make AT re-read the whole preview first.
    await expect(page.getByTestId('bulk-edit-review')).not.toContainText(
      'Only a Scheduler may edit this plan.',
    );

    // The verb survives. A second identical POST earns the identical 403, and
    // "Apply to 3 items" is the only thing naming the scope on the button.
    await expect(page.getByTestId('bulk-edit-apply')).toHaveText('Apply to 3 items');
    // Scoped to the sheet: `ScheduleForecastBar` renders its own "Retry" whenever
    // the Monte Carlo read fails with anything but a 404, which under CI load it
    // does. A page-wide locator counted that button and failed a sheet assertion
    // on an unrelated component's error state (#3401).
    await expect(
      page.getByTestId('bulk-edit-sheet').getByRole('button', { name: 'Retry' }),
    ).toHaveCount(0);

    // The sheet stays open on the form phase — a refusal is not a result.
    await expect(page.getByTestId('bulk-edit-result')).toHaveCount(0);
  });

  test('a 5xx does offer Retry — the one failure a replay can fix', async ({ page }) => {
    await refuseBatch(page, 503, {});
    await page.goto(BASE_URL);
    await selectRows(page, ['t1', 't2']);
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');

    await page.getByTestId('bulk_delivery_mode-scrum').click();
    await page.getByTestId('bulk-edit-apply').click();

    await expect(page.getByTestId('bulk-edit-error')).toHaveText('Couldn’t apply the changes.');
    await expect(page.getByTestId('bulk-edit-apply')).toHaveText('Retry');
  });
});

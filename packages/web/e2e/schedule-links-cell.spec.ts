/**
 * The Links cell (#3023, `design_handoff_trueppm_v4/README.md`).
 *
 * Two claims, both about the *row* rather than about a request firing.
 *
 *  1. The row **states** its dependency shape at rest — `←FS×2` where the links
 *     agree, `←FS·SS` where they differ — with no selection, no hover and no
 *     focus mode. The shipped chips rendered only while the row was selected,
 *     so the outline could not be scanned for "which rows are linked".
 *  2. The cell **is a control** for someone who may author, opening the picker
 *     the right-click menu already opened; and **text** for a viewer, per web
 *     rule 302 — absent, not disabled.
 *
 * No `setupTaskStore` here: nothing in this spec commits a write. It opens the
 * picker and asserts the picker opened; the mutation and its refetch are the
 * next MR's (type + lag inside the picker). The stateless list mock therefore
 * has nothing to erase (#2752).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-lk-00000000-0000-0000-0000-000000003023';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Bridge Deck Replacement',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-16',
  planned_start: '2026-04-05',
  duration: 10,
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

/**
 * Rows chosen so every arm of the flag is on screen at once:
 *   Survey      — successors only, no predecessors
 *   Excavate    — two predecessors that AGREE (FS×2), and it is CRITICAL
 *   Pour slab   — two predecessors that DIFFER (FS·SS)
 *   Cure        — one predecessor, no successors
 *   Signage     — no links in EITHER direction (the "add your first link" row)
 */
const TASKS = [
  // An edge is critical only when BOTH endpoints are (`useScheduleTasks` derives
  // it that way), so all three of Survey / Permit / Excavate carry the flag —
  // otherwise the critical arm below would be pinned by nothing.
  { ...baseRow, id: 'survey', wbs_path: '1', name: 'Survey', is_critical: true },
  { ...baseRow, id: 'permit', wbs_path: '2', name: 'Permit', is_critical: true },
  { ...baseRow, id: 'excavate', wbs_path: '3', name: 'Excavate', is_critical: true },
  { ...baseRow, id: 'slab', wbs_path: '4', name: 'Pour slab' },
  { ...baseRow, id: 'cure', wbs_path: '5', name: 'Cure' },
  { ...baseRow, id: 'signage', wbs_path: '6', name: 'Signage' },
];

const DEPENDENCIES = [
  // Excavate ← Survey (FS), Permit (FS)  → agree. Survey is critical too, so
  // the edge into a critical successor reads as critical on both ends.
  { id: 'd1', predecessor: 'survey', successor: 'excavate', dep_type: 'FS', lag: 0 },
  { id: 'd2', predecessor: 'permit', successor: 'excavate', dep_type: 'FS', lag: 0 },
  // Pour slab ← Excavate (FS), Permit (SS +2d)  → differ
  { id: 'd3', predecessor: 'excavate', successor: 'slab', dep_type: 'FS', lag: 0 },
  { id: 'd4', predecessor: 'permit', successor: 'slab', dep_type: 'SS', lag: 2 },
  // Cure ← Pour slab (FS)
  { id: 'd5', predecessor: 'slab', successor: 'cure', dep_type: 'FS', lag: 0 },
];

const outline = (page: Page) => page.getByRole('treegrid', { name: 'Task list' });
const row = (page: Page, id: string) => page.locator(`[data-row-id="${id}"]`);
const linksCell = (page: Page, id: string) => row(page, id).getByTestId('links-cell');

/** Override the `?self=true` membership row `setupApiMocks` hard-codes to Admin. */
async function setRole(page: Page, role: number) {
  await page.route(`**/api/v1/projects/${PROJECT_ID}/members/?self=true`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'mem-self', role, role_label: 'Test', user_id: 'e2e-user' }]),
    }),
  );
}

async function goto(page: Page, opts: { role?: number } = {}) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks: TASKS,
    dependencies: DEPENDENCIES,
  });
  if (opts.role !== undefined) await setRole(page, opts.role);
  await page.goto(BASE_URL);
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
  // The flag needs the dependencies query too — gate on a row that has one,
  // not just on the outline being present.
  await expect(linksCell(page, 'excavate')).toBeVisible();
}

test.describe('Links cell — the row states its dependency shape (#3023)', () => {
  test('names the types at rest, with NOTHING selected', async ({ page }) => {
    await goto(page);

    // No row is selected — the whole point. `FS×2` (a chain) and `FS·SS` (an
    // overlap) are the two forms the design names, and a count could not tell
    // them apart: both rows have exactly two predecessors.
    await expect(row(page, 'excavate')).not.toHaveAttribute('aria-selected', 'true');
    await expect(
      linksCell(page, 'excavate').getByTestId('dep-flag-predecessor'),
    ).toHaveText('←FS×2');
    await expect(linksCell(page, 'slab').getByTestId('dep-flag-predecessor')).toHaveText('←FS·SS');
    await expect(linksCell(page, 'cure').getByTestId('dep-flag-predecessor')).toHaveText('←FS');
  });

  test('states the outgoing direction too, and says nothing for an unlinked row', async ({
    page,
  }) => {
    await goto(page);
    await expect(linksCell(page, 'survey').getByTestId('dep-flag-successor')).toHaveText('→FS');
    // Survey has no predecessors — the flag is absent rather than reading "0".
    await expect(linksCell(page, 'survey').getByTestId('dep-flag-predecessor')).toHaveCount(0);
    // Permit's successors differ in type; Cure has neither direction populated
    // beyond its single predecessor.
    await expect(linksCell(page, 'permit').getByTestId('dep-flag-successor')).toHaveText('→FS·SS');
    await expect(linksCell(page, 'cure').getByTestId('dep-flag-successor')).toHaveCount(0);
    // Signage has neither direction — the cell states the absence.
    await expect(linksCell(page, 'signage').getByTestId('dep-flag-predecessor')).toHaveCount(0);
    await expect(linksCell(page, 'signage')).toHaveAttribute(
      'aria-label',
      'Links: none for Signage',
    );
  });

  test('says "on the critical path" in WORDS, not only in the tint', async ({ page }) => {
    await goto(page);
    // WCAG 1.4.1 — and the wiring under it: `is_critical` on the endpoint tasks
    // is what ScheduleView folds into the flag, so this pins the derivation, not
    // just the styling.
    await expect(linksCell(page, 'excavate')).toHaveAttribute(
      'aria-label',
      /2 predecessors: 2 × Finish-to-Start — on the critical path/,
    );
    await expect(linksCell(page, 'cure')).not.toHaveAttribute(
      'aria-label',
      /critical path/,
    );
  });

  test('carries the full detail in the cell label, including lag', async ({ page }) => {
    await goto(page);
    await expect(linksCell(page, 'slab')).toHaveAttribute(
      'aria-label',
      'Links for Pour slab — 2 predecessors: Finish-to-Start, Start-to-Start +2d; 1 successor: Finish-to-Start',
    );
    await expect(linksCell(page, 'survey')).toHaveAttribute(
      'aria-label',
      'Links for Survey — 1 successor: Finish-to-Start — on the critical path',
    );
  });

  test('the column is on the Grid and its header names it', async ({ page }) => {
    await goto(page);
    await expect(
      page.getByRole('columnheader', { name: 'Dependency links' }),
    ).toBeVisible();
  });
});

test.describe('Links cell — a control for an author', () => {
  test('clicking the cell opens the dependency picker', async ({ page }) => {
    await goto(page);

    const control = linksCell(page, 'slab').getByRole('button', {
      name: 'Edit predecessor links',
    });
    await expect(control).toBeVisible();
    await control.click();

    // The existing picker, unchanged — this MR moves the entry point, not the
    // picker. Its modality and its write payload are the next MR's.
    //
    // Named, not a bare `getByRole('dialog')`: the task drawer is a permanently
    // mounted (translated-off) `role="dialog"`, so an unnamed locator is a
    // strict-mode collision, not a missing picker.
    const picker = page.getByRole('dialog', { name: /Add predecessor to/ });
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('aria-label', 'Add predecessor to \u201CPour slab\u201D');
  });

  test('the SUCCESSOR chip opens the successor direction, not the predecessor one', async ({
    page,
  }) => {
    await goto(page);
    await linksCell(page, 'survey')
      .getByRole('button', { name: 'Edit successor links' })
      .click();
    await expect(page.getByRole('dialog', { name: /Add successor to/ })).toBeVisible();
  });

  test('an unlinked row offers the cell as the "add your first link" control', async ({ page }) => {
    await goto(page);
    await linksCell(page, 'signage')
      .getByRole('button', { name: 'Add a dependency link to Signage' })
      .click();
    await expect(page.getByRole('dialog', { name: /Add predecessor to/ })).toBeVisible();
  });

  test('clicking the cell does not select or rename the row underneath', async ({ page }) => {
    await goto(page);
    await linksCell(page, 'cure').getByRole('button', { name: 'Edit predecessor links' }).click();
    await expect(page.getByRole('dialog', { name: /Add predecessor to/ })).toBeVisible();
    // The row's own click handler must not have fired through the button.
    await expect(row(page, 'cure').locator('input')).toHaveCount(0);
  });
});

test.describe('Links cell — text, not a field, for a viewer (web rule 302)', () => {
  test('a Viewer reads the same statement and finds no control at all', async ({ page }) => {
    await goto(page, { role: 1 }); // ROLE_VIEWER

    // The fact is still stated — a viewer reads the plan.
    await expect(linksCell(page, 'slab').getByTestId('dep-flag-predecessor')).toHaveText('←FS·SS');
    await expect(linksCell(page, 'slab')).toHaveAttribute(
      'aria-label',
      'Links for Pour slab — 2 predecessors: Finish-to-Start, Start-to-Start +2d; 1 successor: Finish-to-Start',
    );

    // Absent, not disabled: no button anywhere in the column, so there is no
    // gesture left to refuse and nothing announces itself as dimmed.
    await expect(page.getByTestId('links-cell-control')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Edit .* links$/ })).toHaveCount(0);
    // Including on the unlinked row: a viewer has no "add a link" affordance
    // either, only the statement that there are none.
    await expect(
      page.getByRole('button', { name: 'Add a dependency link to Signage' }),
    ).toHaveCount(0);
  });
});

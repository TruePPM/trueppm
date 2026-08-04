/**
 * Paste-many — spreadsheet rows into the outline, hierarchy from leading
 * indentation (#2724).
 *
 * The property under test is the full round trip: a multi-row clipboard paste
 * becomes ONE `tasks/bulk/` batch with client-minted ids (ADR-0772), lands as a
 * real parent/child WBS subtree (not a flat dump at root — task_bulk.py's
 * `_apply_create` did not resolve `parent_id` before this issue), the receipt
 * strip reports accurate counts, and Undo removes the whole paste as one step.
 *
 * Every task read here goes through `setupTaskStore` (extended in #2724 to also
 * own `tasks/bulk/`), not the stateless default list mock — the tree-shape
 * assertion below reads the DOM *after* the paste commits, which would
 * otherwise race `useBulkCreateTasks`' `['tasks']` invalidation (#2752).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';

type Page = import('@playwright/test').Page;

const PROJECT_ID = 'e2e-paste-00000000-0000-0000-0000-000000002724';
const SCHEDULE_URL = `/projects/${PROJECT_ID}/schedule`;
const ANA_ID = 'res-ana-2724';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Paste Many Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'pm1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
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
  },
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

// One root task ("Design", duration 5, owned by Ana) and two children ("Wireframes"
// duration 3, "Review" — no duration cell at all, the needs-a-duration case). Leading
// tabs on the child rows are the hierarchy signal.
const PASTE_TEXT = 'Task\tDuration\tOwner\nDesign\t5\tAna Rivera\n\tWireframes\t3\n\tReview';

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
  await page.route('**/api/v1/project-resources/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: ROSTER.length, next: null, previous: null, results: ROSTER }),
    }),
  );
  return setupTaskStore(page, { tasks: FIXTURE_TASKS });
}

/** Focus a row (single click → RowFocused, not CellEdit) then dispatch a synthetic
 *  multi-row clipboard paste, exactly as `ScheduleView`'s `window` paste listener
 *  reads it — real OS clipboard access isn't needed for a same-origin synthetic
 *  `ClipboardEvent`. */
async function pasteOntoRow(page: Page, rowText: string, text: string) {
  await page.getByText(rowText, { exact: true }).click();
  await page.evaluate((pasted) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', pasted);
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
  }, text);
}

test.describe('paste-many — spreadsheet rows into the outline (#2724)', () => {
  test('pastes a hierarchy, reports the receipt, and undo removes the whole paste', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(SCHEDULE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await pasteOntoRow(page, 'Foundation', PASTE_TEXT);

    // Tree shape: Design lands as a ROOT sibling of Foundation; Wireframes and
    // Review land as its children, one level deeper — not three flat root rows,
    // which is what task_bulk.py produced before #2724 wired parent_id through.
    const designRow = page.getByRole('row').filter({ hasText: 'Design' }).first();
    await expect(designRow).toBeVisible();
    await expect(designRow).toHaveAttribute('aria-level', '1');
    const wireframesRow = page.getByRole('row').filter({ hasText: 'Wireframes' });
    const reviewRow = page.getByRole('row').filter({ hasText: 'Review' });
    await expect(wireframesRow).toHaveAttribute('aria-level', '2');
    await expect(reviewRow).toHaveAttribute('aria-level', '2');

    // Receipt strip: 3 rows, 2 levels, all three columns matched, one row needing
    // a duration (Review — no duration cell in the pasted block).
    const receipt = page.getByTestId('paste-receipt-strip');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('3 rows pasted');
    await expect(receipt).toContainText('2 levels');
    await expect(receipt).toContainText('name · duration · owner matched');
    await expect(receipt).toContainText('1 row needs a duration');

    // Undo removes the whole paste as one step — the outline returns to exactly
    // its pre-paste state, not a partial rollback.
    await receipt.getByRole('button', { name: /Undo/ }).click();
    await expect(receipt).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Design' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Wireframes' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Review' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Foundation' })).toHaveCount(1);
  });

  test('F8 walks to the row a paste flagged as needing a duration', async ({ page }) => {
    await setup(page);
    await page.goto(SCHEDULE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await pasteOntoRow(page, 'Foundation', PASTE_TEXT);
    await expect(page.getByTestId('paste-receipt-strip')).toBeVisible();

    await page.keyboard.press('F8');
    // Review is the only row the paste flagged — F8 lands focus there. The build
    // mode hint strip reflects the newly focused row.
    await expect(page.getByTestId('build-mode-hint-strip')).toHaveAttribute(
      'data-mode',
      'RowFocused',
    );
  });

  test('Keep dismisses the receipt without touching the pasted rows', async ({ page }) => {
    await setup(page);
    await page.goto(SCHEDULE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await pasteOntoRow(page, 'Foundation', PASTE_TEXT);
    const receipt = page.getByTestId('paste-receipt-strip');
    await expect(receipt).toBeVisible();

    await receipt.getByRole('button', { name: 'Keep' }).click();
    await expect(receipt).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: 'Design' })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: 'Wireframes' })).toHaveCount(1);
  });
});

/**
 * Total float / Free float columns on the Schedule outline (#3344).
 *
 * The engine has computed both numbers since 0.1 and the API has returned both
 * read-only since; the outline showed neither, so a waterfall planner could not
 * scan a plan by slack — the one thing computing a critical path is for.
 *
 * Three claims are under test, and only the browser can settle any of them:
 *   1. the two columns render, right-aligned, with a value per row, and a
 *      negative one reads as late rather than as a smaller number;
 *   2. the DEFAULT is a function of the project's methodology — hidden on AGILE,
 *      shown on WATERFALL/HYBRID — while the user's own toggle still wins; and
 *   3. neither column is clipped once the outline fits, which is arithmetic
 *      about a render clamp that no unit test can perform (web rule 370) — see
 *      the `fit` describe for why that assertion runs at 1440 and not at
 *      Playwright's 1280 default.
 *
 * No `setupTaskStore`: nothing here writes, so the stateless list mock cannot
 * erase a committed value out from under a poll (#2752).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const WATERFALL_ID = 'e2e-ff-00000000-0000-0000-0000-000000003344';
const AGILE_ID = 'e2e-fa-00000000-0000-0000-0000-000000003344';

function project(id: string, methodology: 'WATERFALL' | 'AGILE') {
  return {
    id,
    name: 'Float Columns Fixture',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology,
    effective_methodology: methodology,
  };
}

const baseRow = {
  early_start: '2026-04-05',
  early_finish: '2026-04-16',
  planned_start: '2026-04-05',
  duration: 10,
  percent_complete: 0,
  is_critical: false,
  is_summary: false,
  is_milestone: false,
  parent_id: null,
  status: 'NOT_STARTED',
  assignees: [],
  total_float: null,
  free_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const TASKS = [
  // On the path: zero slack either way.
  {
    ...baseRow,
    id: 'cp',
    wbs_path: '1',
    name: 'Foundation pour',
    is_critical: true,
    total_float: 0,
    free_float: 0,
  },
  // The pair's whole reason for existing: eight days of project slack, but this
  // row's own successor starts in two, so it has two.
  { ...baseRow, id: 'gap', wbs_path: '2', name: 'Cladding order', total_float: 8, free_float: 2 },
  // Already late against the project finish.
  { ...baseRow, id: 'late', wbs_path: '3', name: 'Permit renewal', total_float: -3, free_float: -3 },
  // CPM has not reached this row. Not zero.
  { ...baseRow, id: 'raw', wbs_path: '4', name: 'Snagging' },
];

const outline = (page: Page) => page.getByRole('treegrid', { name: 'Item list' });
const row = (page: Page, id: string) => page.locator(`[data-row-id="${id}"]`);

async function goto(page: Page, id: string, methodology: 'WATERFALL' | 'AGILE') {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [project(id, methodology)],
    projectId: id,
    tasks: TASKS,
  });
  await page.goto(`/projects/${id}/schedule`);
  // Gate on the outline itself, not on a control: every assertion below reads a
  // cell that only exists once the task list has resolved.
  await expect(outline(page)).toBeVisible({ timeout: 10_000 });
}

test.describe('Schedule float columns — Waterfall (#3344)', () => {
  test.beforeEach(({ page }) => goto(page, WATERFALL_ID, 'WATERFALL'));

  test('shows both headings, abbreviated but fully named to assistive tech', async ({ page }) => {
    const header = page.getByRole('row').first();
    await expect(header.getByRole('columnheader', { name: 'Total float' })).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Free float' })).toBeVisible();
    // The visible word is a substring of the accessible name in both cases, so
    // WCAG 2.5.3 (Label in Name) holds — "Float" of "Total float", "Free" of
    // "Free float". Asserting the text as well as the role catches a heading
    // that keeps its label and loses its abbreviation.
    await expect(header.getByRole('columnheader', { name: 'Total float' })).toHaveText(/Float/);
    await expect(header.getByRole('columnheader', { name: 'Free float' })).toHaveText(/Free/);
  });

  test('states each row twice: total against the project, free against the successor', async ({
    page,
  }) => {
    const gap = row(page, 'gap');
    await expect(gap.getByRole('gridcell', { name: 'Total float: 8 working days' })).toHaveText(
      '8d',
    );
    await expect(gap.getByRole('gridcell', { name: 'Free float: 2 working days' })).toHaveText('2d');
  });

  test('a negative float says "late" in words, not only in red', async ({ page }) => {
    // Colour cannot be the only carrier of the one value that changes what the
    // reader does next (WCAG 1.4.1, web rules 12/120). The minus sign carries it
    // visually and the accessible name carries it in words.
    const cell = row(page, 'late').getByRole('gridcell', {
      name: 'Total float: 3 working days late',
    });
    await expect(cell).toHaveText('-3d');
    await expect(cell).toHaveCSS('font-weight', '600');
  });

  test('a row CPM has not reached reads as unanswered, never as zero slack', async ({ page }) => {
    // The empty state of this column. `0d` here would assert the row has no
    // slack — the opposite reading, and the alarming one.
    const raw = row(page, 'raw');
    await expect(raw.getByRole('gridcell', { name: 'Total float: not computed yet' })).toHaveText(
      '—',
    );
    await expect(raw.getByRole('gridcell', { name: 'Free float: not computed yet' })).toHaveText(
      '—',
    );
  });

  test.describe('fit', () => {
    // 1440, not Playwright's 1280 default, and the reason is measured rather
    // than convenient. The outline paints at its own summed width and the canvas
    // beside it gives way, so the room the clamp has for the outline at 1280 is
    // 1280 − 248 (sidebar) − 320 (MIN_BAR_TRACK) − 4 (splitter) = 708px — and the
    // EIGHT-column outline already needed 738. Owner was clipped by 30px before
    // these two columns existed. Asserting at 1280 would therefore be asserting a
    // pre-existing defect (web rule 366(d): a pre-existing overflow is a finding,
    // not a baseline — filed separately), and it would fail whatever width these
    // columns took. 1440 is the first common viewport where the full ten-column
    // set fits, with 18px to spare at the shipped 56px defaults.
    test.use({ viewport: { width: 1440, height: 900 } });

    test('neither float column is clipped once the outline fits', async ({ page }) => {
      // `toBeVisible()` cannot see this: a clipped cell keeps a non-empty box and
      // Playwright counts it as visible, which is the same blindness rules 343,
      // 367 and 370 each record from a different direction. Measure the edge.
      const panelBox = await outline(page).boundingBox();
      const cellBox = await row(page, 'gap')
        .getByRole('gridcell', { name: /^Free float/ })
        .boundingBox();
      expect(panelBox).not.toBeNull();
      expect(cellBox).not.toBeNull();
      expect(cellBox!.width).toBeGreaterThan(0);
      expect(cellBox!.x + cellBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1);
    });
  });

  test('Display ▸ Columns offers both, and turning one off removes its cells', async ({ page }) => {
    // Rule 316 applied to a column: the menu that offers it and the panel that
    // draws it resolve through one predicate, so the toggle cannot lie.
    await page.getByRole('button', { name: 'Display', exact: true }).click();
    const totalFloat = page.getByRole('menuitemcheckbox', { name: 'Total float', exact: true });
    await expect(totalFloat).toBeVisible();
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Free float', exact: true }),
    ).toBeVisible();

    await totalFloat.click();
    await expect(page.getByRole('gridcell', { name: /^Total float/ })).toHaveCount(0);
    // …and only that one: Free float is a separate choice.
    await expect(page.getByRole('gridcell', { name: /^Free float/ })).toHaveCount(TASKS.length);
  });
});

test.describe('Schedule float columns — Agile default (#3344)', () => {
  test('hides both by default, and honours an explicit opt-in', async ({ page }) => {
    await goto(page, AGILE_ID, 'AGILE');
    // Float is a waterfall instrument, and an Agile project's Schedule tab is not
    // even in the nav by default (#2619). Hidden is a DEFAULT, though — the
    // columns are still offered, so a hybrid-in-practice team can turn them on.
    await expect(page.getByRole('gridcell', { name: /^Total float/ })).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: /^Free float/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Display', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Total float', exact: true }).click();
    await expect(page.getByRole('gridcell', { name: /^Total float/ })).toHaveCount(TASKS.length);
    // The opt-in was for one column, not for the pair.
    await expect(page.getByRole('gridcell', { name: /^Free float/ })).toHaveCount(0);
  });
});

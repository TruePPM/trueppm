/**
 * Schedule teaching-surface arbitration — web rule 363 (#3134).
 *
 * Three surfaces used to draw at once on a build-mode, edit-rights,
 * row-focused Schedule: `ScheduleCoachBar` above the outline,
 * `BuildModeHintStrip` below it, and `ScheduleInsertTargetStatement` in the
 * toolbar. The insert statement is a **readout** and stays; the two teachers
 * are now partitioned on focus mode so exactly one of them is ever up.
 *
 * `teachingSurfaces.test.ts` proves the partition over the whole input space.
 * What only a browser can answer is what this file covers: that the predicates
 * are wired to the real focus machine, that dismiss → restore still works both
 * ways round, and that no chord loses its one discovery point on the way.
 *
 * Note the chord assertions use the WORD spelling (`Ctrl+Alt+G`). Playwright
 * runs the non-Mac branch of `formatChord`, and `scheduleTeachingChords`
 * enforces that no e2e assertion hardcodes a Mac glyph.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, useFullToolbar } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-teach-00000000-0000-0000-0000-000000003134';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Teaching Surfaces Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(id: string, wbs: string, name: string, start: string, finish: string) {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: start,
    early_finish: finish,
    planned_start: start,
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
  row('t1', '1', 'Foundation', '2026-04-05', '2026-04-09'),
  row('t2', '2', 'Framing', '2026-04-12', '2026-04-16'),
  row('t3', '3', 'Roofing', '2026-04-19', '2026-04-23'),
];

const coachBar = (page: Page) => page.getByRole('button', { name: /Hide the how-to bar/i });
const hintStrip = (page: Page) => page.getByTestId('build-mode-hint-strip');

async function setup(page: Page, tasks = FIXTURE_TASKS): Promise<void> {
  // The how-to bar and the Display trigger are both toolbar-width-sensitive
  // since #3076, and this spec is about neither. `schedule-toolbar-fit` owns
  // what the bar does as it narrows.
  await useFullToolbar(page);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
  });
}

test.describe('the canvas column carries exactly one teacher (rule 363)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('the how-to bar teaches the idle outline and stands down once a row is focused', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    // Idle: the venue-anchored teacher is up, the focus-anchored one is not.
    await expect(coachBar(page)).toBeVisible();
    await expect(hintStrip(page)).toHaveCount(0);

    await page.getByText('Foundation').click();

    // Engaged: they swap. This is the assertion the issue exists for — before
    // it, BOTH of these were true at the same time.
    await expect(hintStrip(page)).toBeVisible();
    await expect(hintStrip(page)).toHaveAttribute('data-mode', 'RowFocused');
    await expect(coachBar(page)).toHaveCount(0);
  });

  test('standing down is not being dismissed — clearing the selection brings it back', async ({
    page,
  }) => {
    // The distinction rule 363 insists on: suppression is a render condition,
    // never a write. If the swap above had cleared `displayOptions.coach`, this
    // would fail and the one-way dismissal of #2959 would be back by accident.
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click();
    await expect(coachBar(page)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(hintStrip(page)).toHaveCount(0);
    await expect(coachBar(page)).toBeVisible();
  });

  test('nothing lands on <body> when the how-to bar retires under a row click', async ({
    page,
  }) => {
    // The bar unmounts on the same interaction that moves focus into the
    // outline. Focus must already have left it — an unmount that drops focus to
    // the document body strands a keyboard user mid-plan.
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(coachBar(page)).toBeVisible();

    await page.getByText('Foundation').click();
    await expect(coachBar(page)).toHaveCount(0);

    expect(await page.evaluate(() => document.activeElement?.tagName ?? 'BODY')).not.toBe('BODY');
    await expect(page.locator('[data-row-id="t1"]:focus-within')).toHaveCount(1);
  });
});

test.describe('the group chord keeps its one discovery point (#2955, #2987)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('a multi-row selection advertises Group into a phase, with its chord', async ({ page }) => {
    // The regression this guards: `structureButtons` ships OFF, so the strip's
    // SELECTION_HINTS is the only surface naming this chord at the moment a
    // multi-row selection makes it mean something. Any future re-derivation of
    // the arbitration that retires the strip has to fail here first.
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click();
    const selected = page.locator('[role="row"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await page.keyboard.press('Shift+ArrowDown');
    await expect(selected).toHaveCount(2);

    const strip = hintStrip(page);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('data-selection-count', '2');
    await expect(strip).toContainText('Group into a phase');
    // The chord itself, not just the label — a hint that names the act without
    // naming the key teaches nothing a menu item would not.
    //
    // Matched by SHAPE rather than by spelling, and that is not a weakening.
    // `formatChord` renders this chip from `navigator.platform`, so it reads
    // `Ctrl+Alt+G` on CI's Linux runner and the glyph form on a developer's Mac
    // — a literal either way is green on one machine and red on the other, and
    // the Mac literal additionally trips the e2e glyph gate in
    // `scheduleTeachingChords.test.tsx`. What the assertion has to hold is that
    // a MODIFIED chord chip for G is present, which is what actually regressed
    // in #2955: the alternative failure is a bare `G`, and this catches it.
    const groupChip = strip.locator('kbd').filter({ hasText: /G$/ });
    await expect(groupChip).toHaveCount(1);
    await expect(groupChip).toHaveText(/^(?:Ctrl\+Alt\+|[^A-Za-z]+)G$/);

    // And it is genuinely the only surface saying so at this moment: the
    // how-to bar, which also names the chord, has stood down for it.
    await expect(coachBar(page)).toHaveCount(0);
  });

  test('the other selection hints and the cheatsheet route survive alongside it', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click();
    await page.keyboard.press('Shift+ArrowDown');

    const strip = hintStrip(page);
    await expect(strip).toContainText('Delete all selected');
    await expect(strip).toContainText('Clear selection');
    // `? All shortcuts` — the route into BuildModeCheatsheet, which rule 363
    // clause (d) names as the compliant on-demand end state.
    await expect(strip.getByRole('button', { name: 'Show all keyboard shortcuts' })).toBeVisible();
  });

  test('the cell-edit hints have no other home and are still reachable', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click();
    await page.keyboard.press('F2');

    const strip = hintStrip(page);
    await expect(strip).toHaveAttribute('data-mode', 'CellEdit');
    await expect(strip).toContainText('Save');
    await expect(strip).toContainText('Next field');
    // The how-to bar teaches none of these and is not competing for the band.
    await expect(coachBar(page)).toHaveCount(0);
  });
});

test.describe('empty-plan suppression (T4)', () => {
  test('an empty plan gets the blank-project canvas, not a coach for acts it cannot offer', async ({
    page,
  }) => {
    // Three lessons — indent an item, select rows to group, hover a row — none
    // of which can be performed with no rows. Clause (b).
    await setup(page, []);
    await page.goto(BASE_URL);

    // Gate on the empty canvas having actually rendered before asserting the
    // coach bar's absence — otherwise this passes on a page that never loaded.
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('complementary', { name: 'Ways to fill this project' }),
    ).toBeVisible();
    await expect(page.locator('[data-row-id]')).toHaveCount(0);

    await expect(coachBar(page)).toHaveCount(0);
    await expect(hintStrip(page)).toHaveCount(0);
  });

  test('and it returns as soon as the plan has a row to act on', async ({ page }) => {
    // The suppression must be a live predicate rather than a first-load
    // decision — otherwise a planner's first row leaves them with no teacher
    // until they reload.
    await setup(page);
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(coachBar(page)).toBeVisible();
  });
});

test.describe('dismiss → restore stays a two-way door (#2959)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
  });

  test('pointer: the X hides it and Display ▸ How-to bar brings it back', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await expect(coachBar(page)).toBeVisible();

    await coachBar(page).click();
    await expect(coachBar(page)).toHaveCount(0);

    // Scoped through the toolbar: `name` is a substring match and the dismiss
    // control says "bring it back from Display options", so a bare 'Display'
    // resolves to two buttons whenever the bar is up.
    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .click();
    const menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu).toBeVisible();
    const toggle = menu.getByRole('menuitemcheckbox', { name: 'How-to bar' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();

    await page.keyboard.press('Escape');
    await expect(coachBar(page)).toBeVisible();
  });

  test('keyboard: the same round trip without a mouse', async ({ page }) => {
    // The whole point of #2959. The surface this bar replaced could only be
    // dismissed, which left a keyboard user who hid it with no route back to
    // the one surface that explained the keyboard.
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await coachBar(page).focus();
    await page.keyboard.press('Enter');
    await expect(coachBar(page)).toHaveCount(0);

    await page
      .getByRole('toolbar', { name: 'Schedule toolbar' })
      .getByRole('button', { name: 'Display' })
      .focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Display options' });
    await expect(menu).toBeVisible();

    const toggle = menu.getByRole('menuitemcheckbox', { name: 'How-to bar' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await expect(coachBar(page)).toBeVisible();
  });

  test('a bar dismissed while a row is focused is still dismissed when the row is released', async ({
    page,
  }) => {
    // The two states are independent and must not be conflated: retiring for
    // the strip reads the stored option, dismissing writes it. If the render
    // condition ever wrote, this would come back visible.
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await coachBar(page).click();
    await expect(coachBar(page)).toHaveCount(0);

    await page.getByText('Foundation').click();
    await expect(hintStrip(page)).toBeVisible();
    await page.keyboard.press('Escape');

    await expect(hintStrip(page)).toHaveCount(0);
    await expect(coachBar(page)).toHaveCount(0);
  });
});

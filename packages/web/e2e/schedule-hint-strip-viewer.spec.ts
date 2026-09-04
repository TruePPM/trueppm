/**
 * What the hint strip teaches a reader — #3231, web rule 302.
 *
 * `buildModeActive = !isMobile`, so build mode is on for every desktop reader,
 * and `tryBuildModeFocusMove` gates only on `buildMode` with no rights check.
 * A Viewer therefore arrows the outline straight into `RowFocused`, where the
 * strip used to render `HINTS_BY_MODE.RowFocused` — `⏎ New row below`,
 * `⌥→ Indent`, `F2 Edit`. Three mutations a Viewer cannot perform, on the one
 * surface whose entire justification is teaching.
 *
 * `BuildModeHintStrip.test.tsx` proves the content rule over every focus state
 * and selection size. What only a browser can answer is the part that made this
 * a defect rather than a typo: that a reader **reaches** the state at all. A
 * unit test has to be told the mode; here the reader gets there the way the
 * user does, through the real focus machine.
 *
 * Driven by `can_author: false` on the project fixture and NOT by the membership
 * role — the same discipline as `schedule-author-gate.spec.ts`, and for the same
 * reason: a spec that drove the role would keep passing if someone re-derived
 * the gate from a client-side ordinal (ADR-0773 §(d), #3034).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, useFullToolbar } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-hintread-0000-0000-0000-000000003231';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

function project(canAuthor: boolean) {
  return [
    {
      id: FIXTURE_PROJECT_ID,
      name: 'Hint Strip Reader Project',
      description: '',
      start_date: '2026-04-01',
      calendar: 'default',
      can_author: canAuthor,
    },
  ];
}

const FIXTURE_TASKS = [
  {
    id: 'hs1',
    wbs_path: '1',
    name: 'Foundation',
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
  },
  {
    id: 'hs2',
    wbs_path: '2',
    name: 'Framing',
    early_start: '2026-04-12',
    early_finish: '2026-04-16',
    planned_start: '2026-04-12',
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
  },
];

const hintStrip = (page: Page) => page.getByTestId('build-mode-hint-strip');

async function setup(page: Page, canAuthor: boolean): Promise<void> {
  // The toolbar is width-sensitive since #3076 and this spec is about neither
  // the toolbar nor the how-to bar.
  await useFullToolbar(page);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: project(canAuthor),
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
}

test.describe('the hint strip teaches a reader only what a reader can do (#3231)', () => {
  test('a Viewer reaches RowFocused and is taught navigation, not mutation', async ({ page }) => {
    await setup(page, false);
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    // Reached the way the user reaches it — clicking the row, not calling
    // `.focus()`, which leaves the Schedule's own focus store empty.
    await page.getByText('Foundation').click();

    // The premise of the whole issue: a reader DOES land in RowFocused.
    await expect(hintStrip(page)).toBeVisible();
    await expect(hintStrip(page)).toHaveAttribute('data-mode', 'RowFocused');
    await expect(hintStrip(page)).toHaveAttribute('data-hints', 'reader');

    // The three mutations that used to render here.
    const strip = hintStrip(page);
    await expect(strip.getByText('New row below')).toHaveCount(0);
    await expect(strip.getByText('Indent')).toHaveCount(0);
    await expect(strip.getByText('Edit', { exact: true })).toHaveCount(0);

    // What a reader is taught instead — both verified against the row
    // reducer's `!canEdit` branch.
    await expect(strip.getByText('Select row')).toBeVisible();
    await expect(strip.getByText('Open details')).toBeVisible();
  });

  test('arrowing deeper into the outline keeps the reader hints', async ({ page }) => {
    // The leak arrived through the focus machine, so walk it rather than
    // asserting one state: a rights term applied at only one entry point is the
    // shape of defect this issue is an instance of.
    await setup(page, false);
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();

    await page.getByText('Foundation').click();
    await page.keyboard.press('ArrowDown');

    await expect(hintStrip(page)).toHaveAttribute('data-hints', 'reader');
    await expect(hintStrip(page).getByText('New row below')).toHaveCount(0);
  });

  test('the ? All shortcuts route survives — the strip job that needs no rights', async ({
    page,
  }) => {
    await setup(page, false);
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await page.getByText('Foundation').click();

    await hintStrip(page).getByRole('button', { name: 'Show all keyboard shortcuts' }).click();
    // Named, not bare: the always-mounted task drawer is also `role="dialog"`,
    // so an unscoped locator is a strict-mode collision rather than a failure.
    await expect(page.getByRole('dialog', { name: 'Schedule shortcuts' })).toBeVisible();
  });

  test('an author is still taught the mutations — rights-scoped, not removed', async ({ page }) => {
    // The negative control. Without it every assertion above is satisfied by a
    // strip that teaches nobody anything.
    await setup(page, true);
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    await page.getByText('Foundation').click();

    await expect(hintStrip(page)).toHaveAttribute('data-hints', 'RowFocused');
    await expect(hintStrip(page).getByText('New row below')).toBeVisible();
    await expect(hintStrip(page).getByText('Indent')).toBeVisible();
  });
});

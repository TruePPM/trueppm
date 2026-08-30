/**
 * Board view E2E — phase swimlanes, LaneMeta, per-phase add task (issue #208 #211).
 *
 * Reference migration to the shared `e2e/fixtures/` helpers — see #348.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-board-00000000-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Board Test Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'b1',
    wbs_path: '1',
    name: 'Alpha Phase',
    early_start: '2026-01-05',
    early_finish: '2026-02-14',
    duration: 30,
    percent_complete: 55,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'b2',
    wbs_path: '1.1',
    name: 'Design',
    early_start: '2026-01-05',
    early_finish: '2026-01-16',
    // PM-committed `planned_start` so the card counts toward the lane
    // rollup under the #402 `isTaskScheduled` gate; without it the card
    // is treated as uncommitted backlog and excluded from `avgProgress`.
    planned_start: '2026-01-05',
    duration: 10,
    percent_complete: 100,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'b1',
    status: 'COMPLETE',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'b3',
    wbs_path: '1.2',
    name: 'Build',
    early_start: '2026-01-19',
    early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10,
    percent_complete: 60,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'b1',
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    // b3 PPM signals: 2 predecessors (one not complete) → blocked + 1 risk severity 18.
    predecessor_count: 2,
    is_blocked: true,
    linked_risks_count: 1,
    linked_risks_max_severity: 18,
    // v2 identity meta (issue 1230): visible task reference, story-points pill,
    // stream tag. `short_id` is the raw stored hex; the card renders the
    // server-formatted refs below, never the raw value (#2430).
    short_id: '0000000A',
    short_id_display: 'T-10',
    qualified_id: 'ENG-2026-10',
    story_points: 5,
    parent_epic: 'epic-alpha',
  },
  {
    id: 'b4',
    wbs_path: '1.3',
    name: 'Release',
    early_start: '2026-02-01',
    early_finish: '2026-02-05',
    planned_start: '2026-02-01',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: true,
    is_summary: false,
    parent_id: 'b1',
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    status_changed_at: '2025-11-01T00:00:00Z',
    priority_rank: 3,
  },
  {
    id: 'b5',
    wbs_path: '1.4',
    name: 'QA Gate',
    early_start: '2026-01-05',
    early_finish: '2026-01-20',
    // PM-committed `planned_start` so the card renders scheduled-state UI
    // (float chip, baseline variance chip, SPI chip) under the #332
    // `isTaskScheduled` gate. Without it the card would be treated as
    // uncommitted backlog work and these chips would be suppressed.
    planned_start: '2026-01-05',
    duration: 12,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: 'b1',
    status: 'IN_PROGRESS',
    assignees: [],
    // SPI + band are server-owned now (#990); the card renders them directly.
    spi: 0.62,
    spi_band: 'behind',
    total_float: -3,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
    status_changed_at: '2025-11-15T00:00:00Z',
    priority_rank: 1,
    baseline_start: '2026-01-01',
    baseline_finish: '2026-01-10',
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 3 },
  });
  // Board-spec specifics that override setupApiMocks defaults — must register
  // AFTER setupApiMocks so they win (last-registered wins per Playwright).
  await page.route('**/api/v1/tasks/**', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'b-new',
          wbs_path: '1.3',
          name: 'New Task',
          early_start: '2026-02-01',
          early_finish: '2026-02-06',
          duration: 5,
          percent_complete: 0,
          is_critical: false,
          is_milestone: false,
          is_summary: false,
          parent_id: 'b1',
          status: 'NOT_STARTED',
          assignees: [],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    });
  });
  // Dependencies — task=b3 has predecessors/successors; everything else empty.
  await page.route('**/api/v1/dependencies/**', (route) => {
    if (route.request().url().includes('task=b3')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 'd1', predecessor: 'b2', successor: 'b3', dep_type: 'FS', lag: 0 },
            { id: 'd2', predecessor: 'b3', successor: 'b1', dep_type: 'FS', lag: 0 },
          ],
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });
}

/**
 * Switch board card density. At comfortable (the default) the per-card health
 * chips (float, aging, SPI, CPI, cost) are collapsed behind the worst-offender
 * badge's peek (#1305); detailed density renders the full chip set inline, which
 * is what the chip-content tests below assert.
 */
async function setDensity(
  page: import('@playwright/test').Page,
  label: 'Compact' | 'Comfortable' | 'Detailed',
) {
  await page.getByRole('button', { name: 'Card density' }).click();
  await page.getByRole('radio', { name: `Board card density: ${label}` }).click();
}

test.describe('Board view', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    // Wait for the board grid's sticky column header to confirm the board is ready.
    // Column header text comes from board-config, not from task data — it always
    // appears once the board renders (even if phase lanes are still loading).
    await expect(page.getByText('In Progress')).toBeVisible({ timeout: 10_000 });
    // Then wait for the phase lane to confirm tasks have loaded.
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('renders LaneMeta with phase name, progress bar, and task count', async ({ page }) => {
    await expect(page.getByText('Alpha Phase')).toBeVisible();
    // #991 (ADR-0115): the lane renders the phase summary task's server-owned,
    // delivery-mode-weighted percent_complete rollup (b1.percent_complete = 55),
    // not a divergent client mean of the leaf tasks.
    //
    // #3148 moved that rollup out of the visible row: the header states one
    // proportion once, as the bar, and the number now lives in the accessible
    // name (plus a hover/focus tooltip). `exact: true` because `name` is a
    // substring match — a loose string would match a longer label and let this
    // pass on a header that had lost the number entirely.
    await expect(
      page.getByRole('progressbar', { name: 'Phase progress: 55% complete', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('55%')).toHaveCount(0);
    await expect(page.getByText('4 tasks')).toBeVisible();
  });

  test('per-phase + button opens a one-field compose in the lane (#2952)', async ({ page }) => {
    const addBtn = page.getByRole('button', { name: /Add task to Alpha Phase/ });
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const field = page.getByTestId('lane-compose-field');
    await expect(field).toBeVisible();
    await expect(field.getByRole('form', { name: /Add a task to Alpha Phase/i })).toBeVisible();
    // No form — that is the whole point of the demotion (case 18).
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the lane compose POSTs the phase as parent and stays open for the next item (#2952)', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    const field = page.getByTestId('lane-compose-field');
    const input = field.getByRole('textbox');
    await input.fill('My new task');

    const [request] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/api/v1/tasks/') && r.method() === 'POST'),
      input.press('Enter'),
    ]);
    // `duration: 1`, not the backlog rail's 0 — a zero-duration row is a milestone
    // in the locked vocabulary.
    expect(request.postDataJSON()).toMatchObject({
      name: 'My new task',
      status: 'NOT_STARTED',
      duration: 1,
    });

    // Rapid-fire intake: the field survives the commit, cleared and focused.
    await expect(field).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
  });

  test('Escape closes the lane compose without writing (#2952)', async ({ page }) => {
    await page.getByRole('button', { name: /Add task to Alpha Phase/ }).click();
    const field = page.getByTestId('lane-compose-field');
    await field.getByRole('textbox').fill('Abandoned');
    await field.getByRole('textbox').press('Escape');
    await expect(page.getByTestId('lane-compose-field')).toHaveCount(0);
  });

  // Three modal tests used to sit here (#2952). The board no longer opens
  // `TaskFormModal` at all — the lane `+` offers a one-field compose, covered above.
  //
  // The non-agile story-points claim (#1961) and Cancel-closes moved to
  // `wave3-task-form-modal.spec.ts`, asserted against the Calendar's create entry point
  // where the modal still lives. The Escape case was **deleted rather than moved**: with
  // no dialog on this page, `expect(dialog).not.toBeVisible()` passes without testing
  // anything, and a vacuous green is worse than an absent test. Escape on the surface
  // this page actually has is covered above.


  test('column headers render (issue #211)', async ({ page }) => {
    // BACKLOG was lifted out of the phase grid into the BacklogBand rail
    // (#381 / epic #361). The four committed columns remain. Scope by
    // role=heading because the rail hint copy ("... promotes it to To do")
    // also contains the column words at the document level.
    await expect(page.getByRole('heading', { name: /^To Do,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^In Progress,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Review,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Done,/ })).toBeVisible();
    // Backlog is now a left-side rail with eyebrow copy "Inbox · backlog".
    await expect(page.getByText(/Inbox · backlog/i)).toBeVisible();
  });

  test('phase-grid quieting: lane meta + column dots + empty ticks (issue #385)', async ({
    page,
  }) => {
    // Lane meta — the inline 6px progress bar replaces the old ProgressRing
    // (#385 introduced it at 4px; #1965 thickened it to h-1.5 for glanceable
    // color mass). The lane meta div is `role="progressbar"` with aria-label /
    // aria-valuenow. Anchored with `^=` since #3148: the label now leads with
    // "Phase progress:" and carries the percent, so a `*=` match would also
    // accept a label that merely mentions the phrase.
    const laneBar = page.locator('[role="progressbar"][aria-label^="Phase progress:"]').first();
    await expect(laneBar).toBeVisible();
    await expect(laneBar).toHaveAttribute('aria-valuenow', '55');

    // Column status dots are aria-hidden; assert via a class probe scoped to
    // the column header row (the heading carries the accessible label).
    const todoHeader = page.getByRole('heading', { name: /^To Do,/ }).locator('..');
    await expect(todoHeader.locator('span[aria-hidden="true"]').first()).toHaveClass(
      /bg-neutral-text-disabled/,
    );
    const inProgressHeader = page.getByRole('heading', { name: /^In Progress,/ }).locator('..');
    await expect(inProgressHeader.locator('span[aria-hidden="true"]').first()).toHaveClass(
      /bg-brand-primary/,
    );
    const reviewHeader = page.getByRole('heading', { name: /^Review,/ }).locator('..');
    await expect(reviewHeader.locator('span[aria-hidden="true"]').first()).toHaveClass(
      /bg-brand-accent/,
    );
    const doneHeader = page.getByRole('heading', { name: /^Done,/ }).locator('..');
    await expect(doneHeader.locator('span[aria-hidden="true"]').first()).toHaveClass(
      /bg-semantic-on-track/,
    );

    // Empty cells render as a 16px tick at rest — no card-shaped slot.
    await expect(page.locator('[data-empty-cell="true"]').first()).toBeVisible();
  });

  test('column tints toggle is visible and on by default (issue #211)', async ({ page }) => {
    // CalmToolbar (#382) moves Column tints behind the More⋯ overflow.
    await page.getByRole('button', { name: 'More board controls' }).click();
    const toggle = page.getByLabel('Show column tints');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
  });

  // -------------------------------------------------------------------------
  // Board batch 3 — PPM signals on cards (issues #182 #184 #187 #188 #195).
  // -------------------------------------------------------------------------

  test('blocked dependency icon renders on Build card (issue #182)', async ({ page }) => {
    await expect(page.getByLabel(/Blocked by 2 dependencies\. Press D to view\./)).toBeVisible();
  });

  test('risk linkage icon renders with severity-aware aria-label (issue #188)', async ({
    page,
  }) => {
    await expect(page.getByLabel(/1 linked risk, severity red\. Click to view\./)).toBeVisible();
  });

  test('Build card shows the v2 identity meta: short id + points pill (issue 1230)', async ({
    page,
  }) => {
    // Gate on the Build card being rendered before asserting card-face chrome.
    await expect(page.getByRole('button', { name: /^Build, 60% complete/ })).toBeVisible({
      timeout: 10_000,
    });
    // The server-formatted, project-code-prefixed reference — never the raw
    // stored hex `short_id` (#2430).
    await expect(page.getByText('ENG-2026-10')).toBeVisible();
    await expect(page.getByText('0000000A')).toHaveCount(0);
    await expect(page.getByLabel('5 story points')).toBeVisible();
  });

  // ── Card noise (#2430) ────────────────────────────────────────────────────

  test('the dwell line reads in outcome language, not "Entered at N%"', async ({ page }) => {
    // "Entered at 100% · 42d ago" named neither the event nor what the percentage
    // measured. The line now leads with how long the card has sat where it is.
    await expect(page.getByText(/in this column/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Entered at/)).toHaveCount(0);
  });

  test('? opens the keyboard cheatsheet and Esc closes it (issue #195)', async ({ page }) => {
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Next card in column')).toBeVisible();
    // #2194 — the cheatsheet must not advertise the dead Space-drag / comments
    // shortcuts, and must document the real (menu-based) move path.
    await expect(dialog.getByText(/pick up card to drag/i)).toHaveCount(0);
    await expect(dialog.getByText('Show comments')).toHaveCount(0);
    await expect(dialog.getByText(/move card between columns/i)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('keyboard nav moves real DOM focus onto a card and E opens its edit modal (#2194)', async ({
    page,
  }) => {
    // Cold-enter the board keyboard model: `l` bootstraps focus to the first
    // non-empty column's first card and moves *real* DOM focus onto it — the
    // previous model only painted a ring, so screen readers announced nothing
    // and Enter/E never reached a card.
    await page.keyboard.press('l');
    const focusedCard = page.locator('[aria-roledescription="draggable"]:focus');
    await expect(focusedCard).toHaveCount(1);

    // `E` on the focused card opens it in the edit modal (was a dead binding —
    // onEditCard was never wired into useBoardKeyboard).
    await page.keyboard.press('e');
    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByText('EDIT TASK')).toBeVisible();
  });

  test('Risk-linked-only filter pill toggles aria-pressed (issue #188)', async ({ page }) => {
    const pill = page.getByRole('button', { name: 'Risk-linked only' });
    await expect(pill).toHaveAttribute('aria-pressed', 'false');
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  });

  test('clicking the chain icon opens the dependency popover with both directions (issue #182)', async ({
    page,
  }) => {
    await page.getByLabel(/Blocked by 2 dependencies\. Press D to view\./).click();
    const dialog = page.getByRole('dialog', { name: 'Dependencies' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Predecessors \(1\)/)).toBeVisible();
    await expect(dialog.getByText(/Successors \(1\)/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Board batch 5 — configurable column settings (issue #170).
  // -------------------------------------------------------------------------

  test('Columns button opens the settings panel (issue #170)', async ({ page }) => {
    await page.getByRole('button', { name: 'Board columns & WIP limits' }).click();
    const panel = page.getByRole('dialog', { name: 'Board columns' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    // Status codes appear as text labels above each row's input field
    await expect(panel.getByText('BACKLOG')).toBeVisible();
    await expect(panel.getByText('NOT_STARTED')).toBeVisible();
    await expect(panel.getByText('IN_PROGRESS')).toBeVisible();
    await expect(panel.getByText('REVIEW')).toBeVisible();
    await expect(panel.getByText('COMPLETE')).toBeVisible();
  });

  test('settings panel Escape closes it (issue #170)', async ({ page }) => {
    await page.getByRole('button', { name: 'Board columns & WIP limits' }).click();
    const panel = page.getByRole('dialog', { name: 'Board columns' });
    await expect(panel).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Board batch 6 — saved views and quick filters (issue #191).
  // -------------------------------------------------------------------------

  test('View dropdown renders with "View" label when no view is active (issue #191)', async ({
    page,
  }) => {
    const btn = page.getByRole('button', { name: /board view: view/i });
    await expect(btn).toBeVisible();
  });

  test('View dropdown opens menu with built-in quick filters (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByText('⚠ At risk')).toBeVisible();
    await expect(page.getByText('🔴 Critical path')).toBeVisible();
    await expect(page.getByText('📅 This week')).toBeVisible();
    await expect(page.getByText('👤 My work')).toBeVisible();
  });

  test('selecting "At risk" updates button label and closes menu (issue #191)', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('⚠ At risk').click();
    await expect(page.getByRole('menu')).not.toBeVisible();
    await expect(page.getByRole('button', { name: /board view: ⚠ at risk/i })).toBeVisible();
  });

  test('"Clear view" appears after activating a built-in view (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('⚠ At risk').click();
    await page.getByRole('button', { name: /board view: ⚠ at risk/i }).click();
    await expect(page.getByText('Clear view')).toBeVisible();
  });

  test('"Clear view" resets button label to "View" (issue #191)', async ({ page }) => {
    await page.getByRole('button', { name: /board view: view/i }).click();
    await page.getByText('🔴 Critical path').click();
    await page.getByRole('button', { name: /board view: 🔴 critical path/i }).click();
    await page.getByText('Clear view').click();
    await expect(page.getByRole('button', { name: /board view: view/i })).toBeVisible();
  });

  test('Sort select is functional and defaults to Priority rank (issue #191)', async ({ page }) => {
    // CalmToolbar (#382) replaced the legacy <select> with a chip popover.
    const sortChip = page.getByRole('button', { name: 'Sort tasks by' });
    await expect(sortChip).toContainText('Priority');
    await sortChip.click();
    await page.getByRole('radio', { name: 'Start date' }).click();
    await expect(sortChip).toContainText('Start date');
  });

  test('settings panel edits label and saves (issue #170)', async ({ page }) => {
    // Holder object rather than a `let`: TypeScript narrows a closure-assigned
    // `let x: T | null = null` back to `null` at any read outside the closure.
    const captures: { columns?: unknown[] } = {};
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/board-config/`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as { columns: unknown[] };
        captures.columns = body.columns;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ columns: body.columns }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: 'Board columns & WIP limits' }).click();
    const panel = page.getByRole('dialog', { name: 'Board columns' });
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Edit the Backlog label
    const backlogInput = panel.getByRole('textbox').first();
    await backlogInput.fill('Ideas');

    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(panel).not.toBeVisible({ timeout: 5_000 });

    // Verify PUT body had the updated label
    const cols = captures.columns as Array<{ status: string; label: string }> | undefined;
    expect(cols?.find((c) => c.status === 'BACKLOG')?.label).toBe('Ideas');
  });

  // -------------------------------------------------------------------------
  // Issue #190 — Swimlane collapse/expand toolbar buttons
  // -------------------------------------------------------------------------

  test('"Collapse all" hides leaf task cards (issue #190)', async ({ page }) => {
    await expect(page.getByText('Design')).toBeVisible();
    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByRole('button', { name: 'Collapse all lanes' }).click();
    await expect(page.getByText('Design')).not.toBeVisible({ timeout: 3_000 });
  });

  test('"Expand all" restores cards after collapse-all (issue #190)', async ({ page }) => {
    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByRole('button', { name: 'Collapse all lanes' }).click();
    await expect(page.getByText('Design')).not.toBeVisible({ timeout: 3_000 });
    // The More⋯ popover stays open between in-popover clicks.
    await page.getByRole('button', { name: 'Expand all lanes' }).click();
    await expect(page.getByText('Design')).toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Issue #193 — Card density toggle
  // -------------------------------------------------------------------------

  test('card density chip is visible and defaults to Comfortable (issue #193)', async ({
    page,
  }) => {
    // CalmToolbar (#382) replaced the legacy <select> with a chip popover.
    const chip = page.getByRole('button', { name: 'Card density' });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Comfortable');
  });

  test('switching to compact keeps board columns visible (issue #193)', async ({ page }) => {
    await page.getByRole('button', { name: 'Card density' }).click();
    await page.getByRole('radio', { name: 'Board card density: Compact' }).click();
    await expect(page.getByText('In Progress')).toBeVisible();
    await expect(page.getByText('Done')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #183 — Float chip (b5 QA Gate has total_float: -3)
  // -------------------------------------------------------------------------

  test('negative-float chip renders on QA Gate card (issue #183)', async ({ page }) => {
    // Detailed density surfaces the full chip set inline (#1305).
    await setDensity(page, 'Detailed');
    await expect(page.getByText('-3d float')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #186 — Baseline variance strip (b5: baseline_finish Jan 10,
  // useScheduleTasks reads finish from early_finish = Jan 20 → +10d)
  // -------------------------------------------------------------------------

  test('baseline variance chip renders on QA Gate card (issue #186)', async ({ page }) => {
    // The variance panel is `hidden group-hover:block group-focus-within:block` — only
    // revealed on hover/focus. Assert the chip is attached in the DOM.
    // finish = early_finish = 2026-01-20; baseline_finish = 2026-01-10 → +10d.
    // Pre-#314 fix this asserted +7d because the leaf-task path re-derived
    // finish as start + duration*calendar-day-ms (Jan 5 + 12d = Jan 17). That
    // re-derivation has been removed; early_finish is the authoritative
    // working-day-correct value.
    await expect(page.getByLabel(/Baseline variance: \+10d/)).toBeAttached();
  });

  // -------------------------------------------------------------------------
  // Issue #192 — Card aging (b4 and b5 have status_changed_at in 2025 — >SLA)
  // -------------------------------------------------------------------------

  test('aging chip renders on cards with old status_changed_at (issue #192)', async ({ page }) => {
    // status_changed_at = 2025-11-01, today = 2026-04-30, dwell ≈ 180d → exceeds any column SLA.
    // Detailed density surfaces the full chip set inline (#1305).
    await setDensity(page, 'Detailed');
    const agingChips = page.getByLabel(/days in this column, exceeds/);
    await expect(agingChips.first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #187 — Milestone rail (b4 Release has is_milestone: true)
  // -------------------------------------------------------------------------

  test('milestone rail renders a diamond for Release milestone (issue #187)', async ({ page }) => {
    // PhaseMilestoneRail aria-label format: "{Tone} milestone {name}, target {date}"
    await expect(page.getByLabel(/milestone Release/i)).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #105 — Entry stamps and priority rank
  // -------------------------------------------------------------------------

  test('priority rank chip renders on card with priority_rank set (issue #105)', async ({
    page,
  }) => {
    // b5 QA Gate has priority_rank: 1 → renders "#1" chip
    await expect(page.getByText('#1')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // Issue #185 — SPI chip renders when EVM mode is spi and baseline data present
  // -------------------------------------------------------------------------

  test('SPI chip renders on card when EVM mode is "spi" (issue #185)', async ({ page }) => {
    // Detailed density surfaces the full chip set inline (#1305).
    await setDensity(page, 'Detailed');
    await page.getByRole('button', { name: 'More board controls' }).click();
    await page.getByLabel('EVM indicators').selectOption('spi');
    // b5 QA Gate carries server-owned spi 0.62 / band 'behind' (#990) — the card
    // renders the chip from those fields rather than deriving it from baseline dates.
    await expect(page.getByLabel(/SPI \d+\.\d+ —/)).toBeVisible({ timeout: 3_000 });
  });

  // -------------------------------------------------------------------------
  // Issue #1305 — worst-offender badge consolidates per-card health chips
  // -------------------------------------------------------------------------

  test('worst-offender badge collapses health chips and reveals them on tap (#1305)', async ({
    page,
  }) => {
    // QA Gate (b5) carries several health signals (negative float, behind EVM,
    // long dwell). At comfortable density (default) they collapse behind one
    // worst-offender badge; the full chip set stays one tap away (non-lossy).
    const qaCard = page.getByRole('button', { name: /^QA Gate,/ });
    const badge = qaCard.getByRole('button', { name: /show health details/i });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('aria-expanded', 'false');

    // The float chip is in the collapsed peek — present in the DOM but hidden.
    await expect(page.getByText('-3d float')).toBeHidden();

    // Tapping the badge expands the peek and reveals the full chip set.
    await badge.click();
    await expect(badge).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('-3d float')).toBeVisible();
  });
});

// #1764: a failed tasks fetch previously rendered as an empty board —
// indistinguishable from a project that genuinely has no tasks. The board now
// surfaces a retry banner, matching Grid and Schedule.
test.describe('Board view — fetch error', () => {
  test('renders a retry banner (not an empty board) when the tasks fetch fails', async ({
    page,
  }) => {
    await setup(page);
    // Override the tasks GET to 500 (registered after setup so it wins).
    await page.route('**/api/v1/tasks/**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      }
      return route.fallback();
    });
    await page.goto(`${BASE_URL}/board`);

    const alert = page.getByRole('alert');
    await expect(alert).toContainText("Couldn't load the board.", { timeout: 10_000 });
    await expect(alert.getByRole('button', { name: 'Retry' })).toBeVisible();
    // Not silently rendered as an empty/ready board.
    await expect(page.getByText('Alpha Phase')).toHaveCount(0);
  });

});

// ---------------------------------------------------------------------------
// Readiness chip is comparative (#2430)
// ---------------------------------------------------------------------------

/**
 * Re-serve the board's tasks with readiness values applied to the leaf cards.
 *
 * Registered after `setup` so it wins (last-registered wins), and it *fulfills
 * directly* from `FIXTURE_TASKS` rather than `route.fetch()`-ing the mocked URL —
 * `route.fetch()` goes to the network, not to the earlier handler, so it would
 * never see the fixture payload.
 */
async function serveTasksWithReadiness(
  page: import('@playwright/test').Page,
  readinessByIndex: (i: number) => string,
): Promise<void> {
  let leafIndex = 0;
  const results = FIXTURE_TASKS.map((t) =>
    t.is_summary ? t : { ...t, readiness: readinessByIndex(leafIndex++) },
  );
  await page.route('**/api/v1/tasks/**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: results.length, next: null, previous: null, results }),
    });
  });
}

test.describe('Board card readiness chip (#2430)', () => {
  test('is suppressed when it is true of every card in view', async ({ page }) => {
    // A chip on 100% of cards conveys nothing — it is noise until it is not
    // universal, and it costs a line of the card's scarcest resource.
    await setup(page);
    await serveTasksWithReadiness(page, () => 'baselined');
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Build')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText('baselined', { exact: true })).toHaveCount(0);
  });

  test('is kept as soon as it distinguishes one card from another', async ({ page }) => {
    // Same board, one card differing: readiness now carries signal, so it renders.
    await setup(page);
    await serveTasksWithReadiness(page, (i) => (i === 0 ? 'ready' : 'baselined'));
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Build')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText('baselined', { exact: true }).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Lane header progress slot (#3148)
// ---------------------------------------------------------------------------

/**
 * A three-lane board, one lane per state of the progress slot.
 *
 * The slot renders a proportion as a bar, or the absence of one as an em-dash —
 * never both, never neither. Three lanes is the minimum that shows the em-dash
 * is a *state*, not a rendering of zero: the uncommitted lane sits beside a
 * measured one, so "no bar here" is legible as a difference rather than as a
 * lane that failed to load.
 */
const SLOT_BASE = {
  early_start: '2026-01-05',
  early_finish: '2026-01-16',
  duration: 10,
  is_critical: false,
  is_milestone: false,
  assignees: [] as string[],
  total_float: null,
  predecessor_count: 0,
  is_blocked: false,
  linked_risks_count: 0,
  linked_risks_max_severity: null,
};

const SLOT_TASKS = [
  // Lane 1 — mid-progress. Server-owned rollup on the summary (ADR-0115).
  { ...SLOT_BASE, id: 's1', wbs_path: '1', name: 'Delivery Phase', percent_complete: 55, is_summary: true, parent_id: null, status: 'IN_PROGRESS' },
  { ...SLOT_BASE, id: 's1a', wbs_path: '1.1', name: 'Delivery card', planned_start: '2026-01-05', percent_complete: 55, is_summary: false, parent_id: 's1', status: 'IN_PROGRESS' },

  // Lane 2 — complete. 100% must be distinguishable from 97% by form.
  { ...SLOT_BASE, id: 's2', wbs_path: '2', name: 'Shipped Phase', percent_complete: 100, is_summary: true, parent_id: null, status: 'COMPLETE' },
  { ...SLOT_BASE, id: 's2a', wbs_path: '2.1', name: 'Shipped card', planned_start: '2026-01-05', percent_complete: 100, is_summary: false, parent_id: 's2', status: 'COMPLETE' },

  // Lane 3 — uncommitted. Cards exist; none carries a PM-committed
  // `planned_start`, so `isTaskScheduled` counts zero committed work and there
  // is no delivery to roll up.
  { ...SLOT_BASE, id: 's3', wbs_path: '3', name: 'Ideas Phase', percent_complete: 0, is_summary: true, parent_id: null, status: 'NOT_STARTED' },
  { ...SLOT_BASE, id: 's3a', wbs_path: '3.1', name: 'Idea one', percent_complete: 0, is_summary: false, parent_id: 's3', status: 'NOT_STARTED' },
  { ...SLOT_BASE, id: 's3b', wbs_path: '3.2', name: 'Idea two', percent_complete: 0, is_summary: false, parent_id: 's3', status: 'NOT_STARTED' },
];

async function setupSlotBoard(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: SLOT_TASKS,
  });
  await page.route('**/api/v1/dependencies/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.goto(`${BASE_URL}/board`);
  await expect(page.getByText('Ideas Phase')).toBeVisible({ timeout: 10_000 });
}

/** Every lane-header slot that drew a bar. Scoped by the label's own prefix so
 *  a progressbar belonging to another surface can never be counted here. */
function laneBars(page: import('@playwright/test').Page) {
  return page.locator('[role="progressbar"][aria-label^="Phase progress:"]');
}

test.describe('Board lane header — the progress slot (#3148)', () => {
  test('mid-progress draws a bar and states the percent only in the accessible name', async ({
    page,
  }) => {
    await setupSlotBoard(page);
    // `exact: true` — `name` is a substring match, so a loose string would bind
    // to a longer label and pass on a header that never carried the number.
    await expect(
      page.getByRole('progressbar', { name: 'Phase progress: 55% complete', exact: true }),
    ).toBeVisible();
    // The numeral is gone from every lane header on the page.
    await expect(page.getByText('55%')).toHaveCount(0);
    await expect(page.getByText('100%')).toHaveCount(0);
  });

  test('the percent is reachable by keyboard focus, not hover alone', async ({ page }) => {
    await setupSlotBoard(page);
    const bar = page.getByRole('progressbar', {
      name: 'Phase progress: 55% complete',
      exact: true,
    });
    await bar.focus();
    // A coarse pointer has no hover; the tab stop is what keeps the number
    // reachable without one. No fact may live only in a tooltip.
    await expect(page.getByRole('tooltip')).toContainText('55% complete');
  });

  test('complete is told by form — a ring, not a numeral', async ({ page }) => {
    await setupSlotBoard(page);
    const done = page.getByRole('progressbar', {
      name: 'Phase progress: 100% complete',
      exact: true,
    });
    await expect(done).toBeVisible();
    await expect(done).toHaveAttribute('aria-valuenow', '100');
    // `outline`, not `ring` — the focus ring owns the `ring-*` channel, and a
    // completion mark that its own focus state erases is not a distinction.
    await expect(done).toHaveClass(/outline-1/);
    await expect(done).toHaveClass(/outline-brand-primary/);
  });

  test('an uncommitted lane renders no progressbar and names itself "not applicable"', async ({
    page,
  }) => {
    await setupSlotBoard(page);
    // Two measured lanes, three lanes on the board: the third drew nothing.
    // "Indeterminate" would have been a progressbar; "not applicable" is not.
    await expect(laneBars(page)).toHaveCount(2);
    await expect(
      page.getByRole('img', {
        name: 'Phase progress: not applicable — no committed work in this phase',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('an uncommitted lane explains the em-dash on focus', async ({ page }) => {
    await setupSlotBoard(page);
    await page
      .getByRole('img', {
        name: 'Phase progress: not applicable — no committed work in this phase',
        exact: true,
      })
      .focus();
    await expect(page.getByRole('tooltip')).toContainText('No committed work yet');
  });
});

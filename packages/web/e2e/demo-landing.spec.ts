/**
 * The read-only demo's first screen (#4050 Part A).
 *
 * What this proves that a unit test cannot: that the *landing state* is the one
 * the design asks for. Every individual gate has vitest coverage — the author
 * mode, the tray's collapsed default, the hint's step machine — but the defect
 * this issue exists for is emergent: five components each behaving correctly and
 * together leaving the Gantt a third of the viewport, over a project that reads
 * as unhealthy. So the assertions here are about what is on screen *at once*,
 * on a fresh visit, at 1280×800.
 *
 * The drag gesture is the **keyboard** reschedule (`r` → arrow → Enter), for the
 * reason `demo-read-only.spec.ts` gives: a canvas-coordinate mouse drag is not a
 * stable e2e gesture, and the hint's step-2 advance is keyed on the commit
 * phase, which both gestures reach.
 *
 * A2 (legend closed on first load) is NOT covered here. It depends on !2766
 * (#3614), which adds the toolbar Legend toggle and is unmerged; stubbing an
 * assertion against a control that does not exist would be a test that passes
 * for the wrong reason.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-demo-00000000-0000-0000-0000-000000004050';
const SIBLING_ID = 'e2e-demo-00000000-0000-0000-0000-000000004051';
const PROGRAM_ID = 'prog-4050';
const URL = `/projects/${PROJECT_ID}/schedule`;

const DEMO_HINT = { username: 'demo@trueppm.com', password: 'trueppm-demo' };

const PROGRAM_DETAIL = {
  id: PROGRAM_ID,
  name: 'Atlas Platform Launch',
  sample_days_stale: null,
};

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Migration Tooling',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    is_sample: true,
    program_detail: PROGRAM_DETAIL,
  },
];

/**
 * Three scheduled rows and one unscheduled one.
 *
 * `Performance tuning` is the row the hint must name: on the critical path and
 * behind its straight-line plan (40% done against a window that is mostly
 * elapsed). `Delta sync` is behind too but carries float, so picking it would
 * mean the hint's promise — "watch the finish date move" — is false.
 */
const TASKS = [
  {
    id: 'demo-tk1',
    wbs_path: '1',
    name: 'Dry-run migration',
    early_start: '2026-04-06',
    early_finish: '2026-04-10',
    planned_start: '2026-04-06',
    duration: 5,
    percent_complete: 100,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'COMPLETE',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'demo-tk2',
    wbs_path: '2',
    name: 'Performance tuning',
    early_start: '2020-01-01',
    early_finish: '2020-01-10',
    planned_start: '2020-01-01',
    duration: 8,
    percent_complete: 40,
    is_critical: true,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'demo-tk3',
    wbs_path: '3',
    name: 'Delta sync',
    early_start: '2020-01-01',
    early_finish: '2020-01-10',
    planned_start: '2020-01-01',
    duration: 6,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 4,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'demo-tk4',
    wbs_path: '4',
    name: 'Decommission legacy',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 4,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

/**
 * Mock the endpoints this page reads that the catch-all cannot serve with a
 * plausible shape (web CLAUDE.md: a catch-all `{count:0,…}` on an OBJECT
 * endpoint crashes the component that reads it and the root boundary replaces
 * the whole app, which then surfaces as an unrelated flake).
 */
async function setupProgramRoster(page: import('@playwright/test').Page): Promise<void> {
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      // A BARE ARRAY, not a page. `useProgramProjects` calls `res.data.map`
      // directly, so the catch-all's `{count:0,…}` shape throws inside the
      // query and the switcher silently lists nothing (web CLAUDE.md).
      body: JSON.stringify([
        { id: PROJECT_ID, name: 'Migration Tooling', start_date: '2026-04-01' },
        { id: SIBLING_ID, name: 'Platform Core', start_date: '2026-03-01' },
      ]),
    }),
  );
}

async function landing(page: import('@playwright/test').Page, demo = true): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: PROJECTS,
    projectId: PROJECT_ID,
    tasks: TASKS,
    demoReadOnly: demo,
    demoLoginHint: demo ? DEMO_HINT : null,
  });
  await setupTaskStore(page, { tasks: TASKS });
  await setupProgramRoster(page);
  await page.setViewportSize({ width: 1280, height: 800 });
}

test.describe('Demo landing — the merged bar (#4050 A1)', () => {
  test.beforeEach(async ({ page }) => {
    await landing(page);
  });

  test('is one 44px bar carrying mode, edition, project and the hint', async ({ page }) => {
    await page.goto(URL);
    const bar = page.getByRole('complementary', { name: 'Demo mode' });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Read-only demo');
    await expect(bar).toContainText('Community edition');
    await expect(bar.getByRole('link', { name: "What's included" })).toBeVisible();
    await expect(page.getByTestId('demo-project-switcher')).toBeVisible();
    await expect(page.getByRole('note', { name: 'Demo tips' })).toBeVisible();

    const box = await bar.boundingBox();
    expect(box?.height).toBeLessThanOrEqual(48);
  });

  test('the four other strips are gone, not merely shorter', async ({ page }) => {
    await page.goto(URL);
    await expect(page.getByRole('option', { name: /Performance tuning/ })).toBeVisible();
    // The sample-data strip (its content is in the bar's switcher).
    await expect(page.getByRole('note', { name: 'This is sample data' })).toHaveCount(0);
    // The docked forecast bar (relocated into the chip's popover).
    await expect(page.getByRole('region', { name: 'Schedule forecast' })).toHaveCount(0);
    // `ScheduleReconcileStrip` and `BuildModeHintStrip` must also be silent on a
    // freshly reset demo — #4050 says verify, do not assume.
    await expect(page.getByText(/dates changed/i)).toHaveCount(0);
  });

  test('keeps "What\'s included" and makes no other upsell', async ({ page }) => {
    await page.goto(URL);
    const bar = page.getByRole('complementary', { name: 'Demo mode' });
    await expect(bar.getByRole('link', { name: "What's included" })).toHaveAttribute(
      'href',
      /open-core-model/,
    );
    await expect(bar).not.toContainText(/Enterprise/);
    await expect(bar).not.toContainText(/Portfolio dashboard/);
  });

  test('the switcher lists the program’s other sample projects', async ({ page }) => {
    await page.goto(URL);
    const trigger = page.getByTestId('demo-project-switcher');
    await expect(trigger).toContainText('Migration Tooling');
    await trigger.click();
    await expect(page.getByRole('menuitem', { name: 'Platform Core' })).toBeVisible();
    // Never a route a read-only visitor cannot use (#4049): the teardown page is
    // an admin affordance, and the demo visitor is not one.
    await expect(page.getByRole('button', { name: /Manage demo data/i })).toHaveCount(0);
  });
});

test.describe('Demo landing — Read mode (#4050 A6)', () => {
  test('opens in Read even with a stored Author preference, and drag is inert', async ({
    page,
  }) => {
    await landing(page);
    // The shared-login trap: this value is the LAST visitor's choice.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'trueppm.schedule.authorMode.e2e-user-1.e2e-demo-00000000-0000-0000-0000-000000004050',
        'author',
      );
    });
    await page.goto(URL);
    await expect(page.getByRole('option', { name: /Performance tuning/ })).toBeVisible();

    // The mode chip states the mode, at every width, by design (#3263).
    await expect(page.getByTestId('schedule-mode-chip')).toContainText(/Read only/i);

    // And the mode is real, not just labelled: Read withholds the authoring
    // apparatus rather than dimming it (web rule 302, #3748). "+ Item" is
    // rendered by `hasEditRights && !readOnly`, so its absence is `readOnly`
    // having actually resolved true for a visitor who genuinely holds rights.
    await expect(page.getByRole('button', { name: /^\+ Item/ })).toHaveCount(0);
  });

  test('"Try it" enters Author with no baseline confirm, and a drag advances the hint', async ({
    page,
  }) => {
    await landing(page);
    await page.goto(URL);
    const note = page.getByRole('note', { name: 'Demo tips' });
    await expect(note).toHaveAttribute('data-step', '1');
    // The hint names the behind-plan critical row, looked up by its schedule
    // position rather than by a hard-coded string.
    await expect(note).toContainText('Performance tuning');

    await page.getByTestId('demo-tips-try').click();
    await expect(page.getByTestId('schedule-mode-chip')).toContainText(/Author/i);
    // #3748's confirm warns about amending the agreed plan. On a deployment that
    // saves nothing that sentence is false, so it must not appear — and neither
    // must the task drawer, which "Try it" must not open over the bar it is
    // sending the visitor to.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await page.getByRole('option', { name: /Performance tuning/ }).focus();
    await page.keyboard.press('r');
    await expect(page.getByTestId('preview-overlay')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('note', { name: 'Demo tips' })).toHaveAttribute('data-step', '2');
    await expect(page.getByRole('note', { name: 'Demo tips' })).toContainText('Open Forecast');
  });

  test('× dismisses the hint and Tips restores it, with no layout shift', async ({ page }) => {
    await landing(page);
    await page.goto(URL);
    const bar = page.getByRole('complementary', { name: 'Demo mode' });
    const before = await bar.boundingBox();

    await page.getByTestId('demo-tips-dismiss').click();
    await expect(page.getByRole('note', { name: 'Demo tips' })).toHaveCount(0);
    expect((await bar.boundingBox())?.height).toBe(before?.height);

    await page.getByTestId('demo-tips-restore').click();
    await expect(page.getByRole('note', { name: 'Demo tips' })).toBeVisible();
    expect((await bar.boundingBox())?.height).toBe(before?.height);
  });
});

test.describe('Demo landing — tray and framing (#4050 A3/A4)', () => {
  test('the unscheduled tray starts collapsed and does not auto-expand', async ({ page }) => {
    await landing(page);
    await page.goto(URL);
    await expect(page.getByRole('option', { name: /Performance tuning/ })).toBeVisible();
    const expand = page.getByRole('button', { name: 'Expand unscheduled tasks' });
    await expect(expand).toBeVisible();
    // The rows arrive with the first /tasks/ response; give the auto-expand
    // effect every chance to fire before asserting it did not.
    await page.waitForTimeout(1200);
    await expect(expand).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse unscheduled tasks' })).toHaveCount(0);
  });

  test('an expand inside the visit is session-only — nothing is written', async ({ page }) => {
    await landing(page);
    await page.goto(URL);
    await page.getByRole('button', { name: 'Expand unscheduled tasks' }).click();
    await expect(page.getByRole('button', { name: 'Collapse unscheduled tasks' })).toBeVisible();
    // The demo login is shared, so a stored expand would be applied to the next
    // visitor on this browser, who never asked for it.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('trueppm.gantt.unscheduledGutter.collapsed'),
    );
    expect(stored).toBeNull();
  });
});

test.describe('Demo landing — negative control: a normal install is unchanged', () => {
  test('keeps the sample strip, the docked forecast bar and Author mode', async ({ page }) => {
    await landing(page, false);
    await page.goto(URL);
    await expect(page.getByRole('option', { name: /Performance tuning/ })).toBeVisible();

    // None of the demo chrome exists.
    await expect(page.getByRole('complementary', { name: 'Demo mode' })).toHaveCount(0);
    await expect(page.getByRole('note', { name: 'Demo tips' })).toHaveCount(0);
    await expect(page.getByTestId('demo-project-switcher')).toHaveCount(0);
    await expect(page.getByTestId('demo-forecast-chip')).toHaveCount(0);

    // …and the strips #4050 removes from the demo are still here.
    await expect(page.getByRole('note', { name: 'This is sample data' })).toBeVisible();

    // Author remains the default mode on a normal install.
    await expect(page.getByTestId('schedule-mode-chip')).toContainText(/Author/i);
  });
});

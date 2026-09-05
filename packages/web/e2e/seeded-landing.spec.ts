/**
 * Seeded landing — the skeleton you can throw away (#2731, ADR-0799).
 *
 * A waterfall/hybrid template apply now lands on the Schedule with the seed
 * banner already polling its application (`?templateApplication=<id>`, consumed
 * one-shot and stripped from the URL — ADR-0799 §1), plus the Next strip's
 * derived suggestions and the untouched-seeded tick mark in the task-list
 * margin. Golden path covers the banner's counts and the delete-untouched flow;
 * the edge cases cover the application still `pending` (nothing to summarize
 * yet — the banner is not a progress bar) and the Next strip's own empty state.
 *
 * The terminal `failed` cases (#3348) sit alongside them: the apply rolls back in
 * one transaction, so the project really is empty and the blank canvas below is
 * right — but until #3348 nothing said the apply had failed at all, and
 * `error_detail` had no reader anywhere in the web. The `failed` case here used to
 * assert only the bare canvas, pinning that silence as correct.
 *
 * The pending cases are deliberately TWO, seeded with and without rows (#3312).
 * The original single case set `applicationStatus: 'pending'` but seeded the
 * fixture WITH tasks, so the empty-and-pending window — the one a user lands in
 * between the 202 and the first row arriving, and the only one where the blank
 * canvas invites a write into a project a template is mid-write on — was
 * asserted by nothing while nominally being the case that owned it.
 *
 * Every task read goes through `setupTaskStore`, not the stateless default list
 * mock — the delete-untouched assertion reads DOM state after a write, which
 * would otherwise race the store's own refetch (the class of flake #2752
 * documents for `setupApiMocks`' stateless `/tasks/` route).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';

type Page = import('@playwright/test').Page;

const PROJECT_ID = 'e2e-seed-0000-0000-0000-000000002731';
const APPLICATION_ID = 'app-0000-0000-0000-000000002731';
const SCHEDULE_URL = `/projects/${PROJECT_ID}/schedule?templateApplication=${APPLICATION_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Kickoff Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    effective_calendar: {
      id: 'cal-std',
      name: 'Standard 5-day',
      working_days: 31,
      hours_per_day: 8,
      timezone: 'UTC',
      holiday_count: 0,
    },
  },
];

function task(overrides: Record<string, unknown>) {
  return {
    id: 'seed-placeholder',
    wbs_path: '1',
    name: 'Task',
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
    source_kind: 'template',
    seeded_at: '2026-08-05T00:00:00Z',
    edited_at: null,
    is_untouched_seed: true,
    ...overrides,
  };
}

// One untouched-seeded, unowned leaf (drives both the tick mark and the
// "unowned" Next-strip chip), one untouched-seeded milestone (the "unconfirmed
// gate" chip), and one hand-authored row (never ticked, never counted).
const FIXTURE_TASKS = [
  task({ id: 'seed-1', wbs_path: '1', name: 'Design' }),
  task({ id: 'seed-2', wbs_path: '2', name: 'Ship', is_milestone: true, duration: 0 }),
  task({
    id: 'hand-1',
    wbs_path: '3',
    name: 'Kickoff call',
    source_kind: 'hand',
    seeded_at: null,
    edited_at: '2026-08-05T01:00:00Z',
    is_untouched_seed: false,
  }),
];

const APPLICATION_SUCCESS = {
  id: APPLICATION_ID,
  template: 'tpl-1',
  template_name: 'Delivery skeleton',
  template_version: 1,
  project: PROJECT_ID,
  status: 'success',
  result_summary: { tasks_created: 3, milestones_created: 1, dependencies_created: 0 },
  error_detail: '',
  created_at: '2026-08-05T00:00:00Z',
  completed_at: '2026-08-05T00:00:01Z',
  undone_at: null,
};

async function setup(
  page: Page,
  opts: {
    applicationStatus?: string;
    tasks?: typeof FIXTURE_TASKS;
    /** `null` stands for a template deleted since the apply (#3348). */
    template?: string | null;
    errorDetail?: string;
  } = {},
) {
  const status = opts.applicationStatus ?? 'success';
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
  await page.route(`**/api/v1/template-applications/${APPLICATION_ID}/`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...APPLICATION_SUCCESS,
        status,
        template: opts.template === undefined ? APPLICATION_SUCCESS.template : opts.template,
        // A real `failed` row always carries a reason (or an empty string); the
        // success fixture's '' would make the verbatim-surfacing assertion vacuous.
        error_detail:
          opts.errorDetail ??
          (status === 'failed' ? 'Template structure is no longer valid.' : ''),
      }),
    });
  });
  // `tasks: []` is the state #3312 is about — the apply has been dispatched but
  // no row has landed. It has to be reachable from this helper, because seeding
  // the fixture WITH rows is exactly how the pending case below used to miss it.
  return setupTaskStore(page, { tasks: opts.tasks ?? FIXTURE_TASKS });
}

async function gotoAndWaitForSchedule(page: Page) {
  await page.goto(SCHEDULE_URL);
  await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
}

test.describe('Seeded landing (#2731, ADR-0799)', () => {
  test('golden path: banner shows the template name, counts, tick marks, and Next strip', async ({
    page,
  }) => {
    await setup(page);
    await gotoAndWaitForSchedule(page);

    const banner = page.getByTestId('seed-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Delivery skeleton');
    await expect(page.getByTestId('seed-banner-counts')).toHaveText(
      '3 rows · 1 milestone · 0 dependencies · scheduled on Standard 5-day',
    );

    // The two untouched-seeded rows carry the tick; the hand-authored row does not.
    await expect(page.getByTestId('seeded-untouched-glyph')).toHaveCount(2);
    // #3273 — and the tick is actually painted. Both row glyphs are direct flex
    // children of a cell whose content overflows, so a missing `shrink-0` resolves
    // them to width 0 while `toHaveCount` still passes. Count guards presence;
    // only visibility guards that a reader can see it.
    await expect(page.getByTestId('seeded-untouched-glyph').first()).toBeVisible();

    // Next strip: one unowned leaf, one unconfirmed gate.
    const strip = page.getByTestId('next-strip');
    await expect(strip).toBeVisible();
    await expect(page.getByTestId('next-strip-chip-unowned')).toContainText('no owner yet');
    await expect(page.getByTestId('next-strip-chip-unconfirmedGates')).toContainText(
      "hasn't been confirmed",
    );

    // The URL is stripped after the one-shot consume — a refresh must not reopen it.
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/schedule$`));
  });

  test('Delete untouched rows requires a second click, then sweeps the project', async ({
    page,
  }) => {
    await setup(page);
    let deleteCalled = false;
    await page.route('**/api/v1/tasks/delete-untouched-seeded/', (route) => {
      deleteCalled = true;
      expect(route.request().postDataJSON()).toEqual({ project: PROJECT_ID });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: 2 }),
      });
    });
    await gotoAndWaitForSchedule(page);

    const deleteBtn = page.getByRole('button', { name: 'Delete untouched rows (2)' });
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();
    // First click only arms confirmation — no request yet.
    expect(deleteCalled).toBe(false);
    await page.getByRole('button', { name: 'Confirm delete (2)?' }).click();
    await expect.poll(() => deleteCalled).toBe(true);
  });

  test('Undo apply POSTs the undo action', async ({ page }) => {
    await setup(page);
    await page.route(`**/api/v1/template-applications/${APPLICATION_ID}/undo/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...APPLICATION_SUCCESS,
          status: 'undone',
          undo: { deleted: 3, kept: 0 },
        }),
      }),
    );
    await gotoAndWaitForSchedule(page);

    const undoRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/template-applications/${APPLICATION_ID}/undo/`) &&
        req.method() === 'POST',
    );
    await page.getByRole('button', { name: /Undo apply/ }).click();
    await undoRequest;
    // The banner dismisses itself once the undo succeeds.
    await expect(page.getByTestId('seed-banner')).toBeHidden();
  });

  test('edge case: an application still applying, with rows already landed, shows no banner', async ({
    page,
  }) => {
    await setup(page, { applicationStatus: 'pending' });
    await gotoAndWaitForSchedule(page);

    // Nothing to summarize yet — the banner is not a progress bar. The Next
    // strip is independent of the application's status (it reads the plan's
    // current shape, not the apply job), so it still renders from the fixture's
    // untouched-seeded rows.
    await expect(page.getByTestId('seed-banner')).toBeHidden();
    await expect(page.getByTestId('next-strip')).toBeVisible();
    // Rows are on screen, so there is no wait left to narrate.
    await expect(page.getByTestId('schedule-seeding-state')).toBeHidden();
  });

  // #3312. This is the state the pending case above did NOT cover: it set
  // `applicationStatus: 'pending'` but seeded the fixture WITH rows, so the
  // empty-and-pending window — the one a user actually lands in — was asserted
  // by nothing. Seeded with zero tasks, it reaches the state for real.
  test('empty and still applying: a seeding state, not an invitation to type', async ({ page }) => {
    await setup(page, { applicationStatus: 'pending', tasks: [] });
    await page.goto(SCHEDULE_URL);

    const seeding = page.getByTestId('schedule-seeding-state');
    await expect(seeding).toBeVisible({ timeout: 10_000 });
    // Announced, not merely painted — a wait a screen reader cannot hear is the
    // same silence for that user.
    await expect(
      page.getByRole('status', { name: 'Setting up your schedule', exact: true }),
    ).toBeVisible();
    await expect(seeding).toContainText('Setting up your schedule');
    await expect(seeding).toContainText('Writing rows from your template');

    // The regression itself: the blank-project draft row invited a first item
    // into a project the template is mid-write on, and the mobile card said
    // "No items yet", which reads as "the apply failed".
    await expect(page.getByPlaceholder('Type your first item, then press Enter')).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'First item name' })).toBeHidden();
    // The blank canvas is replaced outright, aside included — its "ways to fill
    // this project" panel is addressed to a user who is not the one filling it.
    // ("No items yet" is the MOBILE copy; this project runs Desktop Chrome only,
    // so that arm is pinned in `MobileSchedule.test.tsx` instead.)
    await expect(page.getByRole('button', { name: 'Import a file' })).toBeHidden();
    await expect(page.getByLabel('Ways to fill this project')).toBeHidden();

    // Still no banner: the application has nothing to summarize yet.
    await expect(page.getByTestId('seed-banner')).toBeHidden();
  });

  // #3348. This case USED to assert only the bare blank canvas, pinning the
  // silence as correct. It still doubles as the seeding state's negative control —
  // a `failed` apply is genuinely not seeding, and the blank canvas below it is
  // genuinely right, because the apply rolled back in one transaction and left the
  // project completely empty. What was missing was anything SAYING so.
  test('empty and failed: the failure is stated ABOVE an untouched blank canvas', async ({
    page,
  }) => {
    await setup(page, { applicationStatus: 'failed', tasks: [] });
    await page.goto(SCHEDULE_URL);

    const banner = page.getByTestId('seed-failure-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Delivery skeleton');
    // The reassurance clause — the fact that was unsaid before this issue.
    await expect(banner).toContainText('Nothing was written');
    // `error_detail` reaches the user verbatim. It had no reader anywhere in the
    // web until now, despite shipping on the serializer from the start.
    await expect(page.getByTestId('seed-failure-banner-reason')).toHaveText(
      'Reason: Template structure is no longer valid.',
    );
    // The recovery path names the canvas below as a CHOICE, not a leftover.
    await expect(page.getByTestId('seed-failure-banner-recovery')).toHaveText(
      'Try again, or just start building this project below.',
    );

    // The canvas underneath is deliberately UNCHANGED — "continue with an empty
    // project" is that surface, not something the banner needs to offer. This is
    // still the seeding state's negative control.
    await expect(page.getByRole('textbox', { name: 'First item name' })).toBeVisible();
    await expect(page.getByLabel('Ways to fill this project')).toBeVisible();
    await expect(page.getByTestId('schedule-seeding-state')).toBeHidden();
    // A failed apply wrote nothing, so there is nothing to undo or sweep — the
    // success banner and its disposal controls must stay away.
    await expect(page.getByTestId('seed-banner')).toBeHidden();
  });

  test('retrying a failed apply hands the schedule back to the seeding state', async ({
    page,
  }) => {
    // The retry mints a NEW application id, and `ScheduleView` must swap to it
    // *and* release the one-shot latches it keeps for the first apply. If it does
    // not, the retry appears to work and then quietly lands back on the empty
    // canvas — which is why this asserts the skeleton, not just the POST.
    await setup(page, { applicationStatus: 'failed', tasks: [] });
    const RETRY_ID = 'app-retry-0000-0000-000000003348';
    await page.route(`**/api/v1/template-applications/${RETRY_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...APPLICATION_SUCCESS, id: RETRY_ID, status: 'pending' }),
      }),
    );
    await page.route('**/api/v1/project-templates/tpl-1/apply/', (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ queued: true, application: RETRY_ID }),
      }),
    );
    await page.goto(SCHEDULE_URL);

    await expect(page.getByTestId('seed-failure-banner')).toBeVisible({ timeout: 10_000 });
    const applyRequest = page.waitForRequest(
      (req) => req.url().includes('/project-templates/tpl-1/apply/') && req.method() === 'POST',
    );
    await page.getByTestId('seed-failure-banner-retry').click();
    const req = await applyRequest;
    expect(req.postDataJSON()).toEqual({ project: PROJECT_ID });

    // The failure notice gives way to the wait it started.
    await expect(page.getByTestId('schedule-seeding-state')).toBeVisible();
    await expect(page.getByTestId('seed-failure-banner')).toBeHidden();
  });

  test('a failed apply whose template was deleted offers no retry', async ({ page }) => {
    // `template: null` is the one case where retry is structurally impossible, so
    // the control is OMITTED rather than disabled and the sentence explains why.
    await setup(page, { applicationStatus: 'failed', tasks: [], template: null });
    await page.goto(SCHEDULE_URL);

    await expect(page.getByTestId('seed-failure-banner')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('seed-failure-banner-retry')).toBeHidden();
    await expect(page.getByTestId('seed-failure-banner-recovery')).toHaveText(
      "This template no longer exists, so it can't be applied again. Start building this project below.",
    );
  });

  test('edge case: a fully hand-authored plan shows no Next strip', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    await page.route(`**/api/v1/template-applications/${APPLICATION_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(APPLICATION_SUCCESS),
      }),
    );
    // Every row already touched — nothing left for the strip to suggest.
    await setupTaskStore(page, {
      tasks: [
        task({
          id: 'hand-1',
          wbs_path: '1',
          name: 'Kickoff call',
          source_kind: 'hand',
          seeded_at: null,
          edited_at: '2026-08-05T01:00:00Z',
          is_untouched_seed: false,
        }),
      ],
    });
    await gotoAndWaitForSchedule(page);

    // The banner still shows (the application itself succeeded) — only the
    // strip, which is scoped to untouched-seeded rows, is empty.
    await expect(page.getByTestId('seed-banner')).toBeVisible();
    await expect(page.getByTestId('next-strip')).toBeHidden();
  });
});

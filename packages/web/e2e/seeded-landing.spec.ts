/**
 * Seeded landing — the skeleton you can throw away (#2731, ADR-0799).
 *
 * A waterfall/hybrid template apply now lands on the Schedule with the seed
 * banner already polling its application (`?templateApplication=<id>`, consumed
 * one-shot and stripped from the URL — ADR-0799 §1), plus the Next strip's
 * derived suggestions and the untouched-seeded tick mark in the task-list
 * margin. Golden path covers the banner's counts and the delete-untouched flow;
 * the edge case covers the application still `pending` (nothing to summarize
 * yet — the banner is not a progress bar) and the Next strip's own empty state.
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

async function setup(page: Page, opts: { applicationStatus?: string } = {}) {
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
        status: opts.applicationStatus ?? 'success',
      }),
    });
  });
  return setupTaskStore(page, { tasks: FIXTURE_TASKS });
}

async function gotoAndWaitForSchedule(page: Page) {
  await page.goto(SCHEDULE_URL);
  await expect(page.getByRole('treegrid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
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

  test('edge case: an application still applying shows no banner', async ({ page }) => {
    await setup(page, { applicationStatus: 'pending' });
    await gotoAndWaitForSchedule(page);

    // Nothing to summarize yet — the banner is not a progress bar. The Next
    // strip is independent of the application's status (it reads the plan's
    // current shape, not the apply job), so it still renders from the fixture's
    // untouched-seeded rows.
    await expect(page.getByTestId('seed-banner')).toBeHidden();
    await expect(page.getByTestId('next-strip')).toBeVisible();
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

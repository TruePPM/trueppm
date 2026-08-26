/**
 * The Designer's authoring gate is the server's `can_author` (#3034, ADR-0773 §(d)).
 *
 * The ADR designated `ProjectSerializer.can_author` "the web gate" and the client
 * never read it: `ScheduleView` derived `hasEditRights` from
 * `canEditTask(currentRole)` — a plain `role >= ROLE_MEMBER` ordinal test. The
 * Scheduler band (200) satisfies that and the server refuses it, so a Scheduler was
 * handed the whole authoring apparatus and then refused two different ways:
 * paste-many and the classification cascade 403 outright, while a single row
 * COMMITS and every subsequent keystroke 403s.
 *
 * This spec pins the user-visible half — that the apparatus is ABSENT for a
 * non-author (#2949's "absent, not disabled" rule), and present for an author.
 * It is deliberately driven by `can_author` on the project fixture and NOT by the
 * membership role: a spec that drove the role would keep passing if someone
 * re-derived the gate from the ordinal, which is the exact regression to catch.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, useFullToolbar } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-authgate-0000-0000-0000-000000003034';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

function project(canAuthor: boolean) {
  return [
    {
      id: FIXTURE_PROJECT_ID,
      name: 'Author Gate Project',
      description: '',
      start_date: '2026-04-01',
      calendar: 'default',
      can_author: canAuthor,
    },
  ];
}

const FIXTURE_TASKS = [
  {
    id: 'ag1',
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
];

test.describe('Schedule authoring gate — can_author (#3034)', () => {
  // Both tests below reason about the mode pills, and since #3076 the fit
  // ladder collapses those into a single chip at Playwright's 1280 default.
  // That matters in BOTH directions: the allowed reader stops finding the pill
  // it asserts is visible, and — worse — the refused reader's
  // `toHaveCount(0)` starts passing because the pill was rationed rather than
  // withheld, which is the one thing this spec exists to tell apart.
  test.beforeEach(async ({ page }) => {
    await useFullToolbar(page);
  });

  test('a reader the server refuses gets the View only badge, not the apparatus', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: project(false),
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });

    await page.goto(BASE_URL);

    // Gate on a "the page rendered" signal before asserting on absence: an
    // absence assertion passes trivially against a page that has not painted.
    await expect(page.getByTestId('schedule-view-only')).toBeVisible();

    // Nothing that would let this reader start authoring.
    await expect(page.getByTestId('author-mode-pill')).toHaveCount(0);
    await expect(page.getByTestId('build-mode-pill')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ Milestone' })).toHaveCount(0);

    // …but the schedule itself still reads. This hides authoring, not data.
    await expect(page.getByText('Foundation').first()).toBeVisible();
  });

  test('a reader the server allows keeps the full authoring apparatus', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: project(true),
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });

    await page.goto(BASE_URL);

    await expect(page.getByTestId('author-mode-pill')).toBeVisible();
    await expect(page.getByTestId('schedule-view-only')).toHaveCount(0);
  });
});

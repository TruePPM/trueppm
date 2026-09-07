/**
 * A methodology-hidden view reached by direct URL, on a project that already has
 * work on it (#2619, finding A of the 2026-08-31 audit).
 *
 * `methodology-hidden-sprints-view.spec.ts` covers the sibling half: the
 * *explanatory empty state* a visitor lands on when the hidden surface is empty.
 * That half shipped on all six surfaces — and every one of its call sites fires
 * only under `length === 0`. So the state it was written to prevent had no
 * signal on either path: an AGILE flip on a project with a real CPM schedule, or
 * a WATERFALL flip on a groomed backlog, rendered the ordinary populated view
 * with nothing indicating the surface now sits outside the project's workflow.
 * That is the worse of the two, because there is committed work in it.
 *
 * Only the browser settles this: the assertion is that the banner and the real
 * content render *together*, which is a claim about two branches of a component
 * tree that a unit test can stub apart.
 *
 * No `setupTaskStore`: nothing here writes, so the stateless list mock cannot
 * erase a committed value out from under a poll (#2752).
 */
import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const AGILE_ID = 'e2e-mm-agile-0000-0000-0000-000000002619';
const WATERFALL_ID = 'e2e-mm-water-0000-0000-0000-000000002619';

function project(id: string, methodology: 'WATERFALL' | 'AGILE') {
  return {
    id,
    name: 'Mismatch Fixture',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    methodology,
    effective_methodology: methodology,
    inherited_methodology: methodology,
  };
}

/** Two scheduled rows — enough that the surface is genuinely populated. */
const TASKS = [
  {
    id: 'mm-1',
    wbs_path: '1',
    name: 'Foundation pour',
    early_start: '2026-04-05',
    early_finish: '2026-04-16',
    planned_start: '2026-04-05',
    duration: 10,
    percent_complete: 0,
    is_critical: true,
    is_summary: false,
    is_milestone: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 0,
    free_float: 0,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
  {
    id: 'mm-2',
    wbs_path: '2',
    name: 'Cladding order',
    early_start: '2026-04-20',
    early_finish: '2026-04-24',
    planned_start: '2026-04-20',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_summary: false,
    is_milestone: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: 8,
    free_float: 2,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

function apiStory(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'T',
    wbs_path: null,
    name: 'Story',
    early_start: null,
    early_finish: null,
    planned_start: null,
    duration: 1,
    percent_complete: 0,
    is_critical: false,
    status: 'BACKLOG',
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    server_version: 1,
    ...over,
  };
}

/**
 * Three stories, so the banner's count and its plural agreement are both under
 * test — the count is the weight of what a flip just orphaned, and getting it
 * from the *unfiltered* total is the whole point (web rule 388).
 */
function groomedBacklogPayload() {
  return {
    epics: [
      {
        epic: apiStory({ id: 'EP1', name: 'Onboarding', short_id: 'EP-1', type: 'epic' }),
        stories: [
          apiStory({
            id: 'S1',
            name: 'Invite a teammate',
            short_id: 'ST-1',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'ready',
            story_points: 3,
          }),
          apiStory({
            id: 'S2',
            name: 'First-run checklist',
            short_id: 'ST-2',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'refine',
            story_points: 5,
          }),
        ],
        rollup: { story_count: 2, points_total: 8, points_done: 0 },
      },
    ],
    ungrouped: [
      apiStory({ id: 'S3', name: 'Loose investigation', short_id: 'ST-3', type: 'story' }),
    ],
    health: {
      dor_pct: 33,
      ready_count: 1,
      ready_points: 3,
      capacity_points: null,
      unestimated: 1,
      ac_met: 0,
      ac_total: 0,
      story_count: 3,
    },
    scoring: { model: 'none' },
  };
}

const banner = (page: Page) => page.getByRole('status').filter({ hasText: /configured as/ });
const reviewButton = (page: Page) => page.getByRole('button', { name: 'Review methodology' });

async function setupProject(page: Page, id: string, methodology: 'WATERFALL' | 'AGILE') {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [project(id, methodology)],
    projectId: id,
    tasks: TASKS,
  });
  // `product-backlog/` is an OBJECT endpoint — the catch-all's list shape
  // (`{count:0,…}`) would reach the page as truthy-but-malformed and throw at
  // the root error boundary, which surfaces later as an unrelated flake. Mock it
  // with its real shape on every project in this spec, including the AGILE one
  // whose tests never open it.
  await page.route(`**/api/v1/projects/${id}/product-backlog/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(groomedBacklogPayload()),
    }),
  );
}

test.describe('AGILE project, populated Schedule reached by URL (#2619)', () => {
  test.beforeEach(({ page }) => setupProject(page, AGILE_ID, 'AGILE'));

  test('states the mismatch while still rendering the schedule', async ({ page }) => {
    await page.goto(`/projects/${AGILE_ID}/schedule`);

    // Gate on the outline, not on the banner: every assertion below is about
    // what renders ALONGSIDE resolved task data.
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({
      timeout: 10_000,
    });

    await expect(
      page.getByText(/This project is configured as Agile, but it already has a schedule/),
    ).toBeVisible();
    await expect(reviewButton(page)).toBeVisible();

    // The route is never blocked — that is the policy this issue does NOT change
    // (`methodologyTabs.ts`: "this is not how we work here", not "this is not
    // allowed"). The work must still be there.
    await expect(page.getByText('Foundation pour')).toBeVisible();

    // Disjointness: the banner and the empty state are mutually exclusive.
    await expect(page.getByText("Schedule isn't part of this project's workflow")).toHaveCount(0);
  });

  test('states the mismatch on the Calendar too', async ({ page }) => {
    await page.goto(`/projects/${AGILE_ID}/calendar`);

    await expect(
      page.getByText(/This project is configured as Agile, but it already has a schedule/),
    ).toBeVisible({ timeout: 10_000 });
    await expect(reviewButton(page)).toBeVisible();
    await expect(page.getByText("Calendar isn't part of this project's workflow")).toHaveCount(0);
  });

  test('is a polite status, and offers no way to dismiss it', async ({ page }) => {
    await page.goto(`/projects/${AGILE_ID}/schedule`);
    await expect(banner(page)).toBeVisible({ timeout: 10_000 });

    // A standing configuration truth must not interrupt, and must not be
    // clearable — a dismissed banner restores the silence this issue is about.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(banner(page).getByRole('button')).toHaveCount(1);
  });

  test('"Review methodology" routes to Settings → How this team works', async ({ page }) => {
    await page.goto(`/projects/${AGILE_ID}/schedule`);
    await expect(banner(page)).toBeVisible({ timeout: 10_000 });

    // Asserting only that the button EXISTS is what let the retired
    // `#methodology` anchor survive a repoint on the sprints banner — assert the
    // destination (the sibling spec records the same trap).
    await reviewButton(page).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${AGILE_ID}/settings#how-this-team-works$`));
  });
});

test.describe('WATERFALL project, groomed Backlog reached by URL (#2619)', () => {
  test.beforeEach(({ page }) => setupProject(page, WATERFALL_ID, 'WATERFALL'));

  test('counts the orphaned stories while still rendering them', async ({ page }) => {
    await page.goto(`/projects/${WATERFALL_ID}/product-backlog`);

    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    // Three stories: two under the epic plus one ungrouped. The count comes from
    // the unfiltered total, and the plural agrees with it.
    await expect(
      page.getByText(
        /This project is configured as Waterfall, but 3 stories already are groomed here/,
      ),
    ).toBeVisible();
    await expect(reviewButton(page)).toBeVisible();

    // The stories themselves still render — reachability is the policy. Scoped
    // by role: the name also appears in the sprint-planning rail, so a bare
    // `getByText` is a strict-mode violation rather than a stronger assertion.
    await expect(page.getByRole('button', { name: 'Open story Invite a teammate' })).toBeVisible();

    // Disjointness with the empty state.
    await expect(page.getByText("Backlog isn't part of this project's workflow")).toHaveCount(0);
  });

  test('"Review methodology" routes to Settings → How this team works', async ({ page }) => {
    await page.goto(`/projects/${WATERFALL_ID}/product-backlog`);
    await expect(banner(page)).toBeVisible({ timeout: 10_000 });

    await reviewButton(page).click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${WATERFALL_ID}/settings#how-this-team-works$`),
    );
  });
});

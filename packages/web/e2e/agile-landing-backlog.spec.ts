/**
 * E2E for the agile landing (#2734, ADR-0800) — after an AGILE template applies
 * from the Start sheet (#2728/#2729), the project lands directly on its product
 * backlog instead of an empty Overview or a "No stories yet" welcome card.
 *
 * The `?templateApplication=` cases (#3422) sit alongside the golden path. The
 * backlog used to read a `?seeding=1` flag fixed at navigation time, so it could
 * not tell "still writing" from "failed" and pulsed the same skeleton for both
 * until a 10s timer ran out — the exact silence #3348 removed from the Schedule.
 * It now polls the application, and the failed case reuses #3348's banner. The
 * empty-and-pending and empty-and-failed cases mirror `seeded-landing.spec.ts`.
 *
 * The `⌘⇧M` hybrid-declaration entry point named in the issue
 * is deliberately **not** covered here — it does not exist on this surface yet.
 * The popover it would open shipped in #2736, but nothing wires it into this
 * toolbar (see ADR-0800 §Decision 6, tracked in #3035, and the `TODO(#3035)`
 * left in `ProductBacklogPage`'s toolbar). An E2E assertion for a shortcut
 * that opens nothing would just be asserting a no-op.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const NEW_PID = 'e2e-2734-0000-0000-0000-000000000042';
const APPLICATION_ID = 'app-2734-0001';
const BACKLOG_SEED_URL = `/projects/${NEW_PID}/product-backlog?templateApplication=${APPLICATION_ID}`;

const pj = (b: unknown) => JSON.stringify(b);
const page200 = { count: 0, next: null, previous: null, results: [] };

const AGILE_TEMPLATE = {
  id: 'tpl-2734-0000-0000-0000-000000000001',
  name: 'Agile delivery skeleton',
  description: 'Epics, stories, and a starter backlog',
  source_kind: 'workspace',
  provenance: 'Workspace',
  carries: ['structure'],
  methodology: 'AGILE',
  task_count: 6,
  version: 1,
  program: null,
  published_at: '2026-08-01T00:00:00Z',
};

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

function seededBacklogPayload() {
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
    ungrouped: [],
    health: {
      dor_pct: 50,
      ready_count: 1,
      ready_points: 3,
      capacity_points: null,
      unestimated: 0,
      ac_met: 0,
      ac_total: 0,
      story_count: 2,
    },
    scoring: { model: 'none' },
  };
}

function emptyBacklogPayload() {
  return {
    epics: [],
    ungrouped: [],
    health: {
      dor_pct: 0,
      ready_count: 0,
      ready_points: 0,
      capacity_points: null,
      unestimated: 0,
      ac_met: 0,
      ac_total: 0,
      story_count: 0,
    },
    scoring: { model: 'none' },
  };
}

const APPLICATION_SUCCESS = {
  id: APPLICATION_ID,
  template: AGILE_TEMPLATE.id,
  template_name: AGILE_TEMPLATE.name,
  template_version: 1,
  project: NEW_PID,
  status: 'success',
  result_summary: { tasks_created: 3, milestones_created: 0, dependencies_created: 0 },
  error_detail: '',
  created_at: '2026-08-05T00:00:00Z',
  completed_at: '2026-08-05T00:00:01Z',
  undone_at: null,
};

/**
 * The polled application the backlog now reads (#3422). Mocked with its real
 * object shape on purpose — the list-shaped catch-all would make `status`
 * undefined and silently turn every case below into "not seeding".
 */
async function mockApplication(
  page: import('@playwright/test').Page,
  opts: { status?: string; template?: string | null; errorDetail?: string } = {},
) {
  const status = opts.status ?? 'success';
  await page.route(`**/api/v1/template-applications/${APPLICATION_ID}/`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        ...APPLICATION_SUCCESS,
        status,
        template: opts.template === undefined ? APPLICATION_SUCCESS.template : opts.template,
        // A real `failed` row always carries a reason (or an empty string); the
        // success fixture's '' would make the verbatim-surfacing assertion vacuous.
        error_detail:
          opts.errorDetail ?? (status === 'failed' ? 'Template structure is no longer valid.' : ''),
      }),
    });
  });
}

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  // Registers GET /projects/{NEW_PID}/ + the other project-scoped defaults
  // (overview, sprint-forecast, …) against a project that doesn't exist until
  // the Start sheet creates it — safe because Playwright routes are matched by
  // URL pattern, not resource existence, and the create POST below returns this
  // exact id.
  await setupApiMocks(page, {
    projects: [
      {
        id: NEW_PID,
        name: 'Team Launch',
        start_date: '2026-08-05',
        effective_methodology: 'AGILE',
      },
    ],
    projectId: NEW_PID,
  });

  // Registered after setupApiMocks so these win (Playwright matches last-registered
  // first). The project does not exist until the Start sheet's POST — the GET
  // branch must stay genuinely empty so My Work renders its true zero-projects
  // state ("Create your first project"), not the "You're all caught up" state a
  // pre-seeded project list would produce.
  await page.route('**/api/v1/projects/', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: pj({ id: NEW_PID, name: 'Team Launch', server_version: 1 }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) });
  });
  await page.route(`**/api/v1/projects/${NEW_PID}/product-backlog/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj(seededBacklogPayload()),
    }),
  );
  await mockApplication(page);
  await page.route('**/api/v1/project-templates/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 1, next: null, previous: null, results: [AGILE_TEMPLATE] }),
    }),
  );
  await page.route(`**/api/v1/project-templates/${AGILE_TEMPLATE.id}/apply/`, (route) =>
    route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: pj({ queued: true, application: APPLICATION_ID }),
    }),
  );
  // My Work empty state — the entry point, chosen over the program overview
  // deliberately (object-shaped /rollup/ endpoints crash under the list-shaped
  // catch-all, #1190).
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
      }),
    }),
  );
  await page.route('**/api/v1/me/notifications/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: pj(page200) }),
  );

  await page.goto('/me/work');
}

/** Open the one-screen Start sheet and fill the required Name field (#2728). */
async function openStartSheet(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { name: /get you started/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Create your first project' }).click();
  const dialog = page.getByRole('dialog', { name: /new project/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: /name/i }).fill('Team Launch');
  return dialog;
}

test.describe('Agile landing — the backlog stands itself up (#2734)', () => {
  test('applying an AGILE template lands directly on the populated backlog', async ({ page }) => {
    await setup(page);
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();
    await dialog.getByRole('radio', { name: /Agile delivery skeleton/i }).click();
    await dialog.getByRole('button', { name: /create project/i }).click();

    // Lands on the backlog, not Overview or a bare welcome card.
    await expect(page).toHaveURL(new RegExp(`/projects/${NEW_PID}/product-backlog`));
    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });
    // The application id rode in on `?templateApplication=` (#3422) and was
    // consumed one-shot — a refresh must not reopen a state for an apply that
    // already finished.
    await expect(page).toHaveURL(new RegExp(`/projects/${NEW_PID}/product-backlog$`));
    await expect(page.getByTestId('seed-failure-banner')).toBeHidden();

    // Epics, stories, and points are standing — not a "No stories yet" CTA. Both
    // stories carry no `sprint` in the fixture, so each also appears a second time
    // in the not-in-a-sprint strip (#2734) — `.first()` targets the epic-grouped
    // row, the strip's own rendering is asserted separately below.
    await expect(page.getByText('Onboarding')).toBeVisible();
    await expect(page.getByText('Invite a teammate').first()).toBeVisible();
    await expect(page.getByText('First-run checklist').first()).toBeVisible();
    await expect(page.getByText('No stories yet')).not.toBeVisible();

    // The not-in-a-sprint strip (#2734, ADR-0800) — both fixture stories carry no
    // sprint, so it reports 2.
    const strip = page.getByRole('region', { name: 'Not sprint-assigned' });
    await expect(strip).toBeVisible();
    await expect(strip.getByText('(2)')).toBeVisible();

    // Waterfall creation vocabulary from the Start sheet does not leak onto the
    // landing itself.
    await expect(page.getByText('Planning model')).not.toBeVisible();
  });

  // #3422. The state a user lands in between the 202 and the first row arriving.
  // Until now this was gated on a URL flag and a 10s timer; it now reads the
  // application's real status, so it is bounded by the status, not the clock.
  test('empty and still applying: a seeding state, not an invitation to add a story', async ({
    page,
  }) => {
    await setup(page);
    await page.route(`**/api/v1/projects/${NEW_PID}/product-backlog/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(emptyBacklogPayload()),
      }),
    );
    await mockApplication(page, { status: 'pending' });
    await page.goto(BACKLOG_SEED_URL);

    await expect(
      page.getByRole('status', { name: 'Setting up your backlog', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('No stories yet')).toBeHidden();
    await expect(page.getByTestId('seed-failure-banner')).toBeHidden();
    // One-shot consume, same as the Schedule (rule 374(b)).
    await expect(page).toHaveURL(new RegExp(`/projects/${NEW_PID}/product-backlog$`));
  });

  // #3422. The regression itself: a `failed` apply pulsed the skeleton for 10s and
  // then fell through to "No stories yet" with nothing said. The empty state below
  // is still right — the apply rolled back in one transaction — but the failure is
  // now STATED above it, with the server's reason verbatim.
  test('empty and failed: the failure is stated ABOVE an untouched empty backlog', async ({
    page,
  }) => {
    await setup(page);
    await page.route(`**/api/v1/projects/${NEW_PID}/product-backlog/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(emptyBacklogPayload()),
      }),
    );
    await mockApplication(page, { status: 'failed' });
    await page.goto(BACKLOG_SEED_URL);

    const banner = page.getByTestId('seed-failure-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Agile delivery skeleton');
    // The reassurance clause — a failed apply is a total rollback.
    await expect(banner).toContainText('Nothing was written');
    await expect(page.getByTestId('seed-failure-banner-reason')).toHaveText(
      'Reason: Template structure is no longer valid.',
    );
    // `setupAuth` serves the caller as Admin, so retry is on offer.
    await expect(page.getByTestId('seed-failure-banner-recovery')).toHaveText(
      'Try again, or just start building this project below.',
    );

    // The empty state beneath is deliberately UNCHANGED — "continue with an empty
    // project" is that surface, not something the banner needs to offer — and the
    // skeleton is gone at once, not after a timer.
    await expect(page.getByText('No stories yet')).toBeVisible();
    await expect(
      page.getByRole('status', { name: 'Setting up your backlog', exact: true }),
    ).toBeHidden();
  });

  test('retrying a failed apply hands the backlog back to the seeding state', async ({ page }) => {
    // The retry mints a NEW application id, and the page must swap to it AND
    // release the latches it kept for the first apply — otherwise the retry looks
    // like it worked and quietly lands back on the empty CTA.
    await setup(page);
    await page.route(`**/api/v1/projects/${NEW_PID}/product-backlog/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj(emptyBacklogPayload()),
      }),
    );
    await mockApplication(page, { status: 'failed' });
    const RETRY_ID = 'app-retry-0000-0000-000000003422';
    await page.route(`**/api/v1/template-applications/${RETRY_ID}/`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({ ...APPLICATION_SUCCESS, id: RETRY_ID, status: 'pending' }),
      }),
    );
    await page.route(`**/api/v1/project-templates/${AGILE_TEMPLATE.id}/apply/`, (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: pj({ queued: true, application: RETRY_ID }),
      }),
    );
    await page.goto(BACKLOG_SEED_URL);

    await expect(page.getByTestId('seed-failure-banner')).toBeVisible({ timeout: 10_000 });
    const applyRequest = page.waitForRequest(
      (req) =>
        req.url().includes(`/project-templates/${AGILE_TEMPLATE.id}/apply/`) &&
        req.method() === 'POST',
    );
    await page.getByTestId('seed-failure-banner-retry').click();
    const req = await applyRequest;
    expect(req.postDataJSON()).toEqual({ project: NEW_PID });

    await expect(
      page.getByRole('status', { name: 'Setting up your backlog', exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('seed-failure-banner')).toBeHidden();
  });

  test('a WATERFALL template application still lands on Overview (unchanged, #2731 territory)', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/project-templates/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: pj({
          count: 1,
          next: null,
          previous: null,
          results: [
            {
              ...AGILE_TEMPLATE,
              id: 'tpl-wf',
              name: 'Waterfall skeleton',
              methodology: 'WATERFALL',
            },
          ],
        }),
      }),
    );
    const dialog = await openStartSheet(page);
    await dialog.getByRole('radio', { name: /^template/i }).click();
    await dialog.getByRole('radio', { name: /Waterfall skeleton/i }).click();
    await dialog.getByRole('button', { name: /create project/i }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${NEW_PID}/overview`));
  });
});

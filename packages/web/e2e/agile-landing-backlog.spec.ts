/**
 * E2E for the agile landing (#2734, ADR-0800) — after an AGILE template applies
 * from the Start sheet (#2728/#2729), the project lands directly on its product
 * backlog instead of an empty Overview or a "No stories yet" welcome card.
 *
 * Golden path only. The `⌘⇧M` hybrid-declaration entry point named in the issue
 * is deliberately **not** covered here — it does not exist on this surface yet.
 * The popover it would open shipped in #2736, but nothing wires it into this
 * toolbar (see ADR-0800 §Decision 6, tracked in #3035, and the `TODO(#3035)`
 * left in `ProductBacklogPage`'s toolbar). An E2E assertion for a shortcut
 * that opens nothing would just be asserting a no-op.
 */
import { test, expect } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const NEW_PID = 'e2e-2734-0000-0000-0000-000000000042';

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
      body: pj({ queued: true, application: 'app-2734-0001' }),
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
          results: [{ ...AGILE_TEMPLATE, id: 'tpl-wf', name: 'Waterfall skeleton', methodology: 'WATERFALL' }],
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

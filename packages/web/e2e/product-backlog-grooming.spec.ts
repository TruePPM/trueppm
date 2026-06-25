/**
 * E2E for the Product Backlog grooming view (#494/#921/#922, ADR-0105 + ADR-0110).
 *
 * dnd-kit drag is notoriously brittle in Playwright (pointer events vs. sortable
 * canvas), so — like board-backlog-band.spec.ts — this spec asserts the structural
 * surface and the keyboard-driven flows the drag depends on:
 *   - epics + nested stories render, with the score column for the active model (#922)
 *   - the quick-add input commits a title-only story on Enter (#921)
 *   - the empty state renders with the quick-add affordance still available
 *
 * The reorder write path + 409 handling are covered by the api/hook vitest and the
 * backend pytest; the drag gesture itself is exercised by the SortableGroup unit logic.
 */
import { expect, test } from '@playwright/test';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-groom-00000000-0000-0000-0000-000000000494';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Grooming Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
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

function groomingPayload(empty = false) {
  if (empty) {
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
  return {
    epics: [
      {
        epic: apiStory({ id: 'EP1', name: 'Telemetry', short_id: 'EP-1', type: 'epic' }),
        stories: [
          apiStory({
            id: 'S1',
            name: 'Failover handling',
            short_id: 'ST-1',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'ready',
            story_points: 5,
            criteria_met_count: 4,
            criteria_total: 6,
            prioritization_score: 3.5,
            // Committed to a sprint → "Pulled" chip; assigned → initials avatar.
            sprint: 'SP1',
            assignments: [{ resource_id: 'R1', resource_name: 'Lena Bauer', units: 1 }],
          }),
          apiStory({
            id: 'S2',
            name: 'Signal smoothing',
            short_id: 'ST-2',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'refine',
            story_points: 3,
            prioritization_score: 1.2,
          }),
        ],
        rollup: { story_count: 2, points_total: 8, points_done: 0 },
      },
    ],
    ungrouped: [
      apiStory({
        id: 'S3',
        name: 'Loose investigation',
        short_id: 'ST-3',
        type: 'story',
        dor: 'idea',
        prioritization_score: null,
      }),
    ],
    health: {
      dor_pct: 33,
      ready_count: 1,
      ready_points: 5,
      capacity_points: 20,
      unestimated: 1,
      ac_met: 4,
      ac_total: 6,
      story_count: 3,
    },
    scoring: { model: 'wsjf' },
  };
}

async function setup(
  page: import('@playwright/test').Page,
  { empty = false }: { empty?: boolean } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: FIXTURE_PROJECT_ID });

  // Track quick-add create calls so the test can assert the POST body.
  const created: Array<Record<string, unknown>> = [];

  // Registered after setupApiMocks so these win (Playwright matches last-registered first).
  await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(groomingPayload(empty)),
    }),
  );
  await page.route('**/api/v1/tasks/', (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(apiStory({ id: 'NEW', name: 'created' })),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
  });

  return { created };
}

test.describe('Product backlog grooming (#494/#921/#922)', () => {
  test('renders epics, stories, and the active-model score column', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });
    // Epic group + its stories.
    await expect(page.getByText('Telemetry')).toBeVisible();
    await expect(page.getByText('Failover handling')).toBeVisible();
    await expect(page.getByText('Signal smoothing')).toBeVisible();
    await expect(page.getByText('Loose investigation')).toBeVisible();

    // #922 score column: the model name appears (header badge + column header) and rows
    // show the computed score. "WSJF" renders in both the badge and the column header, so
    // assert it appears at least once rather than tripping strict mode.
    await expect(page.getByText('WSJF').first()).toBeVisible();
    await expect(page.getByText('3.5', { exact: true })).toBeVisible();
    await expect(page.getByText('1.2', { exact: true })).toBeVisible();

    // Auto-rank is enabled when a model is set.
    await expect(page.getByRole('button', { name: 'Auto-rank' })).toBeEnabled();
  });

  test('quick-add commits a title-only story on Enter and clears the input', async ({ page }) => {
    const { created } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    const input = page.getByRole('textbox', { name: 'Add a story' });
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('Investigate flaky uplink');
    await input.press('Enter');

    await expect(input).toHaveValue('');
    await expect.poll(() => created.length).toBeGreaterThan(0);
    expect(created[0]).toMatchObject({
      name: 'Investigate flaky uplink',
      status: 'BACKLOG',
      type: 'story',
      project: FIXTURE_PROJECT_ID,
    });
  });

  test('shows sprint-commitment chips + legend, and the dynamic subtitle counts (1223)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });
    // Dynamic subtitle reflects the composition: S1 committed, S2 + S3 candidates.
    await expect(page.getByText(/1 pulled into sprint · 2 proposed/)).toBeVisible();
    // Legend explains the two chips.
    await expect(page.getByText('= committed to a sprint')).toBeVisible();
    await expect(page.getByText('= candidate')).toBeVisible();
    // The committed story carries the "Pulled" chip; candidates carry "Proposed".
    await expect(page.getByText('Pulled').first()).toBeVisible();
    await expect(page.getByText('Proposed').first()).toBeVisible();
    // The assigned story renders its owner avatar (decorative circle; name on the wrapper).
    await expect(page.getByLabel('Assigned to Lena Bauer')).toBeVisible();
  });

  test('the By epic / Ranked toggle switches to a flat list with epic breadcrumbs (1223)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    // Default view is "By epic": the group header carries the uppercase "Epic" label.
    await expect(page.getByText('Epic', { exact: true })).toBeVisible({ timeout: 10_000 });

    // The radio is sr-only inside its label (web-rule 175 pattern); a user clicks the
    // visible label text, which natively toggles the wrapped input.
    await page.getByText('Ranked', { exact: true }).click();

    // Ranked view is a flat list — the epic group header is gone, the stories remain, and
    // each row carries its parent-epic name as a breadcrumb.
    await expect(page.getByText('Epic', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Failover handling')).toBeVisible();
    await expect(page.getByText('Telemetry').first()).toBeVisible();
  });

  test('the header CTAs focus the quick-add and route to sprint planning (1223)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    const input = page.getByRole('textbox', { name: 'Add a story' });
    await expect(input).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: '+ Add story' }).click();
    await expect(input).toBeFocused();

    await page.getByRole('button', { name: /Plan sprint/i }).click();
    await page.waitForURL(/\/sprints$/);
  });

  test('renders the empty state with the quick-add affordance', async ({ page }) => {
    await setup(page, { empty: true });
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText(/No stories yet/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('textbox', { name: 'Add a story' })).toBeVisible();
    // No model → no score column header, and auto-rank disabled.
    await expect(page.getByRole('button', { name: 'Auto-rank' })).toBeDisabled();
  });

  test('the planning rail + per-row commit toggle commits a story to the planned sprint (1291)', async ({
    page,
  }) => {
    await setup(page);
    const json = (body: unknown) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    // Grant the Product-Owner facet so the commit toggle is enabled (canManageBacklog).
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill(
        json({ ...FIXTURE_PROJECTS[0], my_facets: { is_product_owner: true, is_scrum_master: false } }),
      );
    });
    const planned = {
      id: 'sp-plan',
      short_id: 'P1',
      short_id_display: 'SP-P1',
      name: 'Sprint P1',
      goal: '',
      state: 'PLANNED',
      start_date: '2026-06-29',
      finish_date: '2026-07-13',
      capacity_points: 24,
      committed_points: null,
      committed_task_count: null,
      wip_limit: null,
      target_milestone: null,
      target_milestone_detail: null,
      server_version: 1,
    };
    // Registered after setup() so they win (Playwright matches last-registered first).
    await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/sprints/**`, (route) =>
      route.fulfill(json({ count: 1, next: null, previous: null, results: [planned] })),
    );
    await page.route(/\/api\/v1\/sprints\/.*\/capacity\//, (route) =>
      route.fulfill(
        json({
          members: [],
          totals: {
            committed_hours: 0,
            available_hours: 24,
            ratio: 0,
            buffer_hours: 24,
            label: 'on_track',
            pto_days: 0,
          },
          working_days: 10,
          hours_per_day: 8,
        }),
      ),
    );
    // S2 "Signal smoothing" is proposed (no sprint) → shows "+ Add"; S1 is pulled
    // into a different sprint (SP1) so it stays a read-only chip.
    let committedSprint: string | null | undefined;
    await page.route(/\/api\/v1\/tasks\/S2\//, (route) => {
      if (route.request().method() === 'PATCH') {
        committedSprint = (route.request().postDataJSON() as { sprint?: string | null }).sprint;
      }
      return route.fulfill(json(apiStory({ id: 'S2', name: 'Signal smoothing' })));
    });

    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    // The planning rail renders (desktop viewport ≥ lg).
    await expect(
      page.getByRole('complementary', { name: /sprint planning summary/i }),
    ).toBeVisible();
    await expect(page.getByText('SP-P1').first()).toBeVisible();

    // The per-row Sprint cell is now a commit toggle; clicking it commits the story.
    const addBtn = page.getByRole('button', { name: /Add Signal smoothing to SP-P1/i });
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect.poll(() => committedSprint).toBe('sp-plan');
  });
});

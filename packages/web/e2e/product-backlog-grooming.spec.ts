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

  test('renders the empty state with the quick-add affordance', async ({ page }) => {
    await setup(page, { empty: true });
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText(/No stories yet/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('textbox', { name: 'Add a story' })).toBeVisible();
    // No model → no score column header, and auto-rank disabled.
    await expect(page.getByRole('button', { name: 'Auto-rank' })).toBeDisabled();
  });
});

/**
 * E2E for the story-detail grooming drawer (#1043 / #731).
 *
 * Covers the surfaces a row-click opens: the slide-in drawer, the deferred Save
 * bar batching a scalar edit (title — a Member+ field, so this is robust to the
 * test's role fixture), the live Definition-of-Ready gate, and an immediate
 * acceptance-criterion tick. The client-side scoring-score preview (which needs
 * backlog-manage rights) is covered exhaustively by the scorePreview + drawer
 * vitest; this spec asserts the integrated open→edit→save flow.
 */
import { expect, test } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-drawer-0000-0000-0000-0000-000000001043';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Drawer Test Project',
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

function groomingPayload() {
  return {
    epics: [],
    ungrouped: [
      apiStory({
        id: 'S1',
        name: 'Failover handling',
        short_id: 'ST-1',
        type: 'story',
        dor: 'refine',
        story_points: 5,
        business_value: 8,
        time_criticality: 5,
        risk_reduction: 5,
        job_size: 4,
        criteria_met_count: 1,
        criteria_total: 2,
        prioritization_score: 4.5,
        acceptance_criteria: [
          { id: 'AC1', text: 'Fails over within 5s', met: true, position: 0 },
          { id: 'AC2', text: 'No data loss on cutover', met: false, position: 1 },
        ],
      }),
    ],
    health: {
      dor_pct: 0,
      ready_count: 0,
      ready_points: 0,
      capacity_points: null,
      unestimated: 0,
      ac_met: 1,
      ac_total: 2,
      story_count: 1,
    },
    scoring: { model: 'wsjf' },
  };
}

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: FIXTURE_PROJECT_ID });

  const taskPatches: Array<Record<string, unknown>> = [];
  const acPatches: Array<{ url: string; body: Record<string, unknown> }> = [];

  await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(groomingPayload()),
    }),
  );

  await page.route('**/api/v1/tasks/*/', (route) => {
    if (route.request().method() === 'PATCH') {
      taskPatches.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(apiStory({ id: 'S1', name: 'patched' })),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.route('**/api/v1/acceptance-criteria/**', (route) => {
    if (route.request().method() === 'PATCH') {
      acPatches.push({ url: route.request().url(), body: route.request().postDataJSON() });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'AC2', text: 'No data loss on cutover', met: true, position: 1 }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return { taskPatches, acPatches };
}

test.describe('Story detail drawer (#1043)', () => {
  test('opens on row click and batches a title edit through the Save bar', async ({ page }) => {
    const { taskPatches } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await page.getByRole('button', { name: /Open story Failover handling/i }).click();

    const drawer = page.getByRole('dialog', { name: 'Failover handling' });
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // No Save bar until dirty.
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);

    await drawer.getByLabel('Story title').fill('Failover handling v2');
    await drawer.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => taskPatches.length).toBeGreaterThan(0);
    expect(taskPatches[0]).toMatchObject({ name: 'Failover handling v2' });
  });

  test('disables Ready with a blocker reason until criteria are met', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await page.getByRole('button', { name: /Open story Failover handling/i }).click();

    const drawer = page.getByRole('dialog', { name: 'Failover handling' });
    await expect(drawer.getByRole('radio', { name: 'Ready' })).toBeDisabled();
    await expect(drawer.getByText(/all acceptance criteria must be met/i)).toBeVisible();
  });

  test('ticking a criterion fires an immediate acceptance-criteria PATCH', async ({ page }) => {
    const { acPatches } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await page.getByRole('button', { name: /Open story Failover handling/i }).click();

    const drawer = page.getByRole('dialog', { name: 'Failover handling' });
    await drawer.getByLabel('Mark "No data loss on cutover" met').check();

    await expect.poll(() => acPatches.length).toBeGreaterThan(0);
    expect(acPatches[0].url).toContain('/acceptance-criteria/AC2/');
    expect(acPatches[0].body).toMatchObject({ met: true });
  });
});

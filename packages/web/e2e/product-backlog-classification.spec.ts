/**
 * E2E for the classification cascade reached from the product backlog (#3035).
 *
 * ADR-0800 §3 routes a newly-created agile project to `/product-backlog`, and
 * ADR-0800 §6 promised the `⌘⇧M` classification entry point would land in this
 * toolbar. It did not: the popover shipped in #2736 bound only on the Schedule, so
 * the PO who most needs to declare a gated compliance subtree — the one standing on
 * the backlog an agile project drops them onto — had to navigate away to do it.
 *
 * The falsification line on the issue is behavioral: a PO marks a story `gated`
 * from the backlog page itself, without navigating to `/schedule`. That is what
 * this spec asserts, end to end, including the PATCH body the server receives.
 */
import { expect, test } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-classify-0000-0000-0000-000000003035';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Agile Compliance Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function apiTask(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'T',
    wbs_path: null,
    name: 'Task',
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

const EPIC = apiTask({ id: 'EP1', name: 'Payments', short_id: 'EP-1', type: 'epic', wbs_path: '1' });
const STORY = apiTask({
  id: 'S1',
  name: 'PCI audit trail',
  short_id: 'ST-1',
  type: 'story',
  parent_epic: 'EP1',
  parent_id: 'EP1',
  wbs_path: '1.1',
  dor: 'ready',
  story_points: 5,
});

function groomingPayload() {
  return {
    epics: [{ epic: EPIC, stories: [STORY], rollup: { story_count: 1, points_total: 5, points_done: 0 } }],
    ungrouped: [],
    health: {
      dor_pct: 100,
      ready_count: 1,
      ready_points: 5,
      capacity_points: 20,
      unestimated: 0,
      ac_met: 0,
      ac_total: 0,
      story_count: 1,
    },
    scoring: { model: 'none' },
  };
}

async function setup(page: import('@playwright/test').Page, { canManage = true } = {}) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: FIXTURE_PROJECT_ID });

  await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(groomingPayload()),
    }),
  );

  // The popover's subtree preview walks `parentId`, so the task tree has to be
  // served with the real parent links — this is the fetch the page arms on demand.
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 2, next: null, previous: null, results: [EPIC, STORY] }),
    }),
  );

  if (!canManage) {
    await page.route('**/api/v1/me/facets/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ can_manage_backlog: false }),
      }),
    );
  }

  const classified: Array<Record<string, unknown>> = [];
  await page.route('**/api/v1/projects/*/tasks/classification/', async (route) => {
    classified.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        subtree: 'S1',
        matched: 1,
        governance: {
          requested: 'gated',
          applied: 1,
          unchanged: 0,
          overrides_kept: 0,
          has_inherit_bit: true,
        },
        delivery_mode: {
          requested: 'waterfall',
          applied: 1,
          unchanged: 0,
          overrides_kept: null,
          has_inherit_bit: false,
        },
        skipped: [],
        operation_id: 'op-3035',
      }),
    });
  });

  return { classified };
}

/** Wait for the page's own reads to settle before touching toolbar chrome. */
async function gotoBacklog(page: import('@playwright/test').Page) {
  await page.goto(`${BASE_URL}/product-backlog`);
  await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole('button', { name: /Open story PCI audit trail/ })).toBeVisible();
}

test.describe('Classification from the product backlog (#3035)', () => {
  test('a story is classified gated without leaving /product-backlog', async ({ page }) => {
    const { classified } = await setup(page);
    await gotoBacklog(page);

    await page.getByRole('button', { name: 'Classify PCI audit trail' }).click();

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();

    await popover.getByTestId('classification-preset-gated').click();
    await popover.getByTestId('classification-apply').click();

    await expect(popover).toBeHidden();
    expect(classified).toHaveLength(1);
    expect(classified[0]).toMatchObject({
      subtree: 'S1',
      governance_class: 'gated',
      delivery_mode: 'waterfall',
    });

    // Still on the backlog — the whole point of the issue.
    expect(new URL(page.url()).pathname).toBe(`${BASE_URL}/product-backlog`);
  });

  test('the same chord the Schedule uses opens it here', async ({ page }) => {
    await setup(page);
    await gotoBacklog(page);

    await page.getByRole('button', { name: /Open story PCI audit trail/ }).click();
    await page.keyboard.press('ControlOrMeta+Shift+M');

    await expect(page.getByTestId('classification-popover')).toBeVisible();
  });

  // The row is a button that opens the detail drawer, and the drawer covers the
  // right of the page. An entry point that opened it first would be an entry point
  // to nothing — which is exactly what a toolbar button acting on "the selected
  // row" turned out to be.
  test('reaching it does not open the detail drawer over it', async ({ page }) => {
    await setup(page);
    await gotoBacklog(page);

    await page.getByRole('button', { name: 'Classify PCI audit trail' }).click();
    await expect(page.getByTestId('classification-popover')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'PCI audit trail' })).toBeHidden();
  });
});

/**
 * E2E for the grooming filter bar + mobile card layout (issue 1044).
 *
 * Two surfaces on the PO grooming view (ProductBacklogPage):
 *   - Desktop filter bar: search / DoR-state chips / "unestimated only" narrow the list.
 *   - Mobile (< md): a distinct card stack with swipe-to-toggle-DoR and a full-screen
 *     quick-add sheet — the dense desktop table is unusable at phone width.
 *
 * Every endpoint the page reads is mocked with its real response shape (per the
 * catch-all note in CLAUDE.md — the `{count:0,…}` net returns a list shape that would
 * crash the object-shaped product-backlog read). Interactions gate on a "page rendered"
 * signal (the heading / a card) before touching chrome.
 */
import { expect, test, type Page } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-groom-00000000-0000-0000-0000-000000001044';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Grooming Filter Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    // Product-Owner facet → the manage controls (+ Add story) render.
    my_facets: { is_product_owner: true, is_scrum_master: false },
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
          }),
          apiStory({
            id: 'S2',
            name: 'Signal smoothing',
            short_id: 'ST-2',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'refine',
            story_points: null, // unestimated
            criteria_met_count: 0,
            criteria_total: 2,
          }),
        ],
        rollup: { story_count: 2, points_total: 5, points_done: 0 },
      },
    ],
    ungrouped: [
      apiStory({
        id: 'S3',
        name: 'Loose investigation',
        short_id: 'ST-3',
        type: 'story',
        dor: 'idea',
        story_points: null, // unestimated
      }),
    ],
    health: {
      dor_pct: 33,
      ready_count: 1,
      ready_points: 5,
      capacity_points: 20,
      unestimated: 2,
      ac_met: 4,
      ac_total: 8,
      story_count: 3,
    },
    scoring: { model: 'none' },
  };
}

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: FIXTURE_PROJECT_ID });

  const created: Array<Record<string, unknown>> = [];
  const dorPatches: Array<{ id: string; dor?: string }> = [];

  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // Registered after setupApiMocks so these win (Playwright matches last-registered first).
  await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
    route.fulfill(json(groomingPayload())),
  );
  await page.route('**/api/v1/projects/*/sprints/**', (route) =>
    route.fulfill(json({ count: 0, next: null, previous: null, results: [] })),
  );
  await page.route('**/api/v1/tasks/', (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill(json(apiStory({ id: 'NEW', name: 'created' }), 201));
    }
    return route.fulfill(json({ count: 0, next: null, previous: null, results: [] }));
  });
  // DoR toggle (swipe + chip tap both PATCH the task).
  await page.route(/\/api\/v1\/tasks\/S\d+\//, (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as { dor?: string };
      const id = req.url().match(/tasks\/(S\d+)\//)?.[1] ?? '?';
      dorPatches.push({ id, dor: body.dor });
      return route.fulfill(json(apiStory({ id, dor: body.dor ?? 'refine' })));
    }
    return route.fulfill(json(apiStory({ id: 'S' })));
  });

  return { created, dorPatches };
}

test.describe('Grooming filter bar — desktop (issue 1044)', () => {
  test('search narrows the list to matching titles', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    // All three stories render initially.
    await expect(page.getByText('Failover handling')).toBeVisible();
    await expect(page.getByText('Signal smoothing')).toBeVisible();
    await expect(page.getByText('Loose investigation')).toBeVisible();

    await page.getByRole('searchbox', { name: 'Search stories' }).fill('signal');

    // Only the matching story survives; the "N of M" readout settles to 1 of 3.
    await expect(page.getByText('Signal smoothing')).toBeVisible();
    await expect(page.getByText('Failover handling')).toHaveCount(0);
    await expect(page.getByText('Loose investigation')).toHaveCount(0);
    await expect(page.getByText('1 of 3').first()).toBeVisible();
  });

  test('the "unestimated only" toggle drops the pointed story', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('checkbox', { name: 'Show only unestimated stories' }).check();

    // S1 is pointed (5) → hidden; S2 + S3 are unestimated → shown.
    await expect(page.getByText('Failover handling')).toHaveCount(0);
    await expect(page.getByText('Signal smoothing')).toBeVisible();
    await expect(page.getByText('Loose investigation')).toBeVisible();

    // Clear restores the full list.
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByText('Failover handling')).toBeVisible();
  });

  test('a readiness chip filters by DoR state', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    // The "Ready" filter chip lives in the readiness group; press it.
    await page
      .getByRole('group', { name: 'Filter by readiness' })
      .getByRole('button', { name: 'Ready' })
      .click();

    await expect(page.getByText('Failover handling')).toBeVisible(); // dor=ready
    await expect(page.getByText('Signal smoothing')).toHaveCount(0); // dor=refine
    await expect(page.getByText('Loose investigation')).toHaveCount(0); // dor=idea
  });
});

test.describe('Mobile grooming (issue 1044, 375px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
  });

  test('renders the card stack grouped by epic', async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });
    // Cards, not a dense table.
    const cards = page.getByTestId('grooming-card');
    await expect(cards).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Open story Failover handling' })).toBeVisible();
    // Epic section header + the "No epic" section.
    await expect(page.getByRole('heading', { name: 'Telemetry' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No epic' })).toBeVisible();
  });

  test('the quick-add sheet opens and commits a title-only story', async ({ page }) => {
    const { created } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByTestId('grooming-card').first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Add story' }).click();

    const dialog = page.getByRole('dialog', { name: 'Add a story' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Story title' }).fill('Investigate flaky uplink');
    await dialog.getByRole('button', { name: 'Add story' }).click();

    await expect.poll(() => created.length).toBeGreaterThan(0);
    expect(created[0]).toMatchObject({ name: 'Investigate flaky uplink', status: 'BACKLOG' });
  });

  test('tapping a card DoR chip toggles readiness (PATCH)', async ({ page }) => {
    const { dorPatches } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByTestId('grooming-card').first()).toBeVisible({ timeout: 10_000 });

    // S1 is dor=ready → tapping its chip toggles to refine.
    await page.getByRole('button', { name: 'Toggle readiness for Failover handling' }).click();
    await expect.poll(() => dorPatches.find((p) => p.id === 'S1')?.dor).toBe('refine');
  });

  test('swiping a card past the threshold toggles readiness (PATCH)', async ({ page }) => {
    const { dorPatches } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);
    await expect(page.getByTestId('grooming-card').first()).toBeVisible({ timeout: 10_000 });

    // S2 is dor=refine → a swipe toggles to ready. Drive a horizontal pointer drag well
    // past the 72px commit threshold.
    const card = page.getByRole('button', { name: 'Open story Signal smoothing' });
    const box = await card.boundingBox();
    if (!box) throw new Error('card has no bounding box');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 30, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 30 + 100, y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => dorPatches.find((p) => p.id === 'S2')?.dor).toBe('ready');
  });
});

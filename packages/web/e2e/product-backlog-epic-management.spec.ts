/**
 * E2E for epic management on the Product Backlog grooming view (#1339).
 *
 * Backend is unchanged — create/rename/delete reuse the generic `/tasks/` endpoints —
 * so this spec asserts the UI exposure: the gated "+ Add epic" affordance, the in-place
 * rename, and the delete confirmation that states the ungroup-not-delete outcome. The
 * permission gating is verified two ways: a backlog manager (PO facet + per-epic
 * can_edit/can_delete) gets all three; a Product Owner who lacks delete (can_delete:false)
 * sees Rename but no Delete; a plain viewer sees nothing.
 */
import { expect, test } from '@playwright/test';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-epic-00000000-0000-0000-0000-000000001339';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Epic Mgmt Project',
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

function groomingPayload({ canDelete = true }: { canDelete?: boolean } = {}) {
  return {
    epics: [
      {
        epic: apiStory({
          id: 'EP1',
          name: 'Telemetry',
          short_id: 'EP-1',
          type: 'epic',
          can_edit: true,
          can_delete: canDelete,
        }),
        stories: [
          apiStory({
            id: 'S1',
            name: 'Failover handling',
            short_id: 'ST-1',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'ready',
            story_points: 5,
          }),
          apiStory({
            id: 'S2',
            name: 'Signal smoothing',
            short_id: 'ST-2',
            type: 'story',
            parent_epic: 'EP1',
            dor: 'refine',
            story_points: 3,
          }),
        ],
        rollup: { story_count: 2, points_total: 8, points_done: 0 },
      },
    ],
    ungrouped: [],
    health: {
      dor_pct: 50,
      ready_count: 1,
      ready_points: 5,
      capacity_points: null,
      unestimated: 0,
      ac_met: 0,
      ac_total: 0,
      story_count: 2,
    },
    scoring: { model: 'none' },
  };
}

async function setup(
  page: import('@playwright/test').Page,
  {
    productOwner = true,
    canDelete = true,
    role = 300,
  }: { productOwner?: boolean; canDelete?: boolean; role?: number } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    // role drives the other canManageBacklog input (role>=ADMIN); 300=Admin, 0=Viewer.
    members: [{ id: 'mem', role }],
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  // Grant (or withhold) the Product-Owner facet → drives canManageBacklog (the "+ Add epic" gate).
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill(
      json({
        ...FIXTURE_PROJECTS[0],
        my_facets: { is_product_owner: productOwner, is_scrum_master: false },
      }),
    );
  });
  // The shared fixture hardcodes the ?self=true membership to Admin (role 300); override
  // it so `role` actually drives useCurrentUserRole → canManageBacklog (the "+ Add epic" gate).
  await page.route(`**/api/v1/projects/${FIXTURE_PROJECT_ID}/members/**`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill(json([{ id: 'mem', role, user_id: 'me' }]));
  });
  await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
    route.fulfill(json(groomingPayload({ canDelete }))),
  );

  const created: Array<Record<string, unknown>> = [];
  const renamed: Array<Record<string, unknown>> = [];
  let deleted = false;

  await page.route('**/api/v1/tasks/', (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(apiStory({ id: 'NEW', name: 'created', type: 'epic' })),
      });
    }
    return route.fulfill(json({ count: 0, next: null, previous: null, results: [] }));
  });
  await page.route('**/api/v1/tasks/EP1/', (route) => {
    const method = route.request().method();
    if (method === 'PATCH') {
      renamed.push(route.request().postDataJSON());
      return route.fulfill(json(apiStory({ id: 'EP1', name: 'renamed', type: 'epic' })));
    }
    if (method === 'DELETE') {
      deleted = true;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill(json(apiStory({ id: 'EP1', type: 'epic' })));
  });

  return { created, renamed, isDeleted: () => deleted };
}

test.describe('Product backlog epic management (#1339)', () => {
  test('a backlog manager adds an epic from the "+ Add epic" affordance', async ({ page }) => {
    const { created } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByRole('heading', { name: 'Product backlog' })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: '+ Add epic' }).click();
    const input = page.getByRole('textbox', { name: 'New epic name' });
    await expect(input).toBeFocused();
    await input.fill('Platform Core');
    await input.press('Enter');

    await expect(input).toHaveValue('');
    await expect.poll(() => created.length).toBeGreaterThan(0);
    expect(created[0]).toMatchObject({
      name: 'Platform Core',
      type: 'epic',
      status: 'BACKLOG',
      project: FIXTURE_PROJECT_ID,
    });
  });

  test('a backlog manager renames an epic in place', async ({ page }) => {
    const { renamed } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText('Telemetry')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Epic actions: Telemetry' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();

    const input = page.getByRole('textbox', { name: /Rename epic Telemetry/i });
    await input.fill('Telemetry & Alerting');
    await input.press('Enter');

    await expect.poll(() => renamed.length).toBeGreaterThan(0);
    expect(renamed[0]).toEqual({ name: 'Telemetry & Alerting' });
  });

  test('delete shows a confirmation stating the ungroup outcome, then deletes', async ({ page }) => {
    const { isDeleted } = await setup(page);
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText('Telemetry')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Epic actions: Telemetry' }).click();
    await page.getByRole('menuitem', { name: 'Delete epic' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      'This epic has 2 stories. They will move to Ungrouped — they are not deleted.',
    );

    await dialog.getByRole('button', { name: 'Delete epic' }).click();
    await expect.poll(() => isDeleted()).toBe(true);
  });

  test('a Product Owner without delete rights sees Rename but not Delete', async ({ page }) => {
    await setup(page, { canDelete: false });
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText('Telemetry')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Epic actions: Telemetry' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete epic' })).toHaveCount(0);
  });

  test('a viewer (no backlog-manage rights) sees no epic-management affordances', async ({
    page,
  }) => {
    await setup(page, { productOwner: false, canDelete: false, role: 0 });
    // Withhold per-epic edit rights too (a real viewer's payload has can_edit:false).
    await page.route('**/api/v1/projects/*/product-backlog/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...groomingPayload(),
          epics: [
            {
              epic: apiStory({
                id: 'EP1',
                name: 'Telemetry',
                short_id: 'EP-1',
                type: 'epic',
                can_edit: false,
                can_delete: false,
              }),
              stories: [],
              rollup: { story_count: 0, points_total: 0, points_done: 0 },
            },
          ],
        }),
      }),
    );
    await page.goto(`${BASE_URL}/product-backlog`);

    await expect(page.getByText('Telemetry')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '+ Add epic' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Epic actions: Telemetry' })).toHaveCount(0);
  });
});

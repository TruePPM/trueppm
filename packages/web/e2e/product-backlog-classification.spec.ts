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

async function setup(
  page: import('@playwright/test').Page,
  { canManage = true, canUndo = true } = {},
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    // `canUndo` drives BOTH payloads (#3357). The project detail's
    // `can_undo_batch_operations` is what the popover discloses from, before the
    // act; the apply response's `can_undo` is what the toast withholds the Undo
    // from, after it. One server predicate answers both, so splitting them in the
    // fixture would model a state the server cannot produce — and would let the
    // pre-act assertion pass while the post-act one silently drifted.
    projects: FIXTURE_PROJECTS.map((p) => ({ ...p, can_undo_batch_operations: canUndo })),
    projectId: FIXTURE_PROJECT_ID,
  });

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
        // #3304: undo authority is Admin+, above the floor that admits the apply —
        // so the receipt carries it and the client never offers an Undo the undo
        // endpoint would refuse. Never hardcoded `true`: `can_manage_backlog` here
        // is `Admin+ OR the Product Owner facet`, so a PO below Admin reaches this
        // response and cannot undo it, and a fixture that always said `true` would
        // model a server state the real one cannot produce.
        can_undo: canUndo,
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

/**
 * The Undo affordance on this surface (#3304).
 *
 * Covered here as well as on the Schedule because the two surfaces do NOT share a
 * toast: `ScheduleView` passes `setScheduleActionToast` and renders its own, while
 * this page routes through the global `ToastHost` via
 * `announceClassification` — `toast.action(...)` when the announcement carries one,
 * `toast.info(...)` when it does not. The shared hook decides; only this spec proves
 * the `toast.info` branch actually renders.
 *
 * The backlog is also where the split bites hardest. Its entry point is gated on
 * `can_manage_backlog`, which is `Admin+ OR the Product Owner facet` — so a PO
 * *below* Admin is invited to classify and cannot reverse it. That user does not
 * exist on the Schedule's gate at all.
 */
async function classifyFromBacklog(page: import('@playwright/test').Page): Promise<void> {
  await gotoBacklog(page);
  await page.getByRole('button', { name: 'Classify PCI audit trail' }).click();
  const popover = page.getByTestId('classification-popover');
  await expect(popover).toBeVisible();
  await popover.getByTestId('classification-preset-gated').click();
  await popover.getByTestId('classification-apply').click();
  await expect(popover).toBeHidden();
}

test.describe('Classification undo from the product backlog (#3304, #3357)', () => {
  test('a PO below Admin is told before applying that they cannot reverse it', async ({
    page,
  }) => {
    // The case the server-side flag exists for, and the reason this spec is the one
    // that proves it. This page's entry point is gated on `can_manage_backlog` —
    // `Admin+ OR the Product Owner facet` — so this caller passes that gate, is
    // invited to classify, and still cannot undo. A client that had reused the
    // authority already in scope here (`canManageBacklog`, which is true) would show
    // no note and this assertion would fail; an ordinal test off `useCurrentUserRole`
    // would answer from a query this page does not need and that returns a terminal
    // `null` on one dropped request. Only the server's own verdict gets it right.
    await setup(page, { canUndo: false });
    await gotoBacklog(page);

    // The manage gate really is open for this caller — asserted, not assumed, so the
    // note below cannot be passing because the whole surface is read-only.
    const classifyButton = page.getByRole('button', { name: 'Classify PCI audit trail' });
    await expect(classifyButton).toBeVisible();
    await classifyButton.click();

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    const note = popover.getByTestId('classification-undo-floor');
    await expect(note).toBeVisible();
    await expect(note).toContainText('You won\u2019t be able to reverse this');
    // "rights", not the ROLE_ADMIN label: Owner clears the same floor and displays as
    // "Project Admin", and #3355 may move the floor out from under both.
    await expect(note).toContainText('someone with Project Manager rights can');
  });

  test('an Admin sees no such note', async ({ page }) => {
    await setup(page, { canUndo: true });
    await gotoBacklog(page);
    await page.getByRole('button', { name: 'Classify PCI audit trail' }).click();

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    // Gated on the preview having rendered, so the absence is measured against a
    // popover that finished, not an empty one.
    await expect(popover.getByTestId('classification-preview')).toBeVisible();
    await expect(popover.getByTestId('classification-undo-floor')).toHaveCount(0);
  });

  test('an Admin gets the success toast WITH an Undo action', async ({ page }) => {
    await setup(page, { canUndo: true });
    await classifyFromBacklog(page);

    const toast = page.getByRole('status').filter({ hasText: 'Classified' });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  test('a Product Owner below Admin gets the same toast with no Undo action', async ({ page }) => {
    const undoAttempts: string[] = [];
    await page.route(/\/api\/v1\/cascade-classification-operations\/[^/]+\/undo\/$/, (route) => {
      undoAttempts.push(route.request().url());
      return route.fallback();
    });
    await setup(page, { canUndo: false });
    await classifyFromBacklog(page);

    // Gate on the receipt being rendered before asserting the button's absence, so
    // this cannot pass by racing an empty DOM.
    const toast = page.getByRole('status').filter({ hasText: 'Classified' });
    await expect(toast).toBeVisible();
    await expect(toast.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    // Nothing to click, so the 403 the user would have hit never happens.
    expect(undoAttempts).toHaveLength(0);
  });
});

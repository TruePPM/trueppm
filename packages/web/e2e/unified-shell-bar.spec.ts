/**
 * E2E for the v2 unified shell bar (#1204, ADR-0134; amended by #1643/ADR-0203).
 * After #1643 the bar's left region is a location switcher (Program › Project ›
 * Leaf) — the breadcrumb + in-chrome ProjectSwitcher are gone and the view-tab
 * strip lives in the left rail. Asserts: the location switcher wayfinding, the rail
 * re-open ≡ toggle + persistence, presence in the bar, and that the pinned right
 * cluster stays visible at lg widths.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-shellbar-0000-0000-0000-000000001204';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Shell Bar Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'shellbar-prog-1', name: 'Apollo Program' },
  },
];

// Worst-case health chip: an at-risk state word AND a P80 forecast date both
// render, which is the widest single segment the cluster ever carries (#2533).
const STATUS_SUMMARY = {
  task_count: 12,
  critical_path_count: 3,
  monte_carlo_p80: '2026-09-07',
  at_risk_count: 4,
  critical_count: 2,
  at_risk_tasks: [],
  critical_tasks: [],
  last_saved: null,
  recalculated_at: null,
};

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

/** Setup with a full-width health chip and an Admin role, so every self-gating
 *  segment in the status cluster renders (#2533). */
async function setupFullCluster(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: PROJECT_ID,
    statusSummary: STATUS_SUMMARY,
    members: [{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }],
  });
}

test.describe('v2 unified shell bar (#1204)', () => {
  test('the location switcher shows Project › Leaf wayfinding in the bar (#1643)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // The location switcher is the bar's wayfinding — always shown (no longer the
    // rail-coupled adaptive breadcrumb). Scope it to the banner landmark.
    const bar = page.getByRole('banner');
    const location = bar.getByRole('navigation', { name: 'Location' });
    await expect(location).toBeVisible({ timeout: 10_000 });

    // The active project is shown, and the leaf is the current view as a plain
    // aria-current label (never a dropdown — the rail owns view switching).
    await expect(location.getByText('Shell Bar Test Project')).toBeVisible();
    // "Dashboard" (ADR-0942 §7): the leaf resolves through the rail's `labelFor`, so
    // the bar's wayfinding word and the rail's nav row are the same string by construction.
    await expect(location.getByText('Dashboard')).toHaveAttribute('aria-current', 'page');
  });

  test('the ≡ toggle hides the rail and shows it again, and the hidden state persists across reload', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    // ADR-0979: collapsing narrows the rail to a 64px icon rail; it no longer
    // leaves the accessibility tree, so the old `toHaveCount(0)` is wrong.
    await expect(rail).toHaveAttribute('data-collapsed', 'true');

    await page.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(rail).toBeVisible();

    // Hide again, then reload: the deliberate collapse is restored from localStorage.
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    // ADR-0979: collapsing narrows the rail to a 64px icon rail; it no longer
    // leaves the accessibility tree, so the old `toHaveCount(0)` is wrong.
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand navigation' })).toBeVisible({
      timeout: 10_000,
    });
    // ADR-0979: collapsing narrows the rail to a 64px icon rail; it no longer
    // leaves the accessibility tree, so the old `toHaveCount(0)` is wrong.
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
  });

  test('presence avatars render in the bar on a project route, excluding self (#1180)', async ({
    page,
  }) => {
    await setup(page);
    await page.route('**/api/v1/projects/*/presence/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { user_id: 'e2e-user', display_name: 'E2E User' },
          { user_id: 'collab-alice', display_name: 'Alice Adams' },
          { user_id: 'collab-bob', display_name: 'Bob Brown' },
        ]),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const presence = page.getByRole('status', { name: /Alice Adams/ });
    await expect(presence).toBeVisible({ timeout: 10_000 });
    await expect(presence).toHaveAccessibleName(/Bob Brown/);
    await expect(presence).not.toHaveAccessibleName(/E2E User/);
  });

  test('the right cluster stays visible at lg — the tab strip scrolls, it does not push chrome off-screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/board`);

    // The view nav (now in the left rail, #1643) is present, and the always-on
    // right-cluster anchor (account chip) remains within the viewport. The chip
    // self-identifies by the signed-in user's name (#1792) — locatable by that
    // accessible name, never a generic "User menu".
    await expect(page.getByRole('navigation', { name: 'View' })).toBeVisible({ timeout: 10_000 });
    const userMenu = page.getByRole('button', { name: 'Account — E2E User' }).last();
    await expect(userMenu).toBeInViewport();
  });

  test('a decorative divider fences the "me" identity chip off from the notification bell (#1736)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const bar = page.getByRole('banner');
    const bell = bar.getByRole('button', { name: /notifications/i });
    await expect(bell).toBeVisible({ timeout: 10_000 });
    const accountChip = bar.getByRole('button', { name: 'Account — E2E User' }).last();
    await expect(accountChip).toBeVisible();

    // The divider is decorative (aria-hidden), so it never has an accessible
    // role — locate it by its stable structural class instead, scoped to the
    // bar so this can't accidentally match an unrelated divider elsewhere.
    const divider = bar.locator('span[aria-hidden="true"].bg-chrome-border\\/40');
    await expect(divider).toBeVisible();

    // On-screen geometry, not just DOM presence: the divider's x-position
    // sits strictly between the bell and the account chip — the whole point
    // of the fix is a visible seam at that exact spot (design §02), not
    // merely a divider existing somewhere in the bar.
    const bellBox = await bell.boundingBox();
    const dividerBox = await divider.boundingBox();
    const accountBox = await accountChip.boundingBox();
    expect(bellBox).not.toBeNull();
    expect(dividerBox).not.toBeNull();
    expect(accountBox).not.toBeNull();
    expect(dividerBox!.x).toBeGreaterThan(bellBox!.x);
    expect(accountBox!.x).toBeGreaterThan(dividerBox!.x);
  });
});

/**
 * The status cluster's overflow rule (#2533). Before this, the bar's right region
 * was one `shrink-0` row with no overflow rule: it neither wrapped nor scrolled,
 * so every segment added to it pushed the location switcher. These run at 1024 —
 * the tightest desktop width, where the #2483 handoff (§5.1) measured the cluster
 * already inside its own budget at five segments.
 */
test.describe('context-bar status cluster overflow (#2533)', () => {
  const VIEWPORT_W = 1024;

  test('at 1024 with a full cluster the breadcrumb is not truncated and stays in the viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: VIEWPORT_W, height: 768 });
    await setupFullCluster(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const bar = page.getByRole('banner');
    const location = bar.getByRole('navigation', { name: 'Location' });
    await expect(location).toBeVisible({ timeout: 10_000 });
    // Gate on the cluster having rendered before measuring anything — the
    // breadcrumb is laid out against it, so measuring first would measure the
    // pre-cluster bar and pass vacuously.
    await expect(page.getByTestId('shell-status-cluster')).toBeVisible();
    await expect(page.getByTestId('health-cluster')).toBeVisible();

    // Not truncated: every ellipsis-capable node in the breadcrumb renders its
    // full text. `scrollWidth > clientWidth` is exactly what `text-overflow`
    // clipping looks like in the DOM.
    const clipped = await location.evaluate((nav) =>
      Array.from(nav.querySelectorAll<HTMLElement>('.truncate'))
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent),
    );
    expect(clipped).toEqual([]);

    // Not pushed: the breadcrumb sits wholly inside the viewport, and the cluster
    // starts at or after the breadcrumb's right edge (no overlap).
    const locationBox = await location.boundingBox();
    const clusterBox = await page.getByTestId('shell-status-cluster').boundingBox();
    expect(locationBox).not.toBeNull();
    expect(clusterBox).not.toBeNull();
    expect(locationBox!.x).toBeGreaterThanOrEqual(0);
    expect(locationBox!.x + locationBox!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);
    expect(clusterBox!.x + 1).toBeGreaterThanOrEqual(locationBox!.x + locationBox!.width);

    // Nothing is pushed past the right edge either. This is the assertion that
    // fails on the pre-#2533 bar: with every item `shrink-0` and no overflow
    // rule, the row did not squeeze the breadcrumb — it simply ran off the end,
    // taking the account chip with it (verified against `origin/main`, where the
    // chip reports a viewport ratio of 0 at this width).
    const account = bar.getByRole('button', { name: 'Account — E2E User' }).last();
    await expect(account).toBeInViewport();
    const accountBox = await account.boundingBox();
    expect(accountBox).not.toBeNull();
    expect(accountBox!.x + accountBox!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);

    // …and the breadcrumb is at its *natural* width, not merely "un-clipped":
    // widening the viewport to where nothing competes must not change it. This is
    // the assertion that fails on the pre-#2533 bar, where the cluster's ~470px
    // of segments squeezed the switcher at 1024 and let it back out at 1600.
    await page.setViewportSize({ width: 1600, height: 768 });
    await expect(page.getByTestId('shell-status-cluster')).toBeVisible();
    const roomy = await location.boundingBox();
    expect(roomy).not.toBeNull();
    expect(locationBox!.width).toBeCloseTo(roomy!.width, 0);
  });

  test('adding a segment to the cluster does not move the breadcrumb', async ({ page }) => {
    await page.setViewportSize({ width: VIEWPORT_W, height: 768 });
    await setupFullCluster(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const bar = page.getByRole('banner');
    const location = bar.getByRole('navigation', { name: 'Location' });
    await expect(location).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('health-cluster')).toBeVisible();
    const before = await location.boundingBox();
    expect(before).not.toBeNull();

    // Collapsing the rail adds the `MethodologyIndicator` segment to the cluster
    // (#1907) — a real, in-product +1 segment. The bar is full-width above the
    // rail (AppShell), so the rail's own width is not a confound: the only thing
    // that changed is the cluster's content width.
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(bar.getByRole('img', { name: /methodology$/i })).toBeVisible();

    const after = await location.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.width).toBeCloseTo(before!.width, 0);
    expect(after!.x).toBeCloseTo(before!.x, 0);

    // …and the +1 segment scrolled instead of pushing: the bar's trailing control
    // is still inside the viewport. On the pre-#2533 bar this is where the extra
    // segment went — straight off the right edge.
    await expect(bar.getByRole('button', { name: 'Account — E2E User' }).last()).toBeInViewport();
  });

  test('the trailing segment stays reachable and the cluster is not a focus trap', async ({
    page,
  }) => {
    await page.setViewportSize({ width: VIEWPORT_W, height: 768 });
    await setupFullCluster(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const cluster = page.getByTestId('shell-status-cluster');
    await expect(cluster).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('health-cluster')).toBeVisible();

    // The last control in the cluster — the one a growing cluster scrolls out
    // first. Focusing it must bring it into view (the browser scrolls a focused
    // element into its scroll container), never leave it stranded.
    const trailing = cluster.locator('button').last();
    await trailing.focus();
    await expect(trailing).toBeInViewport();

    // …and Tab out of it lands on the pinned chrome, not back inside the cluster:
    // a scroll container is not allowed to become a keyboard dead-end.
    await page.keyboard.press('Tab');
    const escaped = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="shell-status-cluster"]');
      const active = document.activeElement;
      return Boolean(active && active !== document.body && !el?.contains(active));
    });
    expect(escaped).toBe(true);

    // The pinned chrome never scrolls: the account chip is outside the scroll
    // viewport and always in the viewport.
    const account = page.getByRole('button', { name: 'Account — E2E User' }).last();
    await expect(account).toBeInViewport();
    expect(await cluster.locator('button', { hasText: 'Account' }).count()).toBe(0);
  });

  // The shrink order has to bottom out somewhere, and it must bottom out on the
  // breadcrumb — not on the pinned chrome. A long `Program › Project` pair is the
  // one input that can consume the whole bar: at lg+ both segments render their
  // full name, and a single-option segment is a static identity row with no width
  // cap of its own, so the switcher's natural width scales with the name string.
  // With the region carrying a 9999 shrink weight, giving it `min-w-0` would make
  // it — not the breadcrumb — the first thing driven to zero, and the `shrink-0`
  // pinned chrome would then spill straight off the right edge of the bar. The
  // region therefore keeps its automatic minimum size; this pins that.
  test('a breadcrumb long enough to fill the bar truncates before the chrome leaves the viewport', async ({
    page,
  }) => {
    const LONG_PROGRAM =
      'Global Manufacturing Execution System Rollout Across EMEA and APAC Regions Consolidated Governance Track';
    const LONG_PROJECT =
      'Warehouse Management System Replacement and Inventory Data Migration Programme Phase Three Delivery';

    await page.setViewportSize({ width: VIEWPORT_W, height: 768 });
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [{ ...FIXTURE_PROJECTS[0], name: LONG_PROJECT }],
      projectId: PROJECT_ID,
      statusSummary: STATUS_SUMMARY,
      members: [{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }],
    });
    // A single program renders the static identity row — the uncapped branch.
    await page.route('**/api/v1/programs/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          count: 1,
          next: null,
          previous: null,
          results: [
            { id: 'shellbar-prog-1', name: LONG_PROGRAM, color: '#3E8C6D', code: 'GMX' },
          ],
        }),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const bar = page.getByRole('banner');
    await expect(bar.getByRole('navigation', { name: 'Location' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('health-cluster')).toBeVisible();

    // The bar itself never overflows — nothing is pushed past the right edge.
    const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The pinned chrome is intact and reachable at both ends of the group.
    await expect(bar.getByRole('button', { name: 'Account — E2E User' }).last()).toBeInViewport();
    const accountBox = await bar
      .getByRole('button', { name: 'Account — E2E User' })
      .last()
      .boundingBox();
    expect(accountBox).not.toBeNull();
    expect(accountBox!.x + accountBox!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);

    // The breadcrumb gave — that is the intended last resort — and the status
    // cluster held its `md:min-w-[6rem]` floor (96px) rather than being squeezed
    // out of existence to make room. Without the floor the strip is driven to
    // zero before a rigid neighbour yields a pixel, and the health chip vanishes
    // with no scroll affordance left to recover it (rule 290b).
    const clusterBox = await page.getByTestId('shell-status-cluster').boundingBox();
    expect(clusterBox).not.toBeNull();
    expect(clusterBox!.width).toBeGreaterThanOrEqual(96);
    await expect(page.getByTestId('health-cluster')).toBeInViewport();
  });
});

test.describe('the "+ New task" demotion (#2952, design case 18)', () => {
  test('"+ New task" lands in the Designer with a row in edit, not in a modal', async ({
    page,
  }) => {
    // The whole point of case 18: the shell's create affordance survives as an
    // entry point and loses its form. Asserting the URL AND the absence of a
    // dialog is deliberate — a regression here looks like "the button still
    // works", because it does; it just opens the wrong thing.
    await setupFullCluster(page);

    let created: Record<string, unknown> | null = null;
    await page.route('**/api/v1/tasks/', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      created = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'new-task-1',
          name: created.name,
          project: PROJECT_ID,
          duration: 1,
          percent_complete: 0,
          status: 'NOT_STARTED',
          is_summary: false,
          is_milestone: false,
          parent: null,
          wbs_path: '1',
        }),
      });
    });

    await page.goto(`/projects/${PROJECT_ID}/board`);
    await page.getByRole('button', { name: 'New task' }).click();

    await expect(page).toHaveURL(/\/schedule/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // The param is consumed and stripped, so a refresh cannot author a second row.
    await expect(page).not.toHaveURL(/author=/);
    expect(created).not.toBeNull();
  });
});

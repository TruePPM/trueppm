/**
 * E2E for the global toast host (#1225, ADR-0126). Proves the app-wide toast
 * fires from a real action (pinning a project) and renders in the
 * bottom-center polite status region. Auto-dismiss / variants / a11y are covered
 * deterministically by the ToastHost + toastStore unit tests; this spec asserts
 * the end-to-end wiring in the real shell.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-toast-00000000-0000-0000-0000-000000001225';
const CAPPED_ID = 'e2e-toast-00000000-0000-0000-0000-000000003149';
const CAPPED_2_ID = 'e2e-toast-00000000-0000-0000-0000-000000003150';

// Standalone projects (no `program`) render in the rail's Tier-3 Browse switcher
// "Projects" list, so their pin controls are reachable once the switcher is
// opened, without expanding a program tree.
const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Toast Demo Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
  {
    id: CAPPED_ID,
    name: 'Capped Project One',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
  {
    id: CAPPED_2_ID,
    name: 'Capped Project Two',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

// `usePins` raises a *passive* error toast for `pin_limit_reached` (retrying a cap
// cannot help) and an *actionable* one carrying Retry for anything else. That split
// is what makes the rail the one surface that can drive both toast slots from real
// UI, which is why the slot specs below live here rather than behind a test hook.
const PIN_CAP_MESSAGE = "You've pinned 100 items — unpin one to add another.";

/** Fulfil a pin POST as the 409 that produces the passive cap toast. */
const pinCapReached = { code: 'pin_limit_reached', detail: PIN_CAP_MESSAGE };

test.describe('global toast host (#1225)', () => {
  test('pinning a project fires an app-wide toast', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    // Pins are server state as of #2390, and the success toast waits for the
    // server rather than firing on click — so the write must be mocked or the
    // toast under test is the *error* one.
    await page.route(`**/api/v1/projects/${PROJECT_ID}/pin/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Gate on the rail being rendered before driving its controls.
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // The standalone project's pin control lives in the Tier-3 Browse switcher
    // (#1642); open it, then pin (hover-revealed; Playwright hovers as part of
    // click). Pinning is an app-wide action.
    await rail.getByRole('button', { name: 'Browse projects and programs' }).click();
    const pin = rail.getByRole('button', { name: 'Pin Toast Demo Project' });
    await pin.click();

    // The global toast announces the result bottom-center, politely.
    await expect(page.getByText('Pinned Toast Demo Project')).toBeVisible();
  });

  test('the pin toast carries a working Undo (#2390)', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });

    // Record both directions: Undo must issue the DELETE that reverses the POST,
    // not merely flip the glyph back in the cache.
    const writes: string[] = [];
    await page.route(`**/api/v1/projects/${PROJECT_ID}/pin/`, (route) => {
      writes.push(route.request().method());
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await rail.getByRole('button', { name: 'Browse projects and programs' }).click();
    await rail.getByRole('button', { name: 'Pin Toast Demo Project' }).click();

    await expect(page.getByText('Pinned Toast Demo Project')).toBeVisible();
    await page.getByRole('button', { name: /Undo pinning Toast Demo Project/i }).click();

    // Unpinning is not destructive and never asks for confirmation — the Undo is
    // the whole safety net, so it has to actually reach the server.
    await expect.poll(() => writes).toEqual(['POST', 'DELETE']);

    // The toast sits outside the Browse popover, so clicking Undo dismisses it;
    // re-open to confirm the row itself went back to "Pin", not just the network.
    await rail.getByRole('button', { name: 'Browse projects and programs' }).click();
    await expect(rail.getByRole('button', { name: 'Pin Toast Demo Project' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});

/**
 * The two-slot model (#3149, D5–D8).
 *
 * These run in a real browser rather than jsdom because the behaviors under test
 * are geometric (which pill sits lower) and focus-driven (a real focus ring on a
 * real tab stop). The deterministic slot algebra — every row of the eviction
 * table, the coalescing window, the depth-one queue — is pinned in
 * `toastStore.test.ts`; this spec proves the model survives contact with the
 * actual rail.
 */
test.describe('toast slots (#3149)', () => {
  /** Open the Browse switcher and return the rail locator. */
  async function openBrowse(page: import('@playwright/test').Page) {
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await rail.getByRole('button', { name: 'Browse projects and programs' }).click();
    return rail;
  }

  test('the live region is polite and non-atomic, and contains the toasts (D7)', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/pin/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = await openBrowse(page);
    await rail.getByRole('button', { name: 'Pin Toast Demo Project' }).click();

    const pill = page.getByTestId('toast-pill');
    await expect(pill).toBeVisible();

    // Without aria-atomic="false" a re-render of one slot re-reads the other
    // slot's unchanged text. The announcement is a consequence of painting
    // because the region *contains* the pills — nothing is written out of band.
    const region = page.locator('[role="status"][aria-live="polite"]', { has: pill });
    await expect(region).toHaveAttribute('aria-atomic', 'false');

    // The Undo is a real button in the natural tab order, inside that region.
    const undo = region.getByRole('button', { name: /Undo pinning Toast Demo Project/i });
    await expect(undo).toBeVisible();
    await undo.focus();
    await expect(undo).toBeFocused();
  });

  test('a passive toast never displaces an action toast — two slots, action lowest', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/pin/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    // The cap refusal is the passive path: retrying cannot clear a cap.
    await page.route(`**/api/v1/projects/${CAPPED_ID}/pin/`, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify(pinCapReached),
      }),
    );
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = await openBrowse(page);
    await rail.getByRole('button', { name: 'Pin Toast Demo Project' }).click();

    const actionPill = page.locator('[data-toast-slot="action"]');
    await expect(actionPill).toContainText('Pinned Toast Demo Project');

    // A passive arrives while the Undo is still on screen. It takes the other
    // slot; it does not evict the toast the user might still be reaching for.
    await rail.getByRole('button', { name: 'Pin Capped Project One' }).click();
    const transientPill = page.locator('[data-toast-slot="transient"]');
    await expect(transientPill).toContainText(PIN_CAP_MESSAGE);
    await expect(actionPill).toContainText('Pinned Toast Demo Project');
    await expect(actionPill.getByRole('button', { name: /Undo pinning/i })).toBeVisible();
    await expect(page.getByTestId('toast-pill')).toHaveCount(2);

    // The action slot is the LOWER one — nearest the thumb, because it is the
    // only slot holding something to press.
    const transientBox = await transientPill.boundingBox();
    const actionBox = await actionPill.boundingBox();
    expect(transientBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.y).toBeGreaterThan(transientBox!.y);
  });

  test('repeated passives never stack — the cap is structural', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    for (const id of [PROJECT_ID, CAPPED_ID, CAPPED_2_ID]) {
      await page.route(`**/api/v1/projects/${id}/pin/`, (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify(pinCapReached),
        }),
      );
    }
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = await openBrowse(page);
    // Three refusals in a row. Before #3149 this was three pills covering a third
    // of the plan; now it is one — replaced in place, or absorbed with a count.
    for (const name of ['Toast Demo Project', 'Capped Project One', 'Capped Project Two']) {
      await rail.getByRole('button', { name: `Pin ${name}` }).click();
      await expect(page.locator('[data-toast-slot="transient"]')).toContainText(PIN_CAP_MESSAGE);
      await expect(page.getByTestId('toast-pill')).toHaveCount(1);
    }
  });

  test('a toast with focus inside it is neither timed out nor displaced (D8)', async ({ page }) => {
    test.slow(); // deliberately outlives the pin toast's own dwell.
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
    await page.route(`**/api/v1/projects/${PROJECT_ID}/pin/`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    // No `code` in the body, so this is the *actionable* failure (Retry) — the only
    // real-UI path that raises a second action toast from the rail. The refusal is
    // held for 7s on purpose: clicking a control necessarily blurs the toast, so a
    // second toast raised synchronously by a click could never find focus inside the
    // first one. Delaying the response moves the toast's arrival to a moment the
    // test controls, which is also the real shape of the case — a slow write landing
    // while the user is already reaching for the previous Undo.
    await page.route(`**/api/v1/projects/${CAPPED_ID}/pin/`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 7_000));
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'boom' }),
      });
    });
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = await openBrowse(page);
    await rail.getByRole('button', { name: 'Pin Toast Demo Project' }).click();

    const undo = page.getByRole('button', { name: /Undo pinning Toast Demo Project/i });
    await expect(undo).toBeVisible();

    // Start the slow refusal, then put focus inside the toast and leave it there.
    const refusal = page.waitForResponse(
      (r) => r.url().includes(`/projects/${CAPPED_ID}/pin/`) && r.request().method() === 'POST',
    );
    await rail.getByRole('button', { name: 'Pin Capped Project One' }).click();
    await undo.focus();
    await expect(undo).toBeFocused();

    await refusal;

    // Never timed out: the pin toast's own dwell is 6s and more than that has now
    // elapsed. Never displaced: the incoming actionable waits at depth one. Both are
    // asserted off the *response landing* rather than a poll for a count of zero — a
    // poll matches on its first sample and would pass against a build with no queue.
    await expect(undo).toBeVisible();
    await expect(undo).toBeFocused();
    await expect(page.getByText(/Couldn't pin Capped Project One/i)).toHaveCount(0);

    // Leaving is the only way to lose it — and that is when the queued one lands.
    await rail.getByRole('button', { name: 'Browse projects and programs' }).focus();
    await expect(page.getByText(/Couldn't pin Capped Project One/i)).toBeVisible();
  });
});

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

// A standalone project (no `program`) renders in the rail's Tier-3 Browse
// switcher "Projects" list, so its pin control is reachable once the switcher
// is opened, without expanding a program tree.
const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Toast Demo Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

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

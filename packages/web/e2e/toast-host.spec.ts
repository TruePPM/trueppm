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
// switcher "Projects" list, so its ★ pin control is reachable once the switcher
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
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Gate on the rail being rendered before driving its controls.
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // The standalone project's ★ pin control lives in the Tier-3 Browse switcher
    // (#1642); open it, then pin (hover-revealed; Playwright hovers as part of
    // click). Pinning is an app-wide action.
    await rail.getByRole('button', { name: 'Browse projects and programs' }).click();
    const pin = rail.getByRole('button', { name: 'Pin Toast Demo Project' });
    await pin.click();

    // The global toast announces the result bottom-center, politely.
    await expect(page.getByText('Pinned Toast Demo Project')).toBeVisible();
  });
});

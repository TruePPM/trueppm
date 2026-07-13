import { test, expect } from '@playwright/test';
import { setupCatchAll } from './fixtures/api-mocks';

/**
 * Program rail navigation E2E (#1920).
 *
 * The critical proof for #1920: after `ProgramTabs` was removed from the TopBar,
 * the left rail's "This program" tier is the SOLE navigation home for the eight
 * program views. Before this change, backlog/schedule/resources/members/assets
 * had no non-URL entry point on desktop — deleting the tabs without the rail tier
 * would have orphaned them. This spec confirms every program view is reachable
 * via the rail.
 *
 * Two-layer proof:
 *  1. The rail's `Program` nav exposes a link to each of the 8 views with the
 *     correct `/programs/:id/:view` href (deterministic, data-independent).
 *  2. Clicking each rail link actually navigates to that view and the rail stays
 *     present (the persistent home), so no view is a dead end.
 */

const ME_ID = 'user-alice';
const PROGRAM_ID = 'e2e-program-00000000-0000-0000-0000-000000001920';

const FIXTURE_ME = {
  id: ME_ID,
  username: 'alice',
  display_name: 'Alice',
  initials: 'AL',
  email: 'alice@example.com',
  can_access_admin_settings: true,
};

const FIXTURE_PROGRAM = {
  id: PROGRAM_ID,
  server_version: 1,
  name: 'Phase 2 Modernization',
  description: 'Q3 platform rebuild',
  methodology: 'HYBRID',
  effective_methodology: 'HYBRID',
  created_by: ME_ID,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  my_role: 400,
  my_role_label: 'Program Admin',
  project_count: 0,
  member_count: 1,
};

const FIXTURE_ROLLUP = {
  aggregation_policy: 'worst',
  policy_available: true,
  project_count: 0,
  program_health: 'unknown',
  kpis: {},
};

// The eight program views (ADR-0095), in rail order. Each must be reachable.
const PROGRAM_VIEWS = [
  'overview',
  'backlog',
  'projects',
  'schedule',
  'resources',
  'members',
  'assets',
  'settings',
] as const;

type Page = import('@playwright/test').Page;

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          accessToken: 'e2e-token',
          refreshToken: 'e2e-refresh',
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });

  const pj = (data: unknown) => JSON.stringify(data);
  const ok = (data: unknown) => (r: import('@playwright/test').Route) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj(data) });

  await setupCatchAll(page);

  await page.route('**/api/v1/auth/me/', ok(FIXTURE_ME));
  await page.route('**/api/v1/edition/', ok({ edition: 'community' }));
  await page.route('**/api/v1/projects/', ok({ results: [], count: 0, next: null, previous: null }));
  await page.route('**/api/v1/me/work/**', ok({ results: [], due_today_count: 0 }));
  await page.route('**/api/v1/programs/', ok({ results: [FIXTURE_PROGRAM], count: 1, next: null, previous: null }));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/`, ok(FIXTURE_PROGRAM));

  // Each program-view page's primary read, mocked to a benign empty/200 shape so
  // the view renders its real (empty-state) content rather than 404-ing into the
  // shell-preserving error boundary.
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/rollup/`, ok(FIXTURE_ROLLUP));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/projects/`, ok([]));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/backlog-items/**`, ok([]));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/members/**`, ok([]));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/schedule/`, ok({ lanes: [], tasks: [] }));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/resource-contention/**`, ok({ resources: [] }));
  await page.route(`**/api/v1/programs/${PROGRAM_ID}/assets/`, ok({ results: [], count: 0, next: null, previous: null }));
  await page.route('**/api/v1/ws/ticket/', ok({ ticket: 'e2e' }));
}

test.describe('Program views are reachable via the rail (#1920)', () => {
  test('the "This program" rail tier exposes every program view with the right href', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    // The rail's Program nav is the relocated home (was ProgramTabs in the TopBar).
    const nav = page.getByRole('navigation', { name: 'Program' });
    await expect(nav).toBeVisible();

    // Every one of the eight views has a link pointing at its own route segment.
    for (const view of PROGRAM_VIEWS) {
      const link = nav.getByRole('link', { name: new RegExp(`^${view}$`, 'i') });
      await expect(link).toHaveAttribute('href', `/programs/${PROGRAM_ID}/${view}`);
    }
  });

  test('clicking each rail link navigates to that view — no orphaned views', async ({ page }) => {
    await setup(page);
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    const nav = page.getByRole('navigation', { name: 'Program' });
    await expect(nav).toBeVisible();

    for (const view of PROGRAM_VIEWS) {
      await nav.getByRole('link', { name: new RegExp(`^${view}$`, 'i') }).click();
      await page.waitForURL(`**/programs/${PROGRAM_ID}/${view}`);
      // The rail (and its Program nav) persists across every jump — it is the
      // durable navigation home, not a per-page control.
      await expect(page.getByRole('navigation', { name: 'Program' })).toBeVisible();
      // The clicked view reads as the current page (NavLink aria-current).
      await expect(
        page.getByRole('navigation', { name: 'Program' }).getByRole('link', {
          name: new RegExp(`^${view}$`, 'i'),
        }),
      ).toHaveAttribute('aria-current', 'page');
    }
  });
});

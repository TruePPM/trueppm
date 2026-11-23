import { test, expect, type Page } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * Shell v2 role homes (#4755, ADR-1298 amendment).
 *
 * The server resolves `landing.home`; with `shell_v2` on, `/` goes to `/home`,
 * which renders that home's surface in place. With the flag off, `/` keeps the
 * v1 `landing.path` and a typed `/home` replace-redirects to it.
 */

const GID = 'e2e-home-00000000-0000-0000-0000-000000004755';

type Home = 'contributor' | 'pm' | 'rm' | 'exec';

const pj = (v: unknown) => JSON.stringify(v);

async function setup(page: Page, home: Home, opts: { flag: boolean }): Promise<void> {
  await page.addInitScript((flag: boolean) => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    if (flag) localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  }, opts.flag);
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: '7',
        username: 'casey',
        display_name: 'Casey',
        initials: 'C',
        email: 'casey@example.com',
        // The exec home is the Viewer-only branch, so its user is a Viewer (1).
        max_project_role: home === 'exec' ? 1 : 100,
        workspace_role: null,
        can_access_admin_settings: false,
        default_landing: 'auto',
        landing: {
          intent: 'my_work',
          path: '/me/work',
          resolved_by: 'role_policy',
          home,
          home_program: home === 'exec' ? { id: GID, code: 'EX', name: 'Exec Program' } : null,
        },
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  // The RM home (#4770) reads the people-load owner; the catch-all's list shape is
  // not this object, so it gets its real (empty) shape.
  await page.route('**/api/v1/me/people-load/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        as_of: '2026-03-02T09:00:00Z',
        window: { start: '2026-03-02', end: '2026-04-26' },
        weeks: [],
        scope: { project_count: 0, withheld_project_count: 0, program_id: null },
        people: [],
        over_allocated_count: 0,
        reason: 'no_projects',
        definitions: { load_pct: 'Load.', over_allocated_count: 'Over.' },
      }),
    }),
  );
  // `home_program` only ever names a program the user is a member of (the
  // rollup is members-only), so the program reads back with the user's role.
  await page.route(`**/api/v1/programs/${GID}/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: GID,
        name: 'Exec Program',
        description: '',
        my_role: 1,
        project_count: 0,
        color: null,
        code: 'EX',
        server_version: 1,
      }),
    }),
  );
  // ProgramOverviewPage does `Object.entries(rollup.kpis)`: the catch-all's list
  // shape would crash it, so the object endpoint gets its real shape.
  await page.route(`**/api/v1/programs/${GID}/rollup/`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        aggregation_policy: 'worst',
        policy_available: true,
        project_count: 0,
        program_health: 'unknown',
        kpis: {},
      }),
    }),
  );
  // The PM and exec homes read the program list, the roster, the health summary and
  // the awaiting decisions: real shapes, never the catch-all's list shape.
  await page.route('**/api/v1/programs/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: 1,
        next: null,
        previous: null,
        results: [{ id: GID, name: 'Exec Program', code: 'EX', my_role: 1 }],
      }),
    }),
  );
  await page.route(`**/api/v1/programs/${GID}/projects/`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route('**/api/v1/me/work/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        count: 0,
        next: null,
        previous: null,
        results: [],
        due_today_count: 0,
        active_sprints: [],
        retro_action_items: [],
        external_items: [],
        external_sources: [],
      }),
    }),
  );
  await page.route('**/api/v1/projects/health-summary/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj([]) }),
  );
  await page.route(`**/api/v1/programs/${GID}/decisions/**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
}

test.describe('shell v2 role homes (flag on)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  // Each home's "rendered" signal: something only that home has — My Work's
  // landmark (its h1 is a time-based greeting), the program forecast hero, the
  // Team load h1.
  const cases: Array<[Home, (page: Page) => ReturnType<Page['getByRole']>]> = [
    ['contributor', (p) => p.getByRole('region', { name: 'My Work', exact: true })],
    ['pm', (p) => p.getByRole('heading', { name: 'Forecast · Exec Program' })],
    ['rm', (p) => p.getByRole('heading', { level: 1, name: 'Team load' })],
    ['exec', (p) => p.getByRole('heading', { name: 'Forecast · Exec Program' })],
  ];

  for (const [home, rendered] of cases) {
    test(`${home}: / lands on /home and renders that home's surface`, async ({ page }) => {
      await setup(page, home, { flag: true });
      await page.goto('/');
      await expect(page).toHaveURL(/\/home$/);
      await expect(rendered(page).first()).toBeVisible();
      // The v1 Programs list is no longer any home's surface.
      await expect(page.getByRole('heading', { level: 1, name: 'Programs' })).toHaveCount(0);
      const destinations = page.getByRole('navigation', { name: 'Destinations' });
      await expect(destinations.getByRole('link', { name: /Home/ })).toHaveAttribute(
        'aria-current',
        /true|page/,
      );
    });
  }
});

test.describe('shell v2 role homes (flag off)', () => {
  test('/ keeps the v1 landing.path', async ({ page }) => {
    await setup(page, 'pm', { flag: false });
    await page.goto('/');
    await expect(page).toHaveURL(/\/me\/work$/);
  });

  test('a typed /home replace-redirects to landing.path', async ({ page }) => {
    await setup(page, 'pm', { flag: false });
    await page.goto('/home');
    await expect(page).toHaveURL(/\/me\/work$/);
  });
});

import { test, expect, type Page } from './fixtures/coverage';
import { expectNoA11yViolations, setupCatchAll } from './fixtures';

/**
 * Shell v2 People destination and Resource Manager home (#4761, #4770, #4777).
 *
 * Rail People lands on the capacity heat map, roster second. The RM home renders
 * the same `LoadHeatMap` from the same `GET /me/people-load/` payload. Every
 * figure is the server's; the page bins it for color and draws ▲ on over cells.
 */

const pj = (v: unknown) => JSON.stringify(v);

const DEFINITION = 'Load = booked ÷ capacity, time off removed: a person’s booked days in a week.';

const LOAD = {
  as_of: '2026-03-02T09:00:00Z',
  window: { start: '2026-03-02', end: '2026-03-15' },
  weeks: ['2026-03-02', '2026-03-09'],
  scope: { project_count: 2, withheld_project_count: 0, program_id: null },
  people: [
    {
      resource_id: '00000000-0000-0000-0000-0000000000a1',
      name: 'Alice Lee',
      initials: 'AL',
      job_role: 'Engineer',
      overallocated: true,
      peak_load_pct: 120,
      project_count: 2,
      cells: [
        { week_start: '2026-03-02', load_pct: 120, overallocated: true, reason: null },
        { week_start: '2026-03-09', load_pct: 45, overallocated: false, reason: null },
      ],
    },
    {
      resource_id: '00000000-0000-0000-0000-0000000000b2',
      name: 'Bo Park',
      initials: 'BP',
      job_role: '',
      overallocated: false,
      peak_load_pct: 30,
      project_count: 1,
      cells: [
        { week_start: '2026-03-02', load_pct: null, overallocated: false, reason: 'no_capacity' },
        { week_start: '2026-03-09', load_pct: 30, overallocated: false, reason: null },
      ],
    },
  ],
  over_allocated_count: 1,
  reason: null,
  definitions: { load_pct: DEFINITION, over_allocated_count: 'People over 100%.' },
};

const EMPTY = { ...LOAD, people: [], over_allocated_count: 0, reason: 'no_projects' };

async function setup(
  page: Page,
  opts: { home?: 'rm' | 'contributor'; load?: unknown; status?: number },
) {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
        version: 0,
      }),
    );
    localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
  });
  await setupCatchAll(page);
  await page.route('**/api/v1/auth/me/', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: pj({
        id: '7',
        username: 'dana',
        display_name: 'Dana',
        initials: 'D',
        email: 'dana@example.com',
        max_project_role: 200,
        workspace_role: null,
        can_access_admin_settings: false,
        default_landing: 'auto',
        landing: {
          intent: 'my_work',
          path: '/me/work',
          resolved_by: 'role_policy',
          home: opts.home ?? 'contributor',
          home_program: null,
        },
      }),
    }),
  );
  await page.route('**/api/v1/edition/', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: pj({ edition: 'community' }) }),
  );
  await page.route('**/api/v1/me/people-load/**', (r) =>
    r.fulfill({
      status: opts.status ?? 200,
      contentType: 'application/json',
      body: pj(opts.status && opts.status >= 400 ? { detail: 'boom' } : (opts.load ?? LOAD)),
    }),
  );
}

test.describe('shell v2 People destination', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('rail People lands on the capacity heat map, roster reachable as Directory', async ({
    page,
  }, testInfo) => {
    await setup(page, {});
    await page.goto('/home');
    const destinations = page.getByRole('navigation', { name: 'Destinations' });
    await destinations.getByRole('link', { name: /People/ }).click();

    await expect(page).toHaveURL(/\/people$/);
    const grid = page.getByRole('grid', { name: 'Load by person and week' });
    await expect(grid).toBeVisible();
    await expect(destinations.getByRole('link', { name: /People/ })).toHaveAttribute(
      'aria-current',
      /true|page/,
    );
    await expect(page.getByRole('tab', { name: 'Capacity' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // The server's over-capacity count, with the glyph.
    await expect(page.getByTestId('overalloc-banner')).toHaveText(/1 person over capacity/);
    // ▲ on the over cell as well as color; a week off is a dash, not 0%.
    const over = grid.getByRole('gridcell', { name: /Alice Lee, .*120% load, over-allocated/ });
    await expect(over).toContainText('▲');
    await expect(grid.getByRole('gridcell', { name: /Bo Park, .*no working time/ })).toHaveText(
      '–',
    );
    // The definition line is the server's sentence.
    await expect(page.getByText(DEFINITION)).toBeVisible();

    // Keyboard: the grid has one tab stop and arrows move within it.
    await over.click();
    await page.keyboard.press('ArrowRight');
    await expect(grid.getByRole('gridcell', { name: /Alice Lee, .*45% load$/ })).toBeFocused();

    await expectNoA11yViolations(page, testInfo);

    await page.getByRole('tab', { name: 'Directory' }).click();
    await expect(page).toHaveURL(/\/people\?view=directory$/);
    await expect(page.getByRole('tabpanel')).toBeVisible();
  });

  test('empty range says so, with no upsell', async ({ page }) => {
    await setup(page, { load: EMPTY });
    await page.goto('/people');
    await expect(page.getByText('No bookings in this range')).toBeVisible();
    await expect(page.getByText(/enterprise|upgrade/i)).toHaveCount(0);
    await expect(page.getByTestId('overalloc-banner')).toHaveCount(0);
  });
});

test.describe('shell v2 People destination, dark theme', () => {
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });

  test('cells and legend stay readable (axe) in dark mode', async ({ page }, testInfo) => {
    await setup(page, {});
    await page.goto('/people');
    await expect(page.getByRole('grid', { name: 'Load by person and week' })).toBeVisible();
    await expectNoA11yViolations(page, testInfo);
  });
});

test.describe('shell v2 People destination, phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('rows are 44px targets and the page does not scroll sideways', async ({ page }) => {
    await setup(page, {});
    await page.goto('/people');
    const cell = page.getByRole('gridcell').first();
    await expect(cell).toBeVisible();
    const box = await cell.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('shell v2 Resource Manager home', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('home = rm renders team load from the same payload', async ({ page }) => {
    await setup(page, { home: 'rm' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { level: 1, name: 'Team load' })).toBeVisible();
    await expect(page.getByText('2 people · 2 projects')).toBeVisible();
    const grid = page.getByRole('grid', { name: 'Team load by person and week' });
    await expect(grid.getByRole('gridcell', { name: /Alice Lee, .*120% load/ })).toContainText('▲');
    await page.getByRole('link', { name: 'Open People' }).click();
    await expect(page).toHaveURL(/\/people$/);
  });

  test('a failed load read is retryable', async ({ page }) => {
    await setup(page, { home: 'rm', status: 500 });
    await page.goto('/home');
    const message = page.getByText("Couldn't load team load.");
    await expect(message).toBeVisible();
    // Scoped to the error region (#3516): the retry sits beside its own message.
    const region = page.locator('div', { has: message }).last();
    await expect(region.getByRole('button', { name: /retry/i })).toBeVisible();
  });
});

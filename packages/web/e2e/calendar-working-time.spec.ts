import { test, expect, type Page } from './fixtures/coverage';
import { setupApiMocks, setupAuth, setupCatchAll } from './fixtures';

/**
 * The Calendar grid's non-working days come from the project's effective calendar.
 *
 * The fixture project works Sun-Thu, the case a column-position rule gets exactly
 * backwards: it would mute Sat/Sun and draw Fri as a normal working column. The
 * preview mock reproduces the server's real shape for an inherited base too, where
 * it evaluates no base calendar and reports every unblocked day as working.
 */

const PROJECT_ID = 'e2e-calwt-0000-0000-0000-000000003239';
const SUN_THU = 64 + 1 + 2 + 4 + 8;
// 2026-12-16 is a Wednesday, so its Sunday-first week is Dec 13-19.
const url = (view: string, anchor = '2026-12-16') =>
  `/projects/${PROJECT_ID}/calendar?calAnchor=${anchor}&calView=${view}`;

const BASE_CALENDAR = {
  id: 'cal-base',
  server_version: 1,
  name: 'Gulf Office',
  working_days: SUN_THU,
  hours_per_day: 8,
  timezone: 'UTC',
  exceptions: [
    { id: 'x-1', exc_start: '2026-12-15', exc_end: '2026-12-15', description: 'Founders Day' },
  ],
};

const SHUTDOWN_CALENDAR = {
  id: 'cal-shutdown',
  server_version: 1,
  name: 'Workspace Closures',
  working_days: 127,
  hours_per_day: 8,
  timezone: 'UTC',
  exceptions: [
    { id: 'x-2', exc_start: '2026-12-24', exc_end: '2026-12-31', description: 'Year-end shutdown' },
  ],
};

const effectiveCalendar = (holidayCount: number) => ({
  id: BASE_CALENDAR.id,
  name: BASE_CALENDAR.name,
  working_days: SUN_THU,
  hours_per_day: 8,
  timezone: 'UTC',
  holiday_count: holidayCount,
});

const task = {
  id: 'wt-task-1',
  wbs_path: '1.1',
  name: 'Fit-out',
  early_start: '2026-12-13',
  early_finish: '2026-12-17',
  planned_start: '2026-12-13',
  duration: 5,
  percent_complete: 0,
  is_critical: false,
  status: 'NOT_STARTED',
  is_milestone: false,
  is_summary: false,
  parent_id: null,
  actual_start: null,
  actual_finish: null,
  assignments: [],
};

async function setup(
  page: Page,
  source: 'project' | 'workspace' | 'system_default',
  holidayCount: number,
  effective: ReturnType<typeof effectiveCalendar> | null = effectiveCalendar(holidayCount),
) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projectId: PROJECT_ID,
    projects: [
      {
        id: PROJECT_ID,
        name: 'Gulf Fit-out',
        start_date: '2026-12-01',
        effective_calendar: effective,
        calendar_source: source,
      },
    ],
    tasks: [task],
  });
}

/**
 * Serve the applied stack, and a preview that blocks only what `blockedBy` names.
 * Returns a count of preview requests, which only a failed applied read should make.
 */
async function mockCalendarReads(
  page: Page,
  applied: { base: typeof BASE_CALENDAR | null; overlays: unknown[] },
  blockedBy: (iso: string) => { role: string; calendar_id: string; name: string }[] = () => [],
) {
  let previewRequests = 0;
  await page.route('**/api/v1/projects/*/calendars/preview/**', async (route) => {
    previewRequests += 1;
    const params = new URL(route.request().url()).searchParams;
    const start = params.get('start') ?? '';
    const end = params.get('end') ?? '';
    const days = [];
    for (
      let t = Date.parse(`${start}T00:00:00Z`);
      t <= Date.parse(`${end}T00:00:00Z`);
      t += 86_400_000
    ) {
      const date = new Date(t).toISOString().slice(0, 10);
      const sources = blockedBy(date);
      days.push({ date, working: sources.length === 0, sources });
    }
    await route.fulfill({ json: { start, end, days } });
  });
  await page.route('**/api/v1/projects/*/calendars/', async (route) => {
    await route.fulfill({ json: { ...applied, applied: applied.overlays } });
  });
  return () => previewRequests;
}

test.describe('Calendar working time', () => {
  test('golden path: a Sun-Thu project renders its own non-working columns', async ({ page }) => {
    await setup(page, 'project', 1);
    const previewRequests = await mockCalendarReads(page, { base: BASE_CALENDAR, overlays: [] });

    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 13 – 19, 2026' })).toBeVisible({
      timeout: 10_000,
    });

    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid.getByRole('columnheader').first()).toHaveAccessibleName('Sunday');
    await expect(grid.getByRole('columnheader').last()).toHaveAccessibleName('Saturday');

    const cells = grid.getByRole('gridcell');
    await expect(cells).toHaveCount(7);
    // In column order, Sunday first: this is the full non-working reading of the week.
    await expect(cells.nth(0)).toHaveAccessibleName('Sunday, December 13, 2026');
    await expect(cells.nth(1)).toHaveAccessibleName('Monday, December 14, 2026');
    await expect(cells.nth(2)).toHaveAccessibleName(
      'Tuesday, December 15, 2026, Founders Day, Gulf Office, non-working day',
    );
    await expect(cells.nth(3)).toHaveAccessibleName('Wednesday, December 16, 2026');
    await expect(cells.nth(4)).toHaveAccessibleName('Thursday, December 17, 2026');
    await expect(cells.nth(5)).toHaveAccessibleName(
      'Friday, December 18, 2026, Gulf Office, non-working day',
    );
    await expect(cells.nth(6)).toHaveAccessibleName(
      'Saturday, December 19, 2026, Gulf Office, non-working day',
    );

    // A holiday states its name on screen; an ordinary non-working day does not.
    await expect(cells.nth(2)).toContainText('Founders Day');
    await expect(cells.nth(5)).not.toContainText('Founders Day');
    // The chip starts in the first column, on the Sunday this calendar works.
    await expect(cells.nth(0).getByRole('button', { name: /^Fit-out,/ })).toBeVisible();
    expect(previewRequests()).toBe(0);
  });

  test('a shutdown overlay reads as a shutdown, across every day it covers', async ({ page }) => {
    await setup(page, 'project', 0);
    await mockCalendarReads(page, {
      base: { ...BASE_CALENDAR, exceptions: [] },
      overlays: [
        { layer_id: 'l-1', role: 'workspace', sort_order: 1, calendar: SHUTDOWN_CALENDAR },
      ],
    });

    await page.goto(url('month'));
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await expect(grid.getByText('Year-end shutdown')).toHaveCount(8);
    // Friday the 25th is non-working twice over and still reads as the shutdown.
    await expect(
      grid.getByRole('gridcell', {
        name: 'Friday, December 25, 2026, Year-end shutdown, Workspace Closures, Gulf Office, non-working day',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Calendar legend' }).getByText('Shutdown'),
    ).toBeVisible();
  });

  test('an overlay that narrows the working week moves the first column', async ({ page }) => {
    await setup(page, 'project', 0);
    await mockCalendarReads(
      page,
      {
        base: { ...BASE_CALENDAR, exceptions: [] },
        overlays: [
          {
            layer_id: 'l-1',
            role: 'holidays',
            sort_order: 1,
            calendar: {
              ...SHUTDOWN_CALENDAR,
              name: 'UK Holidays',
              working_days: 31,
              exceptions: [],
            },
          },
        ],
      },
      () => [],
    );

    await page.goto(url('week'));
    // Sun-Thu AND Mon-Fri leaves Mon-Thu, so the week opens on Monday, not a blocked Sunday.
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 14 – 20, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid.getByRole('columnheader').first()).toHaveAccessibleName('Monday');
    await expect(
      grid.getByRole('gridcell', {
        name: 'Sunday, December 20, 2026, UK Holidays, non-working day',
        exact: true,
      }),
    ).toBeVisible();
  });

  test('no base calendar: a seven-day overlay alone decides, so the weekend works', async ({
    page,
  }) => {
    await setup(page, 'system_default', 0, null);
    await mockCalendarReads(page, {
      base: null,
      overlays: [
        {
          layer_id: 'l-1',
          role: 'holidays',
          sort_order: 1,
          calendar: { ...SHUTDOWN_CALENDAR, name: 'Every Day', working_days: 127, exceptions: [] },
        },
      ],
    });

    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 14 – 20, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const cells = page.getByRole('grid', { name: 'Calendar dates' }).getByRole('gridcell');
    await expect(cells.nth(5)).toHaveAccessibleName('Saturday, December 19, 2026');
    await expect(cells.nth(6)).toHaveAccessibleName('Sunday, December 20, 2026');
  });

  test('no base calendar: a Sun-Thu overlay alone opens the week on Sunday', async ({ page }) => {
    await setup(page, 'system_default', 0, null);
    await mockCalendarReads(page, {
      base: null,
      overlays: [
        {
          layer_id: 'l-1',
          role: 'holidays',
          sort_order: 1,
          calendar: {
            ...SHUTDOWN_CALENDAR,
            name: 'Gulf Holidays',
            working_days: SUN_THU,
            exceptions: [],
          },
        },
      ],
    });

    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 13 – 19, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const cells = page.getByRole('grid', { name: 'Calendar dates' }).getByRole('gridcell');
    await expect(cells.nth(0)).toHaveAccessibleName('Sunday, December 13, 2026');
    await expect(cells.nth(5)).toHaveAccessibleName(
      'Friday, December 18, 2026, Gulf Holidays, non-working day',
    );
  });

  test('a workspace lock: a stale override reaches neither the grid nor a preview read', async ({
    page,
  }) => {
    const staleOverride = {
      ...BASE_CALENDAR,
      name: 'Stale Override',
      working_days: 15,
      exceptions: [],
    };
    await setup(page, 'workspace', 0, {
      ...effectiveCalendar(0),
      name: 'Workspace Standard',
      working_days: 31,
    });
    // The server's preview evaluates the override, so it would block every Friday.
    const previewRequests = await mockCalendarReads(
      page,
      { base: staleOverride, overlays: [] },
      (iso) =>
        new Date(`${iso}T00:00:00Z`).getUTCDay() === 5
          ? [{ role: 'project', calendar_id: staleOverride.id, name: staleOverride.name }]
          : [],
    );

    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 14 – 20, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const cells = page.getByRole('grid', { name: 'Calendar dates' }).getByRole('gridcell');
    await expect(cells.nth(4)).toHaveAccessibleName('Friday, December 18, 2026');
    await expect(cells.nth(4)).not.toContainText('Stale Override');
    expect(previewRequests()).toBe(0);
  });

  test('error: a failed applied read falls back to the preview and says so', async ({ page }) => {
    await setup(page, 'project', 1);
    const previewRequests = await mockCalendarReads(page, { base: null, overlays: [] }, (iso) =>
      iso === '2026-12-15'
        ? [{ role: 'workspace', calendar_id: 'c-1', name: 'Workspace Closures' }]
        : [],
    );
    await page.route('**/api/v1/projects/*/calendars/', (route) =>
      route.fulfill({ status: 500, json: { detail: 'calendar service unavailable' } }),
    );

    await page.goto(url('week'));
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Couldn't load this project's full working calendar/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      grid.getByRole('gridcell', {
        name: 'Tuesday, December 15, 2026, Workspace Closures, non-working day',
        exact: true,
      }),
    ).toBeVisible();
    expect(previewRequests()).toBeGreaterThan(0);
  });

  test('an inherited base still applies though the preview cannot see it', async ({ page }) => {
    await setup(page, 'workspace', 1);
    // No override and no overlays: the server's preview reports every day working.
    await mockCalendarReads(page, { base: null, overlays: [] }, () => []);
    await page.route(`**/api/v1/calendars/${BASE_CALENDAR.id}/`, async (route) => {
      await route.fulfill({ json: BASE_CALENDAR });
    });

    await page.goto(url('week'));
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid).toBeVisible({ timeout: 10_000 });
    await expect(
      grid.getByRole('gridcell', {
        name: 'Saturday, December 19, 2026, Gulf Office, non-working day',
      }),
    ).toBeVisible();
    await expect(
      grid.getByRole('gridcell', {
        name: 'Tuesday, December 15, 2026, Founders Day, Gulf Office, non-working day',
      }),
    ).toBeVisible();
  });

  test('error: failed reads keep the weekly pattern and say holidays are missing', async ({
    page,
  }) => {
    await setup(page, 'project', 1);
    const fail = { status: 500, json: { detail: 'calendar service unavailable' } };
    await page.route('**/api/v1/projects/*/calendars/preview/**', (route) => route.fulfill(fail));
    await page.route('**/api/v1/projects/*/calendars/', (route) => route.fulfill(fail));

    await page.goto(url('week'));
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid).toBeVisible({ timeout: 10_000 });

    await expect(grid.getByRole('columnheader').first()).toHaveAccessibleName('Sunday');
    await expect(
      grid.getByRole('gridcell', {
        name: 'Friday, December 18, 2026, Gulf Office, non-working day',
      }),
    ).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Fit-out,/ })).toBeVisible();
    await expect(page.getByText(/Couldn't load this project's full working calendar/)).toBeVisible({
      timeout: 20_000,
    });
  });

  test('error: a failed project read draws the default week and says so', async ({ page }) => {
    await setup(page, 'project', 0);
    await mockCalendarReads(page, { base: null, overlays: [] }, () => []);
    await page.route(`**/api/v1/projects/${PROJECT_ID}/`, (route) =>
      route.fulfill({ status: 500, json: { detail: 'project service unavailable' } }),
    );

    await page.goto(url('week'));
    await expect(page.getByText(/Couldn't load this project's full working calendar/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole('grid', { name: 'Calendar dates' }).getByRole('columnheader').first(),
    ).toHaveAccessibleName('Monday');
  });

  test('empty: a project with no resolved calendar stays Monday-first on Mon-Fri', async ({
    page,
  }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projectId: PROJECT_ID,
      projects: [{ id: PROJECT_ID, name: 'Default', start_date: '2026-12-01' }],
      tasks: [task],
    });
    await mockCalendarReads(page, { base: null, overlays: [] }, () => []);

    await page.goto(url('week'));
    await expect(page.getByRole('heading', { level: 2, name: 'Dec 14 – 20, 2026' })).toBeVisible({
      timeout: 10_000,
    });
    const grid = page.getByRole('grid', { name: 'Calendar dates' });
    await expect(grid.getByRole('columnheader').first()).toHaveAccessibleName('Monday');
    await expect(
      grid.getByRole('gridcell', {
        name: 'Saturday, December 19, 2026, non-working day',
      }),
    ).toBeVisible();
    await expect(
      grid.getByRole('gridcell', { name: 'Friday, December 18, 2026', exact: true }),
    ).toBeVisible();
  });
});

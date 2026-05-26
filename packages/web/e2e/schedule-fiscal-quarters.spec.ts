/**
 * E2E for the Schedule timeline fiscal/calendar quarter toggle (#755).
 *
 * The canvas header itself can't be pixel-asserted in Playwright, so these
 * specs drive the QuarterModeControl: it appears only at quarter zoom for a
 * non-January fiscal workspace, switches mode, and persists the choice.
 */
import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000755';

const FIXTURE_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Fiscal Timeline Task',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function gotoSchedule(page: Page, fiscalMonth: number) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: FIXTURE_PROJECT_ID,
        name: 'Fiscal Timeline',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  // Per-spec workspace mock (setupApiMocks doesn't cover /workspace/) — last
  // registered wins over the catch-all.
  await page.route('**/api/v1/workspace/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: 'Fiscal Co',
        subdomain: 'fiscal',
        timezone: 'UTC',
        fiscal_year_start_month: fiscalMonth,
        fiscal_year_start_day: 1,
        fiscal_year_start_display: 'April 1',
        work_week: [true, true, true, true, true, false, false],
        default_project_view: 'Board',
        allow_guests: true,
        public_sharing: false,
      }),
    }),
  );
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 15_000 });
}

function zoomToQuarter(page: Page) {
  return page
    .getByRole('group', { name: 'Timeline zoom' })
    .getByRole('button', { name: 'Quarter' })
    .click();
}

test.describe('Schedule fiscal quarter toggle (#755)', () => {
  test('appears at quarter zoom for an April fiscal year and switches to Calendar', async ({
    page,
  }) => {
    await gotoSchedule(page, 4);

    // Hidden until the user zooms to quarter.
    await expect(page.getByRole('button', { name: /quarters:/i })).toHaveCount(0);

    await zoomToQuarter(page);

    const trigger = page.getByRole('button', { name: /quarters: fiscal/i });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.getByText(/starts April \(workspace\)/i)).toBeVisible();

    await page.getByRole('menuitemradio', { name: /calendar/i }).click();
    await expect(page.getByRole('button', { name: /quarters: calendar/i })).toBeVisible();

    // Choice persists across a reload (localStorage-backed view pref).
    await page.reload();
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 15_000 });
    await zoomToQuarter(page);
    await expect(page.getByRole('button', { name: /quarters: calendar/i })).toBeVisible();
  });

  test('stays hidden for a January (calendar-aligned) fiscal year', async ({ page }) => {
    await gotoSchedule(page, 1);
    await zoomToQuarter(page);
    await expect(page.getByRole('button', { name: /quarters:/i })).toHaveCount(0);
  });
});

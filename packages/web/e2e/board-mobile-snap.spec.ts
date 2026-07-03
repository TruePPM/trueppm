/**
 * Mobile board snap-scroll + dot-strip E2E (issue #853, v3 design case 8).
 *
 * On a phone the phase × status grid can't show four columns, so each status
 * column becomes a full-width snap-scroll page with a dot-strip nav above. This
 * spec runs at a phone viewport (375×812) — the desktop layout (and every other
 * board spec, which run at the default Desktop Chrome viewport) is unaffected
 * because the reflow is gated behind `isMobile` (matchMedia `max-width: 767px`).
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-mboard-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Mobile Board Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

// One summary phase + leaf cards spread across the status axis so each column
// has a non-zero count for the strip, plus one COMPLETE (Done) card.
const FIXTURE_TASKS = [
  {
    id: 'mb1', wbs_path: '1', name: 'Build Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 40, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mb2', wbs_path: '1.1', name: 'Spec the API',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10, percent_complete: 0, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'mb1',
    status: 'NOT_STARTED', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mb3', wbs_path: '1.2', name: 'Wire the endpoint',
    early_start: '2026-01-19', early_finish: '2026-01-30',
    planned_start: '2026-01-19',
    duration: 10, percent_complete: 55, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'mb1',
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mb4', wbs_path: '1.3', name: 'Review the PR',
    early_start: '2026-02-01', early_finish: '2026-02-05',
    planned_start: '2026-02-01',
    duration: 5, percent_complete: 90, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'mb1',
    status: 'REVIEW', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mb5', wbs_path: '1.4', name: 'Ship it',
    early_start: '2026-01-05', early_finish: '2026-01-20',
    planned_start: '2026-01-05',
    duration: 12, percent_complete: 100, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'mb1',
    status: 'COMPLETE', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 4 },
  });
}

test.describe('Board mobile snap-scroll', () => {
  test.beforeEach(async ({ page }) => {
    // Phone viewport — trips the board's `isMobile` matchMedia gate.
    await page.setViewportSize({ width: 375, height: 812 });
    // Since issue 605 a phone with no explicit layout preference auto-defaults
    // to the Queue layout; the snap board only renders under an explicit rail /
    // drawer choice. Seed an explicit rail pref so this spec exercises the snap
    // board (the auto-Queue path is covered by board-mobile-fab.spec.ts).
    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm.board.toolbarPrefs.v1',
        JSON.stringify({ layout: 'rail', backlogDensity: 'comfortable' }),
      );
    });
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
  });

  test('renders the dot-strip with first-word column names and counts', async ({ page }) => {
    const strip = page.getByTestId('mobile-column-strip');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    // One labelled segment per visible status column (To Do / In Progress /
    // Review / Done — BACKLOG is in the band, not the column set).
    await expect(strip.getByRole('button', { name: 'To Do, 1 task' })).toBeVisible();
    await expect(strip.getByRole('button', { name: 'In Progress, 1 task' })).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Review, 1 task' })).toBeVisible();
    await expect(strip.getByRole('button', { name: 'Done, 1 task' })).toBeVisible();
  });

  test('columns are full-width snap pages', async ({ page }) => {
    const scroller = page.getByTestId('mobile-board-scroller');
    await expect(scroller).toBeVisible({ timeout: 10_000 });

    // Native CSS snap on the scroller; each column page is snap-aligned.
    await expect(scroller).toHaveCSS('scroll-snap-type', 'x mandatory');
    const firstColumn = scroller.locator('[data-mobile-column="true"]').first();
    await expect(firstColumn).toHaveCSS('scroll-snap-align', 'start');

    // Four status columns rendered as pages.
    await expect(scroller.locator('[data-mobile-column="true"]')).toHaveCount(4);
  });

  test('tapping a strip segment jumps to that column', async ({ page }) => {
    const strip = page.getByTestId('mobile-column-strip');
    await expect(strip).toBeVisible({ timeout: 10_000 });

    const doneSegment = strip.getByRole('button', { name: 'Done, 1 task' });
    await doneSegment.click();

    // After the jump, the Done column page is scrolled into view — its
    // COMPLETE card ("Ship it") is the one on screen.
    const doneColumn = page.locator('[data-mobile-column="true"][data-status="COMPLETE"]');
    await expect(doneColumn.getByText('Ship it')).toBeInViewport({ timeout: 5_000 });
    // And the strip marks Done active (aria-current is the non-color signal).
    await expect(doneSegment).toHaveAttribute('aria-current', 'true');
  });

  test('card anatomy carries over — a card opens its popover on tap', async ({ page }) => {
    const inProgColumn = page.locator('[data-mobile-column="true"][data-status="IN_PROGRESS"]');
    await expect(inProgColumn.getByText('Wire the endpoint')).toBeVisible({ timeout: 10_000 });
    await inProgColumn.getByText('Wire the endpoint').click();
    // The card-click popover (issue #304) is reused unchanged on mobile.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });
});

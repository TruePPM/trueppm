/**
 * Mobile board-card readability — coarse-pointer tap-to-peek (#1947, web-rule 256).
 *
 * On a phone the board forces compact density (rule 193). At compact density the
 * card's worst-offender health badge is glyph-only (its word lives in an
 * `aria-label`) and a long title truncates — both hover-only channels that a
 * touch user cannot reach. This spec verifies the two promoted affordances:
 *   1. the health badge becomes a tap-to-peek button revealing the full sentence;
 *   2. an overflowing title grows an end-of-title disclosure glyph that peeks the
 *      full name, and the closed peek is portaled so the card's height is unchanged.
 *
 * Runs at a phone viewport with touch, so `(pointer: coarse)` matches and
 * `useIsCoarsePointer()` reports true. Desktop specs run at Desktop Chrome
 * (fine pointer) and see today's exact DOM — the promotion is gated off there.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const FIXTURE_PROJECT_ID = 'e2e-mread-0000-0000-0000-000000000010';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Mobile Readability Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const LONG_NAME =
  'Implement the cross-team authentication and authorization reconciliation service';

// A summary phase + two leaf cards in the To Do column: one on the critical path
// (glyph-only health badge) and one with a very long name (truncates on the bar).
const FIXTURE_TASKS = [
  {
    id: 'mr1', wbs_path: '1', name: 'Delivery Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 20, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mr2', wbs_path: '1.1', name: 'Critical setup task',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10, percent_complete: 0, is_critical: true,
    is_milestone: false, is_summary: false, parent_id: 'mr1',
    status: 'NOT_STARTED', assignees: [], total_float: 0,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'mr3', wbs_path: '1.2', name: LONG_NAME,
    early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10, percent_complete: 30, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'mr1',
    status: 'NOT_STARTED', assignees: [], total_float: 5,
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
    statusSummary: { task_count: 2, critical_count: 1, critical_path_count: 1 },
  });
}

test.describe('Board mobile card readability (#1947)', () => {
  test.beforeEach(async ({ page }) => {
    // Seed a rail layout pref so the compact snap board renders (a phone with no
    // pref auto-defaults to Queue). Compact density is forced by rule 193.
    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm.board.toolbarPrefs.v1',
        JSON.stringify({ layout: 'rail', backlogDensity: 'comfortable' }),
      );
    });
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    // Gate on a "page rendered" signal — the To Do column card is present — before
    // touching any card chrome, so the reads that build the board have resolved.
    await expect(
      page.locator('[data-mobile-column="true"][data-status="NOT_STARTED"]'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('health badge peeks its meaning on tap, and closes', async ({ page }) => {
    const badge = page.getByRole('button', { name: /what does this mean/i });
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveAttribute('aria-expanded', 'false');

    await badge.click();
    const note = page.getByRole('note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('On the critical path');

    // "Got it" closes and the note is gone.
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByRole('note')).toHaveCount(0);

    // Re-open, then an outside tap closes it (no focus theft assertion here).
    await badge.click();
    await expect(page.getByRole('note')).toBeVisible();
    await page.locator('[data-mobile-column="true"][data-status="NOT_STARTED"]').click({
      position: { x: 5, y: 5 },
    });
    await expect(page.getByRole('note')).toHaveCount(0);
  });

  test('long title peeks the full name and adds no card height when closed', async ({ page }) => {
    // The card root exposes `${name}, ${pct}% complete` as its accessible name.
    const card = page.getByRole('button', {
      name: new RegExp(`^Implement the cross-team.*% complete`),
    });
    await expect(card).toBeVisible({ timeout: 10_000 });
    const closedBox = await card.boundingBox();
    expect(closedBox).not.toBeNull();

    // The end-of-title disclosure glyph is present only because the title overflows.
    const titlePeek = page.getByRole('button', { name: /^Show full title:/ });
    await expect(titlePeek).toBeVisible();

    await titlePeek.click();
    const note = page.getByRole('note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(LONG_NAME);

    // Portaled popover → the card's own height must not change when open.
    const openBox = await card.boundingBox();
    expect(openBox).not.toBeNull();
    expect(Math.round(openBox!.height)).toBe(Math.round(closedBox!.height));
  });
});

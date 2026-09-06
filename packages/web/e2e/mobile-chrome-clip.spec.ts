/**
 * Mobile TopBar right cluster must not clip at the right screen edge (#1788).
 *
 * The right cluster ("Synced" sync badge, notification bell, user menu) is
 * `shrink-0` (rule 174), so on a 375px phone it could push its tail off the
 * right edge. The health P80 fragment and the sync word are held to `md:`+, and
 * the mobile brand is mark-only, so the phone cluster stays within the viewport.
 *
 * Runs at a 375×812 phone viewport.
 */
import { test, expect } from './fixtures/coverage';
import type { Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-chrome-0000-0000-0000-000000000019';
const VIEWPORT_W = 375;

const PROJECT = {
  id: PROJECT_ID,
  name: 'Chrome Clip Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  methodology: 'WATERFALL',
  effective_methodology: 'WATERFALL',
  effective_surface_visibility: {
    reporting: true,
    time_tracking: true,
    baselines: true,
    monte_carlo: true,
  },
  iteration_label: null,
};

// The health chip's word is the variable-width part of this cluster, and the
// widest word is NOT the worst health — severity is no guide to it. Measured in
// Chromium at 375x812, single-threaded, against the bundled Inter at the chip's
// own `text-xs font-medium`:
//
//   band       word        word w    chip w    header scrollW    overflow
//   on_track   "On track"  48.73px   100.45    377               2px
//   critical   "Critical"  40.55px    92.27    375               0px
//   at_risk    "At risk"   36.47px    88.19    375               0px
//
// Read the last two columns together or the table looks self-contradictory: a
// 12.26px wider word appears to cost only 2px. It does not — the header is
// `flex-nowrap` with compressible neighbours, so it absorbs roughly the first
// 10px and pins `scrollWidth` at exactly `clientWidth` (375) until it runs out.
// on_track is the band that runs it out. So the slack, not the word width, is
// what the margin here is made of, and it is ~10px.
//
// This fixture therefore pins `at_risk`, and that is a deliberate, temporary
// concession rather than the worst case: the 2px on `on_track` is PRE-EXISTING
// (verified by building `origin/main`'s HealthCluster and re-measuring) and is
// filed as #3505, whose acceptance is flipping this fixture to the zero-count
// `on_track` band and deleting this paragraph.
//
// Do NOT "restore" the old `critical_count: 2` here. Before #3470 the critical
// band rendered "At risk" — the NARROWEST of the three words — so this guard
// tested the best case while its comment called itself worst-case, and it sat
// green through a real defect on the band it was not testing: the at-risk band
// rendered the retired "On watch" (54.48px), overflowing by 8px and pushing the
// account chip's right edge to 377.20px, clipped off a 375px screen. Retiring
// that word is what this fixture now guards.
const STATUS_SUMMARY = {
  task_count: 8,
  critical_path_count: 0,
  monte_carlo_p80: '2026-09-07',
  at_risk_count: 3,
  critical_count: 0,
  at_risk_tasks: [],
  critical_tasks: [],
  last_saved: null,
  recalculated_at: null,
};

async function setup(page: Page) {
  await page.setViewportSize({ width: VIEWPORT_W, height: 812 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT],
    projectId: PROJECT_ID,
    statusSummary: STATUS_SUMMARY,
    // Admin so every surface renders (no role-gated hiding narrows the cluster).
    members: [{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }],
  });
  await page.goto(`/projects/${PROJECT_ID}/overview`);
}

test.describe('Mobile TopBar does not clip at the right edge (#1788)', () => {
  test('TopBar right cluster stays within the phone viewport', async ({ page }) => {
    await setup(page);
    const header = page.locator('header').first();
    await expect(header).toBeVisible();

    // The account chip is the last item in the pinned right cluster — if the
    // cluster overflows, its right edge falls past the viewport. Since #1792 the
    // chip self-identifies by the signed-in user's name ("Account — E2E User"),
    // never a generic "User menu".
    const userMenu = header.getByRole('button', { name: 'Account — E2E User' });
    await expect(userMenu).toBeVisible();

    // The header (flex-nowrap) must not overflow horizontally.
    const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The last right-cluster control is fully within the viewport.
    const box = await userMenu.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);

    // The sync badge is still present (icon-only on a phone); its accessible name
    // carries the state word even though the visible "Synced" label is dropped.
    const sync = header.getByRole('button', { name: /synced|saved|offline|syncing/i });
    await expect(sync).toBeVisible();
    const syncBox = await sync.boundingBox();
    expect(syncBox).not.toBeNull();
    expect(syncBox!.x + syncBox!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);
  });
});

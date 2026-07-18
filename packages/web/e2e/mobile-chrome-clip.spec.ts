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

// Worst-case width: an at-risk state word AND a P80 forecast date both want to
// render in the health chip, immediately left of the sync badge.
const STATUS_SUMMARY = {
  task_count: 8,
  critical_path_count: 2,
  monte_carlo_p80: '2026-09-07',
  at_risk_count: 3,
  critical_count: 2,
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

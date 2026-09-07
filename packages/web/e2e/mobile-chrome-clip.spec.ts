/**
 * Mobile TopBar right cluster must not clip at the right screen edge (#1788),
 * and the header must not overflow its own box (#3505).
 *
 * The right cluster ("Synced" sync badge, notification bell, user menu) never
 * shrinks (rule 174), so on a 375px phone it could push its tail off the right
 * edge. The health P80 fragment and the sync word are held to `md:`+, and the
 * mobile brand is mark-only, to keep the phone cluster inside the viewport.
 *
 * **The two assertions below are not the same assertion** (#3505). The account
 * chip's box sat comfortably inside 375px while `scrollWidth - clientWidth` was 2,
 * because the chip carries a `::before` that extends its tap area to the 44px
 * touch floor (`-inset-[6px]`, rule 5/247) — six invisible pixels that count
 * toward the header's `scrollWidth` and nothing else. So the box check passes
 * right up to the point where the *overhang* leaves the screen, and the overflow
 * check is what actually holds the bar to its width budget. Both stay.
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

/**
 * Every health band, not one of them (#3505).
 *
 * This fixture used to be a single object pinning one band, under a comment
 * calling itself the worst case. It was not: the chip's state word is what
 * varies the bar's width, and severity is no guide to how wide a word is. So the
 * guard ran green while the bar overflowed in the bands it was not testing — and
 * re-pinning it to whichever band is widest *today* would only move the blind
 * spot to the next relabeling. The guard has to be word-independent, so it
 * sweeps the matrix: the band is an input here, and nothing below reads the word.
 *
 * The measurements that made the case, in Chromium at 375x812 against the
 * bundled Inter at the chip's own `text-xs font-medium` (#3470, #3505):
 *
 *   band       word        word w    chip w    header scrollW    overflow
 *   on_track   "On track"  48.73px   100.45    377               2px
 *   critical   "Critical"  40.55px    92.27    375               0px
 *   at_risk    "At risk"   36.47px    88.19    375               0px
 *
 * Read the last two columns together or the table looks self-contradictory: a
 * 12.26px wider word appears to cost only 2px. It does not — the header is
 * `flex-nowrap` with compressible neighbours, so it absorbs roughly the first
 * 10px and pins `scrollWidth` at `clientWidth` until it runs out. `on_track` is
 * the band that runs it out, which is why severity ranks the words backwards.
 *
 * Two dead ends this sweep closes for good, both of which sat green through a
 * real defect: pinning `critical_count: 2` (before #3470 that band rendered "At
 * risk", the NARROWEST of the three words), and pinning `at_risk` (which
 * rendered the retired "On watch", 54.48px, overflowing by 8px and pushing the
 * account chip's right edge to 377.20px, off a 375px screen). Both are now
 * inputs rather than the choice, so neither can be restored by accident.
 */
const BANDS = [
  { band: 'on_track', at_risk_count: 0, critical_count: 0 },
  { band: 'at_risk', at_risk_count: 3, critical_count: 0 },
  { band: 'critical', at_risk_count: 3, critical_count: 2 },
] as const;

function statusSummary({ at_risk_count, critical_count }: (typeof BANDS)[number]) {
  return {
    task_count: 8,
    critical_path_count: 2,
    // A P80 forecast date also wants to render in the chip, immediately left of
    // the sync badge — the widest the cluster ever gets on a phone.
    monte_carlo_p80: '2026-09-07',
    at_risk_count,
    critical_count,
    at_risk_tasks: [],
    critical_tasks: [],
    last_saved: null,
    recalculated_at: null,
  };
}

async function setup(page: Page, band: (typeof BANDS)[number]) {
  await page.setViewportSize({ width: VIEWPORT_W, height: 812 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [PROJECT],
    projectId: PROJECT_ID,
    statusSummary: statusSummary(band),
    // Admin so every surface renders (no role-gated hiding narrows the cluster).
    members: [{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }],
  });
  await page.goto(`/projects/${PROJECT_ID}/overview`);
}

test.describe('Mobile TopBar does not clip at the right edge (#1788)', () => {
  for (const band of BANDS) {
    test(`TopBar right cluster stays within the phone viewport — ${band.band} band`, async ({
      page,
    }) => {
      await setup(page, band);
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

      // …and so is its 44px touch target, which is a `::before` overhang rather
      // than part of the box above. This is the pixel budget the header overflow
      // above is really measuring, so assert it directly: a regression here says
      // "the tap area left the screen", which is diagnosable, where a bare
      // `scrollWidth` delta says only "something is 2px too wide".
      const tapRight = await userMenu.evaluate((el) => {
        const overhang = Number.parseFloat(getComputedStyle(el, '::before').right || '0');
        // A negative `right` is the pseudo-element reaching OUTSIDE the button.
        return el.getBoundingClientRect().right + Math.max(0, -overhang);
      });
      expect(tapRight).toBeLessThanOrEqual(VIEWPORT_W + 1);

      // The sync badge is still present (icon-only on a phone); its accessible name
      // carries the state word even though the visible "Synced" label is dropped.
      const sync = header.getByRole('button', { name: /synced|saved|offline|syncing/i });
      await expect(sync).toBeVisible();
      const syncBox = await sync.boundingBox();
      expect(syncBox).not.toBeNull();
      expect(syncBox!.x + syncBox!.width).toBeLessThanOrEqual(VIEWPORT_W + 1);

      // The health chip survives the squeeze. Since #3505 the phone bar absorbs
      // its overflow by letting the status strip scroll, and a strip driven to
      // zero would satisfy every assertion above while deleting the signal the
      // bar exists to carry (rule 290b).
      await expect(page.getByTestId('health-cluster')).toBeVisible();
      const chipBox = await page.getByTestId('health-cluster').boundingBox();
      expect(chipBox).not.toBeNull();
      expect(chipBox!.width).toBeGreaterThan(40);
    });
  }
});

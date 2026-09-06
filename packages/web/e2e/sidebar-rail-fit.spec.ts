import { test, expect, type Page, type Locator } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Rail-fit measurement at 1280×800 (#3473).
 *
 * The rail's Tier 2 is the only tier that can grow — it is the sole nav home for
 * project views (#1642) and program views (#1920) — and it is therefore the only
 * one the squeeze reaches. At 1280×800 it was measured holding 739px of project
 * view list in a 298px slot: eight of fourteen rows behind a scroll region with
 * no scrollbar (macOS auto-hides it) and no fade, so a first-time user could not
 * see that a Board or a Risk register existed.
 *
 * This is a measurement spec, not a `toBeVisible()` spec. A child clipped by an
 * overflow container still has a box and still passes `toBeVisible()` (the #2974
 * lesson), so every assertion here compares boxes: a row is "on screen" only when
 * its own rect sits inside the scroller's rect.
 *
 * 1280×800 is a 13" laptop — the geometry where the class shows. The sibling
 * measured sweep, `clipped-content.spec.ts`, runs at 1280×720 and a phone size
 * for the *clipping* invariant; this file owns the *fit* invariant at the height
 * the audit reported.
 */

const PROJECT_ID = 'e2e-fit-00000000-0000-0000-0000-000000003473';
const PROGRAM_ID = 'e2e-fitprog-0000-0000-0000-000000003473';

const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Rail Fit Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  program: null,
  program_detail: null,
  health: 'ON_TRACK',
  methodology: 'HYBRID',
  // HYBRID is the widest composition — every band, every view. The fit question
  // is only interesting against the worst case.
  effective_methodology: 'HYBRID',
};

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID });
  // Overview mounts useProjectBlocked (ADR-0124); an unmocked 401/404 trips the
  // session-expired modal and tears the rail out mid-measurement (#1190).
  await page.route(`**/api/v1/projects/${PROJECT_ID}/blocked/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, count: 0, blocked: [] }),
    }),
  );
  // The rail's own badge read. A non-zero due-today count is deliberate: the
  // folded summary row has to carry it, and a zero would make that vacuous.
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 3,
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    }),
  );
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: PROGRAM_ID,
            name: 'Atlas Program',
            code: 'ATL',
            color: null,
            health: 'ON_TRACK',
            methodology: 'HYBRID',
            project_count: 1,
            member_count: 1,
            is_pinned: false,
          },
        ],
      }),
    }),
  );
}

const railOf = (page: Page) => page.getByRole('complementary', { name: 'Primary navigation' });
const tierOf = (page: Page) => railOf(page).getByRole('navigation', { name: 'Workspace navigation' });

/** Rows fully inside the tier scroller's own box — the only honest "on screen". */
async function rowsInsideScroller(tier: Locator, links: Locator): Promise<string[]> {
  const slot = (await tier.boundingBox())!;
  const names: string[] = [];
  for (const link of await links.all()) {
    const box = await link.boundingBox();
    if (!box) continue;
    // 1px of slack for sub-pixel rounding at either edge.
    if (box.y >= slot.y - 1 && box.y + box.height <= slot.y + slot.height + 1) {
      names.push(((await link.textContent()) ?? '').trim());
    }
  }
  return names;
}

test.describe('rail fit at 1280×800 (#3473)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('every PROGRAM view row fits the tier without scrolling', async ({ page }) => {
    // The program rail is ten rows and one card. With the personal tier folded it
    // fits the slot exactly — so here the acceptance criterion is assertable in
    // full: nothing is behind a scroll region at all.
    await setup(page);
    // The program overview BODY is left to the catch-all on purpose: this file
    // measures the rail, and the catch-all here 404s deterministically (it does
    // not answer an object endpoint with a list shape), so the page renders its
    // own error state and the shell — the thing under test — survives intact.
    await page.goto(`/programs/${PROGRAM_ID}/overview`);

    const rail = railOf(page);
    await expect(rail.getByText('This program')).toBeVisible({ timeout: 15_000 });

    const tier = tierOf(page);
    const overflow = await tier.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(
      overflow,
      'the program view list must not overflow its tier at 1280×800',
    ).toBeLessThanOrEqual(1);

    const programNav = rail.getByRole('navigation', { name: 'Program' });
    const rows = programNav.getByRole('link');
    const onScreen = await rowsInsideScroller(tier, rows);
    expect(onScreen).toEqual(await rows.allTextContents().then((t) => t.map((s) => s.trim())));
    // Guard the count so a future view added to PROGRAM_VIEWS re-opens this
    // measurement rather than silently pushing a row off the bottom.
    expect(onScreen).toContain('Settings');
    expect(onScreen).toContain('Assets');
  });

  test('the personal tier folds on a project route and hands the height to Tier 2', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = railOf(page);
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 15_000 });

    // The fold is the mechanism, so assert the mechanism: one summary row
    // carrying the count, and no four-row card.
    const summary = rail.getByRole('button', { name: /Show personal destinations/ });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAccessibleName(/3 due today/);
    await expect(rail.getByRole('link', { name: 'Timesheet' })).toHaveCount(0);

    // …and assert the height it bought, as a bound rather than an equality so the
    // design can retune the rail without a test edit but can never silently give
    // the space back. Unfolded, this slot measured 298px.
    const slot = (await tierOf(page).boundingBox())!;
    expect(slot.height).toBeGreaterThan(430);

    // The disclosure is not a deletion: the three destinations come back.
    await summary.click();
    await expect(rail.getByRole('link', { name: 'Timesheet' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'My Assets' })).toBeVisible();
  });

  test('the overflow that remains is MARKED, and every row is reachable', async ({ page }) => {
    // A HYBRID project is fourteen view rows plus four band headings plus the
    // project card — 739px of content against a rail body of 619px, so it cannot
    // fit at this height however the tiers are arranged (see the MR for the
    // arithmetic). What rule 290 requires of a scroller that genuinely overflows
    // is that the overflow is DISCOVERABLE and everything in it is reachable.
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = railOf(page);
    await expect(rail.getByText('This project')).toBeVisible({ timeout: 15_000 });
    const tier = tierOf(page);

    // It really does overflow — without this the rest of the test is vacuous.
    expect(await tier.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);

    // The bottom edge fade marks it. Sibling of the scroller, not a child, or it
    // would scroll away with the content it is marking (rule 290 (d)).
    const fades = rail.locator('span.pointer-events-none.absolute');
    await expect(fades).toHaveCount(1);
    // Decorative only: no tab stop, no pointer interception.
    await expect(fades.first()).toHaveAttribute('aria-hidden', 'true');

    // Scrolling to the end brings the top fade in as well — both sides, because
    // this scroller has no fixed origin (Tab moves its offset).
    await tier.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(fades).toHaveCount(1);
    await expect(rail.locator('span.pointer-events-none.absolute.top-0')).toBeVisible();

    // The WORKSPACE band is no longer pinned, so it is at the END of the list —
    // it does not occupy the slot at every scroll position, and it does not read
    // as a terminus above content the user has not seen.
    const workspace = rail.getByRole('group', { name: 'Workspace views' });
    expect(await workspace.evaluate((el) => getComputedStyle(el).position)).not.toBe('sticky');

    // And the rows the fold could not rescue are reachable: at the bottom of the
    // scroll, the last row in the flow is inside the slot.
    const settings = workspace.getByRole('link', { name: 'Settings' });
    await settings.scrollIntoViewIfNeeded();
    const slot = (await tier.boundingBox())!;
    const box = (await settings.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(slot.y + slot.height + 1);
  });
});

/**
 * The drawer keeps the FULL personal card and one scroll region (#1688).
 *
 * The drawer's wrapper is `display: contents` so the Tier-2 nav stays a direct
 * flex child of the one scrolling column, exactly as it was before the edge-fade
 * wrapper existed — a property jsdom cannot check, because it applies no
 * stylesheet at all (rule 330(d)). This is the browser half.
 */
test.describe('the mobile drawer is untouched by the fold (#3473)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('renders the four personal destinations and no disclosure', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    await page.getByRole('button', { name: 'Open sidebar' }).click();
    const drawer = railOf(page);
    await expect(drawer.getByRole('link', { name: 'Timesheet' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'My Assets' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: /personal destinations/ })).toHaveCount(0);

    // One scroll region, and it is the tier COLUMN — not the Tier-2 nav, which
    // must stay plain in-flow content there or the inlined Browse tree becomes
    // unreachable (#1688).
    const navOverflow = await drawer
      .getByRole('navigation', { name: 'Workspace navigation' })
      .evaluate((el) => getComputedStyle(el).overflowY);
    expect(navOverflow).toBe('visible');

    // No edge fades in the drawer — nothing there marks a fold it does not have.
    await expect(drawer.locator('span.pointer-events-none.absolute')).toHaveCount(0);
  });
});

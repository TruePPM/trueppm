import { test, expect, type Page } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * Always-visible methodology indicator (#1907, restoring #1469 after #1680).
 *
 * #1469 added a compact 2-letter methodology badge that stayed visible below the
 * 1280px breakpoint. The #1680 shell restructure deleted it and moved the
 * methodology signal to the left-rail "This project" card subtitle, which only
 * renders while the rail is expanded — and the rail auto-collapses below 1023px
 * (ADR-0127) on a fresh session. That left the 768–1023px band with NO
 * methodology signal at all, the exact gap #1469 was filed to close.
 *
 * This spec covers the #1907 acceptance criteria:
 *   - the bar's `MethodologyIndicator` is visible with an accessible name at
 *     768 / 900 / 1023px in the default (auto-collapsed) rail state;
 *   - it is NOT duplicated with the rail subtitle once the rail is expanded
 *     (the ≥1024px default, where the rail auto-opens).
 *
 * Every project-scoped endpoint the Overview page reads is mocked with its real
 * shape (setupApiMocks + the blocked roll-up) so the page never crashes on an
 * unmocked object endpoint and tears the bar out mid-test (#1190 lesson).
 */

const PROJECT_ID = 'e2e-methind-0000-0000-0000-000000000001';

const PROJECT: ProjectFixture = {
  id: PROJECT_ID,
  name: 'Methodology Indicator Project',
  description: '',
  start_date: '2026-01-01',
  calendar: 'default',
  program: null,
  program_detail: null,
  health: 'ON_TRACK',
  methodology: 'WATERFALL',
  // The bar badge (like the rail subtitle) reads the SERVER-RESOLVED preset
  // (web-rule 196) — set both so a raw-vs-resolved drift can't hide the bug.
  effective_methodology: 'WATERFALL',
};

async function setup(page: Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: [PROJECT], projectId: PROJECT_ID });
  // Overview mounts useProjectBlocked (ADR-0124); an unmocked 401/404 here trips
  // the session-expired modal and tears the whole shell out mid-test.
  await page.route(`**/api/v1/projects/${PROJECT_ID}/blocked/`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ project_id: PROJECT_ID, count: 0, blocked: [] }),
    }),
  );
  await page.route('**/api/v1/me/work/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
        next: null,
        previous: null,
        active_sprints: [],
        due_today_count: 0,
        server_version_high_water: 0,
        retro_action_items: [],
      }),
    }),
  );
}

test.describe('Always-visible methodology indicator — 768–1023px band (#1907)', () => {
  for (const width of [768, 900, 1023]) {
    test(`the indicator is visible on first load at ${width}px (default auto-collapsed rail)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await setup(page);
      await page.goto(`/projects/${PROJECT_ID}/overview`);

      // Accessible name is always the full methodology word (WCAG 1.4.1 / rule 6) —
      // never the "WF" glyph alone.
      const badge = page.getByRole('img', { name: 'Waterfall workspace' });
      await expect(badge).toBeVisible({ timeout: 10_000 });
      await expect(badge).toHaveText('WF');
    });
  }

  test('the indicator is NOT shown once the rail is manually expanded at 900px (no duplicate signal)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(page.getByRole('img', { name: 'Waterfall workspace' })).toBeVisible({
      timeout: 10_000,
    });

    // Re-open the rail (the ≡ affordance re-shows it per ADR-0127 Decision D).
    await page.getByRole('button', { name: 'Show navigation' }).click();
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible();
    await expect(rail).toContainText('Waterfall workspace');

    // The bar badge must be gone now — the rail subtitle is the sole signal.
    await expect(page.getByRole('img', { name: 'Waterfall workspace' })).toHaveCount(0);
  });
});

test.describe('Methodology indicator at the rail-open default (≥1024px) — no duplication (#1907)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('the rail subtitle is the sole signal; the bar badge does not also render', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    // Rail auto-opens at ≥1024px by default and carries the "This project" card
    // subtitle with the methodology.
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(rail).toContainText('Waterfall workspace');

    // The bar's compact badge must not also render — exactly one signal at a time.
    await expect(page.getByRole('img', { name: 'Waterfall workspace' })).toHaveCount(0);
  });

  test('collapsing the rail brings the bar badge back (methodology stays discoverable)', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Hide navigation' }).click();
    await expect(rail).toHaveCount(0);

    const badge = page.getByRole('img', { name: 'Waterfall workspace' });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('WF');
  });
});

/**
 * Mobile BottomNav reachability E2E (issue #1464, ADR-0196).
 *
 * The pre-1464 rail hardcoded 9 items and dropped Backlog, Risks, and Reports
 * for every methodology. This spec runs at a phone viewport (375×812) — where
 * the rail is visible (`md:hidden`) and the desktop view bar is not
 * (`hidden md:flex`) — and asserts acceptance #4: Backlog/Risks/Reports are
 * reachable per methodology, either as a primary tab or via the More overflow
 * sheet.
 */
import { test, expect } from './fixtures/coverage';
import type { Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-botnav-0000-0000-0000-000000000014';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

type Methodology = 'WATERFALL' | 'AGILE' | 'HYBRID';

function projectFixture(methodology: Methodology) {
  return {
    id: FIXTURE_PROJECT_ID,
    name: `${methodology} BottomNav Project`,
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
    methodology,
    effective_methodology: methodology,
    // Reporting on so the Reports view stays reachable (ADR-0193).
    effective_surface_visibility: {
      reporting: true,
      time_tracking: true,
      baselines: true,
      monte_carlo: true,
    },
    iteration_label: null,
  };
}

async function setup(page: Page, methodology: Methodology) {
  await page.setViewportSize({ width: 375, height: 812 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [projectFixture(methodology)],
    projectId: FIXTURE_PROJECT_ID,
    // Admin (role 300) so the Team role gate (>= Scheduler) is satisfied.
    members: [{ id: 'mem-admin', role: 300, user_id: 'e2e-user' }],
  });
  await page.goto(`${BASE_URL}/overview`);
}

// The rail is the only "View" navigation at mobile width (the desktop bar is
// display:none), so this resolves unambiguously.
function rail(page: Page) {
  return page.getByRole('navigation', { name: /view/i });
}

async function openMore(page: Page) {
  await expect(rail(page)).toBeVisible({ timeout: 10_000 });
  await rail(page).getByRole('button', { name: /^More/ }).click();
  return page.getByRole('dialog');
}

test.describe('Mobile BottomNav reachability (#1464)', () => {
  test('HYBRID — Backlog is primary; Risks and Reports reachable via More', async ({ page }) => {
    await setup(page, 'HYBRID');
    // Overview + Today always lead (issue 1324).
    await expect(rail(page).getByRole('link', { name: /Overview/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(rail(page).getByRole('link', { name: /Today/i })).toBeVisible();
    // Backlog is promoted to a primary tab on HYBRID.
    await expect(rail(page).getByRole('link', { name: /Backlog/i })).toBeVisible();

    const sheet = await openMore(page);
    await expect(sheet.getByRole('link', { name: /Risks/i })).toBeVisible();
    await expect(sheet.getByRole('link', { name: /Reports/i })).toBeVisible();
    // Settings stays reachable via the overflow (issue 539).
    await expect(sheet.getByRole('link', { name: /Settings/i })).toBeVisible();
  });

  test('AGILE — Backlog is primary; Risks and Reports reachable via More', async ({ page }) => {
    await setup(page, 'AGILE');
    await expect(rail(page).getByRole('link', { name: /Backlog/i })).toBeVisible({
      timeout: 10_000,
    });

    const sheet = await openMore(page);
    await expect(sheet.getByRole('link', { name: /Risks/i })).toBeVisible();
    await expect(sheet.getByRole('link', { name: /Reports/i })).toBeVisible();
  });

  test('WATERFALL — no Backlog (methodology-hidden); Risks and Reports reachable', async ({
    page,
  }) => {
    await setup(page, 'WATERFALL');
    await expect(rail(page)).toBeVisible({ timeout: 10_000 });
    // WATERFALL hides product-backlog + sprints (ADR-0041), so Backlog must not
    // appear anywhere in the rail — not as a tab...
    await expect(rail(page).getByRole('link', { name: /Backlog/i })).toHaveCount(0);

    const sheet = await openMore(page);
    // ...nor in the overflow.
    await expect(sheet.getByRole('link', { name: /Backlog/i })).toHaveCount(0);
    // But Risks and Reports remain reachable (both shown on WATERFALL desktop).
    await expect(sheet.getByRole('link', { name: /Risks/i })).toBeVisible();
    await expect(sheet.getByRole('link', { name: /Reports/i })).toBeVisible();
  });

  test('WATERFALL — Schedule is a primary tab by default (issue 1591 default-promotion)', async ({
    page,
  }) => {
    await setup(page, 'WATERFALL');
    // The schedule-first pair leads WATERFALL, so a construction PM finds
    // Schedule on the rail without opening More.
    await expect(rail(page).getByRole('link', { name: /Schedule/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('user can pin Schedule to the rail from the More sheet (issue 1591)', async ({ page }) => {
    await setup(page, 'HYBRID');
    await expect(rail(page)).toBeVisible({ timeout: 10_000 });
    // HYBRID parks Schedule in the overflow by default (Board + Backlog lead).
    await expect(rail(page).getByRole('link', { name: /Schedule/i })).toHaveCount(0);

    const sheet = await openMore(page);
    await sheet.getByRole('button', { name: /^Pin Schedule to navigation bar/i }).click();

    // Schedule is now a primary rail tab.
    await expect(rail(page).getByRole('link', { name: /Schedule/i })).toBeVisible();
    // ...and the pin survives a reload (persisted client-side).
    await page.reload();
    await expect(rail(page).getByRole('link', { name: /Schedule/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('More sheet rows do not clip their trailing pin toggle at the screen edge (#1789)', async ({
    page,
  }) => {
    await setup(page, 'HYBRID');
    const sheet = await openMore(page);
    await expect(sheet).toBeVisible();

    const sheetBox = await sheet.boundingBox();
    expect(sheetBox).not.toBeNull();
    if (!sheetBox) return;

    // The sheet must not overflow horizontally — a row wider than the sheet is
    // exactly the failure mode (long label with no min-w-0 pushes the toggle
    // past the padded edge, and overflow-y-auto clips it).
    const overflow = await sheet.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // Every pin/unpin toggle must sit fully inside the sheet, not clipped.
    const toggles = sheet.getByRole('button', { name: /(Pin|Unpin) .* navigation bar/i });
    const count = await toggles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const box = await toggles.nth(i).boundingBox();
      expect(box).not.toBeNull();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(sheetBox.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 0.5);
      // 44px minimum touch target survives the shrink-0 guard (web-rule 5).
      expect(box.width).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('More sheet closes on Escape and restores focus to the trigger', async ({ page }) => {
    await setup(page, 'HYBRID');
    const sheet = await openMore(page);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    // Focus returns to the More button (BottomSheet traps; BottomNav restores).
    await expect(rail(page).getByRole('button', { name: /^More/ })).toBeFocused();
  });
});

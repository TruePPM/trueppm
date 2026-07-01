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
import { test, expect } from '@playwright/test';
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

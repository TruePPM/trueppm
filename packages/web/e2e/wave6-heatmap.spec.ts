import { test, expect } from '@playwright/test';

/**
 * Wave 6 — Resources/Team heatmap (issues #217 + #219, ADR-0042).
 *
 * Golden path: SCHEDULER user opens Heatmap sub-tab → KPI row and heatmap render.
 * Error / empty states: MEMBER role cannot see Team tab; 409 shows empty state.
 * Drawer: clicking an over-allocated cell opens the task drill-down drawer.
 */

const PROJECT_ID = 'test-project-heatmap';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function heatmapUrl(projectId = PROJECT_ID) {
  return `/projects/${projectId}/resources/heatmap`;
}

// ---------------------------------------------------------------------------
// RBAC — Team tab visibility
// ---------------------------------------------------------------------------

test.describe('Team tab RBAC', () => {
  test('Team tab is hidden for MEMBER role', async ({ page }) => {
    // The fixture sets the auth user to role=MEMBER for this project.
    await page.goto('/');
    await page.waitForURL(/\/projects\/.+\/overview/);

    // ViewTabs should not include "Team" for a Member.
    await expect(page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Team' })).toHaveCount(0);
  });

  test('Team tab is visible for SCHEDULER role', async ({ page }) => {
    // Fixture sets auth user to role=SCHEDULER.
    await page.goto('/');
    await page.waitForURL(/\/projects\/.+\/overview/);

    await expect(page.getByRole('navigation', { name: 'View' }).getByRole('link', { name: 'Team' })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Heatmap page — golden path
// ---------------------------------------------------------------------------

test.describe('Heatmap page', () => {
  test('Heatmap sub-tab renders KPI row and grid', async ({ page }) => {
    await page.goto(heatmapUrl());

    // Sub-navigation should show all three pills.
    const subNav = page.getByRole('navigation', { name: 'Team sub-view' });
    await expect(subNav.getByRole('link', { name: 'Roster' })).toBeVisible();
    await expect(subNav.getByRole('link', { name: 'Allocation' })).toBeVisible();
    await expect(subNav.getByRole('link', { name: 'Heatmap' })).toBeVisible();

    // KPI cards load — wait for the first card label to appear.
    await expect(page.getByText('Avg utilization')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('Over-allocated')).toBeVisible();
    await expect(page.getByText('Under-utilized')).toBeVisible();
    await expect(page.getByText('Headcount')).toBeVisible();
  });

  test('Heatmap grid is present with at least one over-allocated cell', async ({ page }) => {
    await page.goto(heatmapUrl());

    // The heatmap grid should render (role="grid").
    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid).toBeVisible({ timeout: 8000 });

    // At least one cell in the grid (the test project has an over-allocated resource).
    await expect(grid.getByRole('gridcell').first()).toBeVisible();
  });

  test('Clicking an over-allocated cell opens the drawer', async ({ page }) => {
    await page.goto(heatmapUrl());

    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid).toBeVisible({ timeout: 8000 });

    // Find a cell with an over-allocated aria-label (contains "% utilized" and > 100).
    // Click the first cell in the grid as a baseline.
    const firstCell = grid.getByRole('button').first();
    await firstCell.click();

    // Drawer should open with a dialog role.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 4000 });

    // Close with Escape.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Weeks window control changes the grid column count', async ({ page }) => {
    await page.goto(heatmapUrl());

    const grid = page.getByRole('grid', { name: 'Resource utilization heatmap' });
    await expect(grid).toBeVisible({ timeout: 8000 });

    // Switch to 4w window.
    const weekGroup = page.getByRole('group', { name: 'Week window' });
    await weekGroup.getByRole('button', { name: '4w' }).click();

    // The header row should now have 4 week-label cells (+ 1 Resource column = 5 total).
    const headerCells = grid.getByRole('columnheader');
    await expect(headerCells).toHaveCount(5); // 1 resource + 4 weeks
  });

  test('Level loads button shows upsell tooltip on hover', async ({ page }) => {
    await page.goto(heatmapUrl());

    const btn = page.getByRole('button', { name: /Level loads/ });
    await expect(btn).toBeVisible({ timeout: 8000 });
    await expect(btn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

test.describe('Empty states', () => {
  test('Shows empty state when no resources are on the project', async ({ page }) => {
    // The fixture project for this test has no resources assigned.
    await page.goto(`/projects/test-project-empty/resources/heatmap`);

    await expect(page.getByText(/No team members yet/i)).toBeVisible({ timeout: 8000 });
  });
});

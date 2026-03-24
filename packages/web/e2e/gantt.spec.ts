import { test, expect } from '@playwright/test';

/**
 * Gantt view E2E tests — toolbar, task list panel, and accessibility basics.
 */

test.describe('GanttView toolbar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the Gantt to finish loading (task list should be visible)
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('view-mode switcher has Gantt active and WBS/List disabled', async ({ page }) => {
    const group = page.getByRole('group', { name: 'View mode' });
    await expect(group).toBeVisible();

    const ganttBtn = group.getByRole('button', { name: 'Gantt' });
    const wbsBtn = group.getByRole('button', { name: 'WBS' });
    const listBtn = group.getByRole('button', { name: 'List' });

    await expect(ganttBtn).toBeVisible();
    await expect(ganttBtn).toHaveAttribute('aria-pressed', 'true');

    await expect(wbsBtn).toBeDisabled();
    await expect(listBtn).toBeDisabled();
  });

  test('Today button is present and focusable', async ({ page }) => {
    const todayBtn = page.getByRole('button', { name: 'Today' });
    await expect(todayBtn).toBeVisible();
    await todayBtn.focus();
    await expect(todayBtn).toBeFocused();
  });
});

test.describe('GanttView task list', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('grid', { name: 'Task list' }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('task list header shows Dur · Start column', async ({ page }) => {
    const header = page.getByRole('row', { name: 'Task list columns' });
    await expect(header).toBeVisible();
    await expect(header.getByRole('columnheader', { name: 'Duration and start date' })).toBeVisible();
  });

  test('critical path tasks are announced accessibly', async ({ page }) => {
    // At least one task should have "(critical path)" in its aria-label
    const criticalCell = page.locator('[aria-label*="critical path"]').first();
    await expect(criticalCell).toBeVisible();
  });
});

test.describe('Accessibility basics', () => {
  test('sidebar has accessible label', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('complementary', { name: 'Projects' })).toBeVisible();
  });

  test('status bar is a contentinfo landmark', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('contentinfo', { name: 'Project status' }),
    ).toBeVisible();
  });

  test('Gantt legend lists Complete, In progress, Critical path, Milestone', async ({
    page,
  }) => {
    await page.goto('/');
    const legend = page.getByLabel('Gantt legend');
    await expect(legend).toBeVisible();
    for (const label of ['Complete', 'In progress', 'Critical path', 'Milestone']) {
      await expect(legend.getByText(label)).toBeVisible();
    }
  });
});

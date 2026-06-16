import { test, expect, type Page } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll, type ProjectFixture } from './fixtures';

/**
 * E2E coverage for the ⌘K command palette (v2, #1166).
 *
 * Golden path: open via the keyboard shortcut and the visible trigger, fuzzy
 * filter to a project, and jump to it. Error/edge: a no-match query shows the
 * empty state, and Escape closes without navigating.
 *
 * All API calls are route-mocked; no server required.
 */

const PROJECTS: ProjectFixture[] = [
  { id: 'cmdk-proj-apollo', name: 'Apollo Redesign' },
  { id: 'cmdk-proj-borealis', name: 'Borealis Platform' },
];

async function setup(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: PROJECTS, projectId: PROJECTS[0].id });
  // Land on a routed page inside the shell, where the palette is mounted.
  await page.goto('/me/work');
}

test.describe('command palette', () => {
  test('opens with the keyboard shortcut, filters, and jumps to a project', async ({ page }) => {
    await setup(page);

    // Wait for the shell to mount (so the global ⌘K listener is attached).
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByRole('combobox').fill('borealis');
    // "borealis" now also matches the v2 Backlog/Board targets (issue 647); the
    // jump-to-overview option is the project row specifically (label + Project chip).
    await expect(
      dialog.getByRole('option', { name: 'Borealis Platform Project', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByRole('option', { name: /Apollo Redesign/ })).toHaveCount(0);

    // The jump-to-project row is the first match → Enter navigates to its overview.
    await page.getByRole('combobox').press('Enter');
    await expect(page).toHaveURL(/\/projects\/cmdk-proj-borealis\/overview/);
  });

  test('opens from the visible trigger and shows the no-match empty state', async ({ page }) => {
    await setup(page);

    await page.getByRole('button', { name: /command palette/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByRole('combobox').fill('zzzznotathing');
    await expect(dialog.getByText(/No matches/)).toBeVisible();
  });

  test('Escape closes the palette without navigating', async ({ page }) => {
    await setup(page);

    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

    await page.getByRole('combobox').press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/me\/work/);
  });

  // ---- v2 (issue 647) -----------------------------------------------------

  test('shows the off-project hint when opened away from a project', async ({ page }) => {
    await setup(page); // lands on /me/work — no project in context
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Open a project to search its tasks and sprint.')).toBeVisible();
  });

  test('jump-to-task opens the task drawer inline (no navigation)', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECTS[0].id,
      tasks: [
        {
          id: 'cmdk-task-1',
          name: 'Wire OAuth callback',
          status: 'IN_PROGRESS',
          wbs_path: '1',
          percent_complete: 0,
          duration: 1,
          is_milestone: false,
          is_summary: false,
          parent_id: null,
        },
      ],
    });
    // Land on a project route so task search is scoped to it.
    await page.goto(`/projects/${PROJECTS[0].id}/schedule`);
    await expect(page.getByRole('button', { name: /command palette/i })).toBeVisible();

    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();

    await page.getByRole('combobox').fill('oauth');
    const taskOption = dialog.getByRole('option', { name: /Open task: Wire OAuth callback/ });
    await expect(taskOption).toBeVisible();

    await page.getByRole('combobox').press('Enter');

    // The palette closes and the app-wide task drawer opens in place — the URL
    // stays on the schedule route (drawer, not navigation).
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close task detail' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECTS[0].id}/schedule`));
  });
});

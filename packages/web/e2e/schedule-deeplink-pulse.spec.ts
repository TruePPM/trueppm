import { test, expect } from '@playwright/test';
import { setupApiMocks, setupCatchAll } from './fixtures/api-mocks';

/**
 * Schedule deep-link scroll + pulse (issue 734).
 *
 * The sprint→schedule bridge link (AdvancingToMilestoneCard) navigates to
 * `/projects/:id/schedule#task-{id}`. On arrival, ScheduleView must scroll the
 * target task into view and fire the MilestonePulseOverlay so the one
 * cross-surface jump lands on a visibly highlighted diamond — the "bridge
 * moment". This spec asserts the pulse fires when the hash names a task, and
 * does not fire on a plain (hash-free) navigation.
 */

const PROJECT_ID = 'e2e-project-00000000-0000-0000-0000-000000000001';

const FIXTURE_TASKS = [
  {
    id: 'root',
    wbs_path: '1',
    name: 'Beta Program',
    planned_start: '2026-10-05',
    early_start: '2026-10-05',
    early_finish: '2026-11-20',
    duration: 34,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
  },
  {
    id: 'task-a',
    wbs_path: '1.1',
    name: 'Discovery',
    planned_start: '2026-10-05',
    early_start: '2026-10-05',
    early_finish: '2026-10-16',
    duration: 10,
    percent_complete: 100,
    is_critical: true,
    is_milestone: false,
  },
  {
    id: 'task-m1',
    wbs_path: '1.2',
    name: 'FAT review',
    planned_start: '2026-11-14',
    early_start: '2026-11-14',
    early_finish: '2026-11-14',
    duration: 0,
    percent_complete: 0,
    is_critical: true,
    is_milestone: true,
  },
];

test.describe('Schedule deep-link pulse (#734)', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
    await setupApiMocks(page, { projectId: PROJECT_ID, tasks: FIXTURE_TASKS });
    await page.addInitScript(() => {
      localStorage.setItem(
        'trueppm-auth',
        JSON.stringify({
          state: { accessToken: 'e2e-token', refreshToken: 'e2e-refresh', isAuthenticated: true },
          version: 0,
        }),
      );
    });
  });

  test('firing on a #task-{id} deep link pulses the target milestone', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule#task-task-m1`);
    // The pulse fires once the canvas engine + scales are ready and the target
    // row is in the tree. It self-clears after 1.5s, so poll with a generous
    // ceiling for canvas init — Playwright catches the transient window.
    await expect(page.getByTestId('milestone-pulse-overlay')).toBeVisible({ timeout: 10_000 });
  });

  test('a plain navigation (no hash) does not pulse', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    // Gate on the schedule actually rendering before asserting the absence.
    await expect(page.getByRole('grid', { name: 'Task list' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('milestone-pulse-overlay')).toHaveCount(0);
  });
});

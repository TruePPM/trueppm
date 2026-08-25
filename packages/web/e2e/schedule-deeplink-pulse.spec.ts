import { test, expect } from './fixtures/coverage';
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

// This file is the one place that asserts the pulse *animation* itself, so it
// opts out of the suite-wide `reducedMotion: 'reduce'` default. MilestonePulseOverlay
// deliberately does not mount under `prefers-reduced-motion` — the live-region
// announcement carries the feedback instead — so under the global default there
// would be nothing to assert. The reduced-motion branch is covered as a unit test
// in MilestonePulseOverlay.test.tsx. (#2382)
test.use({ contextOptions: { reducedMotion: 'no-preference' } });

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
    // Completed task → never critical (#1863).
    is_critical: false,
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
    // Asserts the *latch*, not the animation. The overlay node self-clears after
    // 1.5 s, so `toBeVisible` on it is a window-of-existence race that no timeout
    // can fix: on a loaded runner the poll can straddle the closed window
    // entirely, and once it has closed the node is gone permanently (#2380).
    // data-pulsed-task-id records that the pulse was requested and never clears,
    // so this both cannot flake and checks something stronger — that the deep
    // link resolved to the *right* milestone rather than merely to some pulse.
    await expect(page.getByTestId('milestone-pulse-latch')).toHaveAttribute(
      'data-pulsed-task-id',
      'task-m1',
      { timeout: 10_000 },
    );
  });

  test('a plain navigation (no hash) does not pulse', async ({ page }) => {
    await page.goto(`/projects/${PROJECT_ID}/schedule`);
    // Gate on the schedule actually rendering before asserting the absence.
    await expect(page.getByRole('treegrid', { name: 'Item list' })).toBeVisible({ timeout: 10_000 });
    // The latch is present but empty — which is a stronger negative than the
    // old count check: an absent overlay is also what a schedule that failed to
    // render looks like, whereas an empty latch proves the component mounted
    // and simply had nothing to pulse.
    await expect(page.getByTestId('milestone-pulse-latch')).toHaveAttribute(
      'data-pulsed-task-id',
      '',
    );
    await expect(page.getByTestId('milestone-pulse-overlay')).toHaveCount(0);
  });
});

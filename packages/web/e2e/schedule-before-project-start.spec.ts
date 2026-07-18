/**
 * Project-start floor prompt (#868) — a reschedule that lands before the
 * project's start date opens a snap/move/cancel prompt instead of silently
 * clamping.
 *
 * The full prompt lifecycle (intercept on Confirm, Snap re-pins to the project
 * start, Move project start does the two-step PATCH, Cancel reverts, admin
 * gating of "Move project start", inline errors) is exercised at the vitest
 * layer in `useScheduleCommit.test.tsx` (5 floor tests) and
 * `BeforeProjectStartDialog.test.tsx` (6 tests).
 *
 * Canvas-driven pointer drag is intentionally not asserted here — see
 * `schedule-commit-popover.spec.ts` (lines 16–19) for the codebase precedent:
 * canvas/network-coupled drag flows are covered at vitest, and the E2E spec
 * guards the page-level regression boundary (the view still renders with the
 * floor-prompt wiring mounted; the dialog is absent until a real drag fires).
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-floor-0000-0000-0000-000000000868';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Floor Guard Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'tk1',
    wbs_path: '1',
    name: 'Foundation',
    early_start: '2026-04-01',
    early_finish: '2026-04-05',
    planned_start: '2026-04-01',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    parent_id: null,
    status: 'NOT_STARTED',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

test.describe('Schedule project-start floor prompt (#868)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: FIXTURE_PROJECTS,
      projectId: FIXTURE_PROJECT_ID,
      tasks: FIXTURE_TASKS,
    });
  });

  test('schedule renders without the floor prompt on initial load', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    // The floor prompt only mounts when a reschedule confirm lands before the
    // project start — never on load.
    await expect(
      page.getByRole('alertdialog', { name: /Schedule before the project start\?/i }),
    ).toHaveCount(0);
  });

  test('canvas interaction layer is reachable (floor wiring did not break the surface)', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByText('Foundation')).toBeVisible();
    const canvas = page.locator('canvas[data-layer="interaction"]');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
  });
});

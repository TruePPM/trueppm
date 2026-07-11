/**
 * E2E for the Schedule toolbar's clustered layout + responsive rules
 * (issues #568 / #1741).
 *
 * #1741 grouped the flat toolbar into Time / Show / Actions clusters: the four
 * view/render filters and column visibility moved into a single "Display"
 * popover (the Show cluster), which is the filters' home at EVERY width — they
 * never migrate into the `···` Actions overflow (web rule 243). Only the Display
 * trigger's label collapses to icon-only below lg.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-fixture-00000000-0000-0000-0000-000000000568';

const FIXTURE_TASKS = [
  {
    id: 't1',
    wbs_path: '1',
    name: 'Toolbar Responsive Audit',
    early_start: '2026-10-05',
    early_finish: '2026-11-14',
    duration: 30,
    percent_complete: 40,
    is_critical: false,
    is_milestone: false,
    is_summary: true,
    parent_id: null,
    status: 'IN_PROGRESS',
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  },
];

async function gotoSchedule(page: import('@playwright/test').Page, viewportWidth: number) {
  await page.setViewportSize({ width: viewportWidth, height: 800 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: [
      {
        id: FIXTURE_PROJECT_ID,
        name: 'Toolbar Responsive Audit',
        description: '',
        start_date: '2026-01-01',
        calendar: 'default',
      },
    ],
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
  });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}/schedule`);
  // Gate on the canvas, not the task-list grid: below md (< 768px) the Schedule
  // forces full-width Timeline mode (#1670) and the task-list panel never mounts,
  // so the 600px case has no "Task list" grid. The canvas scroll container
  // renders in both the mobile and desktop layouts.
  await expect(page.getByTestId('schedule-canvas-scroll')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Schedule toolbar — clustered layout (#1741)', () => {
  test('at 1280px (lg) the Display trigger shows its label and the filters live in its popover, not inline', async ({ page }) => {
    await gotoSchedule(page, 1280);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible();

    // Time cluster: the Today button stays labeled.
    await expect(toolbar.getByRole('button', { name: 'Today' })).toHaveText(/Today/);

    // Show cluster: a single "Display" trigger (labeled at lg). The old inline
    // filter toggles and the standalone Columns button no longer exist.
    await expect(toolbar.getByRole('button', { name: 'Display' })).toHaveText(/Display/);
    await expect(toolbar.getByRole('button', { name: 'Columns' })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Show critical path only' })).toHaveCount(0);

    // Filters live inside the Display popover as checkboxes.
    await toolbar.getByRole('button', { name: 'Display' }).click();
    const display = page.getByRole('menu', { name: 'Display options' });
    for (const name of ['CP only', 'Focus chain', 'Critical path', 'Milestones']) {
      await expect(display.getByRole('menuitemcheckbox', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');

    // Actions menu is present (Import/Export/Share fold in here).
    await expect(toolbar.getByRole('button', { name: 'Project actions' })).toBeVisible();
  });

  test('at 900px (md) the Display trigger collapses to icon-only but keeps its accessible name', async ({ page }) => {
    await gotoSchedule(page, 900);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    const display = toolbar.getByRole('button', { name: 'Display' });
    await expect(display).toBeVisible();
    // Icon-only: the visible "Display" label is dropped; the accessible name
    // (used by the role+name query above) is retained via aria-label (rule 114).
    await expect(display).not.toHaveText(/Display/);

    // Filters are still reachable via the Display popover at md.
    await display.click();
    await expect(
      page.getByRole('menu', { name: 'Display options' }).getByRole('menuitemcheckbox', { name: 'CP only' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    // Single-row, no wrap (rule 113) — a stacked row would exceed the h-10 target.
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeLessThan(56);
  });

  test('at 768px (narrowest desktop toolbar) the filters stay in the Display popover — they never move to the Actions overflow (rule 243)', async ({ page }) => {
    // 768px is the smallest width the desktop toolbar renders at: below md
    // (≤767px) ScheduleView swaps to the dedicated mobile Schedule surface,
    // which has no toolbar at all (#1671, ADR-0348).
    await gotoSchedule(page, 768);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });

    // The Actions overflow does NOT host the filters (that was the old sm behavior).
    const actions = toolbar.getByRole('button', { name: 'Project actions' });
    await expect(actions).toBeVisible();
    await actions.click();
    const actionsMenu = page.getByRole('menu', { name: 'Project actions' });
    await expect(actionsMenu).toBeVisible();
    await expect(actionsMenu.getByRole('menuitemcheckbox', { name: /CP only/ })).toHaveCount(0);
    await expect(actionsMenu.getByRole('menuitemcheckbox', { name: /Milestones/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The filters remain reachable — in the Display popover, at sm too.
    await toolbar.getByRole('button', { name: 'Display' }).click();
    const display = page.getByRole('menu', { name: 'Display options' });
    await expect(display.getByRole('menuitemcheckbox', { name: 'CP only' })).toBeVisible();
    await expect(display.getByRole('menuitemcheckbox', { name: 'Milestones' })).toBeVisible();
  });
});

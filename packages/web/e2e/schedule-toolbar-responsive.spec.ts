/**
 * E2E for the Schedule toolbar's responsive collapse rules (issue #568).
 *
 * Covers AC: at a 900px viewport (md tier, 768–1023px) the Schedule toolbar
 * shows primary actions with labels and renders secondary toggles icon-only.
 * The shared `ToolbarOverflowMenu` (rule 112) is asserted at the sm tier.
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

test.describe('Schedule toolbar — responsive collapse (#568)', () => {
  test('at 900px viewport (md tier) primary controls keep labels and secondary toggles render icon-only', async ({ page }) => {
    await gotoSchedule(page, 900);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar).toBeVisible();

    // Primary controls retain their text labels at md (rule 111).
    await expect(toolbar.getByRole('button', { name: 'Today' })).toHaveText(/Today/);
    await expect(toolbar.getByRole('button', { name: 'Columns' })).toHaveText(/Columns/);

    // Secondary toggles still expose their accessible names but their
    // visible inner text drops to the icon (rule 111 + 114). The accessible
    // name comes from aria-label, so the role+name query still resolves; we
    // check that the visible inner text is the icon-only form.
    const cpOnly = toolbar.getByRole('button', { name: 'Show critical path only' });
    await expect(cpOnly).toBeVisible();
    await expect(cpOnly).not.toHaveText(/CP only/);
    const focusChain = toolbar.getByRole('button', { name: 'Focus chain on selected task' });
    await expect(focusChain).toBeVisible();
    await expect(focusChain).not.toHaveText(/Focus chain/);
    const criticalOnly = toolbar.getByRole('button', { name: 'Show only critical-path tasks' });
    await expect(criticalOnly).toBeVisible();
    await expect(criticalOnly).not.toHaveText(/Critical path/);
    const milestonesOnly = toolbar.getByRole('button', { name: 'Show only milestones' });
    await expect(milestonesOnly).toBeVisible();
    await expect(milestonesOnly).not.toHaveText(/Milestones/);

    // The "Project actions" menu (Import/Export, #68) is always present, but the
    // secondary analysis toggles stay INLINE at md (rule 112, asserted above) —
    // they do not collapse into this menu above the sm tier.
    await expect(
      toolbar.getByRole('button', { name: 'Project actions' }),
    ).toBeVisible();

    // The toolbar must not wrap (rule 113) — a stacked row would push the
    // measured height past the single-row h-10 (40px) target.
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeLessThan(56);
  });

  test('at 1280px viewport (lg tier) secondary toggles show their full labels', async ({ page }) => {
    await gotoSchedule(page, 1280);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    await expect(toolbar.getByRole('button', { name: 'Show critical path only' })).toHaveText(/CP only/);
    await expect(toolbar.getByRole('button', { name: 'Focus chain on selected task' })).toHaveText(/Focus chain/);
    await expect(toolbar.getByRole('button', { name: 'Show only critical-path tasks' })).toHaveText(/Critical path/);
    await expect(toolbar.getByRole('button', { name: 'Show only milestones' })).toHaveText(/Milestones/);
    // The "Project actions" menu (Import/Export, #68) is always present; the
    // secondary toggles remain inline at lg, not collapsed into it.
    await expect(
      toolbar.getByRole('button', { name: 'Project actions' }),
    ).toBeVisible();
  });

  test('at 600px viewport (sm tier) secondary toggles disappear and surface inside the overflow menu', async ({ page }) => {
    await gotoSchedule(page, 600);

    const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
    // Secondary toggles are not in the toolbar at sm (rule 111) — they live
    // inside the overflow menu, not as inline buttons.
    await expect(toolbar.getByRole('button', { name: 'Show critical path only' })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Focus chain on selected task' })).toHaveCount(0);

    const overflowTrigger = toolbar.getByRole('button', { name: 'Project actions' });
    await expect(overflowTrigger).toBeVisible();
    await overflowTrigger.click();
    const menu = page.getByRole('menu', { name: 'Project actions' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /CP only/ })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Focus chain/ })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Critical path/ })).toBeVisible();
    await expect(menu.getByRole('menuitemcheckbox', { name: /Milestones/ })).toBeVisible();
  });
});

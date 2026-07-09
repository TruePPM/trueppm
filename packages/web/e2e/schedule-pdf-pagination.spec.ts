/**
 * E2E for the row-aware, header-repeating PDF pagination (issue 1694, ADR-0276).
 *
 * A tall schedule (many rows across several phases, with FS dependencies) overflows
 * one landscape page. The export must break on safe row/block boundaries and repeat
 * the Activity + date-scale header on continuation pages — producing a MULTI-page
 * PDF, end to end, in a real browser (exercising getBoundingClientRect measurement,
 * the vertical planner, the canvas header re-composite, and the pdf.text captions).
 * The acceptance here is that the real pipeline produces a valid multi-page download
 * without throwing or hanging; the page-break math itself is unit-tested.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-schedpag-0000-0000-0000-000000001694';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}/schedule`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Migration Tooling',
    description: '',
    start_date: '2026-02-17',
    calendar: 'default',
  },
];

// Four phases × five child tasks in a dense FS staircase — tall enough to paginate.
const PHASES = ['Assess', 'Build', 'Migrate', 'Validate'] as const;
function buildTasks() {
  const tasks: Record<string, unknown>[] = [];
  const deps: Record<string, unknown>[] = [];
  let day = new Date(Date.UTC(2026, 1, 17));
  let prevId: string | null = null;
  PHASES.forEach((phase, p) => {
    const phaseId = `phase-${p}`;
    const phaseStart = new Date(day);
    tasks.push({
      id: phaseId,
      wbs_path: String(p + 1),
      name: phase,
      is_summary: true,
      is_milestone: false,
      is_critical: true,
      parent_id: null,
      percent_complete: 0,
      status: 'IN_PROGRESS',
      assignees: [],
      total_float: 0,
      predecessor_count: 0,
      is_blocked: false,
      linked_risks_count: 0,
      linked_risks_max_severity: null,
    });
    for (let c = 0; c < 5; c++) {
      const id = `t-${p}-${c}`;
      const start = new Date(day);
      const finish = new Date(day);
      finish.setUTCDate(finish.getUTCDate() + 5);
      tasks.push({
        id,
        wbs_path: `${p + 1}.${c + 1}`,
        name: `${phase} task ${c + 1}`,
        early_start: start.toISOString().slice(0, 10),
        early_finish: finish.toISOString().slice(0, 10),
        planned_start: start.toISOString().slice(0, 10),
        duration: 4,
        percent_complete: p === 0 ? 100 : 0,
        is_critical: true,
        is_milestone: false,
        is_summary: false,
        parent_id: phaseId,
        status: p === 0 ? 'COMPLETE' : 'NOT_STARTED',
        assignees: [],
        total_float: 0,
        predecessor_count: prevId ? 1 : 0,
        is_blocked: false,
        linked_risks_count: 0,
        linked_risks_max_severity: null,
      });
      if (prevId) {
        deps.push({ id: `d-${id}`, predecessor: prevId, successor: id, dep_type: 'FS', lag: 0 });
      }
      prevId = id;
      day = new Date(finish);
      day.setUTCDate(day.getUTCDate() + 1);
    }
    // set phase early_start/finish to span its children
    (tasks.find((t) => t.id === phaseId) as Record<string, unknown>).early_start = phaseStart
      .toISOString()
      .slice(0, 10);
    (tasks.find((t) => t.id === phaseId) as Record<string, unknown>).early_finish = day
      .toISOString()
      .slice(0, 10);
  });
  return { tasks, deps };
}

const { tasks: FIXTURE_TASKS, deps: FIXTURE_DEPS } = buildTasks();

test('a tall schedule exports as a multi-page PDF with repeated headers', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    dependencies: FIXTURE_DEPS,
  });
  await page.route('**/api/v1/tasks/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: FIXTURE_TASKS.length,
        next: null,
        previous: null,
        results: FIXTURE_TASKS,
      }),
    }),
  );

  await page.goto(BASE_URL);
  const toolbar = page.getByRole('toolbar', { name: 'Schedule toolbar' });
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
  // #1741: Export is now an item in the Actions (⋯) menu, not a standalone button.
  await toolbar.getByRole('button', { name: 'Project actions' }).click();
  await page
    .getByRole('menu', { name: 'Project actions' })
    .getByRole('menuitem', { name: 'Export schedule as PDF…' })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Export schedule' });
  await expect(dialog).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Export PDF' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^Migration_Tooling_Schedule_\d{4}-\d{2}-\d{2}\.pdf$/);

  // The pipeline reaches success (no throw/hang through the vertical-pagination path).
  await expect(dialog.getByRole('heading', { name: /PDF ready/ })).toBeVisible({ timeout: 30_000 });

  // Parse the saved PDF and confirm it is genuinely multi-page (row-aware pagination
  // split the tall report rather than cramming/cutting it into one page).
  const path = await download.path();
  const { readFileSync } = await import('fs');
  const bytes = readFileSync(path);
  const pageCount = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pageCount).toBeGreaterThan(1);
});

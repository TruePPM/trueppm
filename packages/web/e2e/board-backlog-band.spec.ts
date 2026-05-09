/**
 * E2E for the Board BACKLOG rail (epic #361 child A, ADR-0057, Claude Design).
 *
 * Drag-and-drop with dnd-kit is notoriously brittle in Playwright (pointer
 * events go to the canvas surrounded by sortable contexts), so this spec
 * focuses on the structural / configurational claims:
 *   - BACKLOG cards render in the left rail, not in a phase column
 *   - Header eyebrow + count reflect the data (no stalled treatment — see #381)
 *   - Collapse toggle hides the body and reveals the 44px vertical strip
 *   - Empty state copy renders with no backlog cards
 *
 * The drag rules (TO DO → confirm, IN_PROGRESS+ blocked) are exercised by
 * the BoardView and BacklogDemoteConfirmDialog unit tests; this E2E asserts
 * the surface those flows depend on.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-band-00000000-0000-0000-0000-000000000361';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Backlog Rail Test Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function commonTaskShape() {
  return {
    early_start: '2026-04-05',
    early_finish: '2026-04-10',
    duration: 5,
    percent_complete: 0,
    is_critical: false,
    is_milestone: false,
    is_summary: false,
    assignees: [],
    total_float: null,
    predecessor_count: 0,
    is_blocked: false,
    linked_risks_count: 0,
    linked_risks_max_severity: null,
  };
}

const SUMMARY_TASK = {
  id: 'phase-1', wbs_path: '1', name: 'Discovery',
  early_start: '2026-04-05', early_finish: '2026-04-30',
  duration: 25, percent_complete: 30, is_critical: false,
  is_milestone: false, is_summary: true, parent_id: null,
  status: 'IN_PROGRESS', assignees: [], total_float: null,
  predecessor_count: 0, is_blocked: false,
  linked_risks_count: 0, linked_risks_max_severity: null,
};

const COMMITTED_TASK = {
  id: 'committed-1', wbs_path: '1.1', name: 'Stakeholder interviews',
  parent_id: 'phase-1', status: 'IN_PROGRESS',
  ...commonTaskShape(),
};

const BACKLOG_TASK_A = {
  id: 'backlog-a', wbs_path: '1.2', name: 'Tone-of-voice study',
  parent_id: 'phase-1', status: 'BACKLOG',
  ...commonTaskShape(),
  // Recent — not stalled.
  status_changed_at: new Date(Date.now() - 1 * 86_400_000).toISOString(),
};

const BACKLOG_TASK_B = {
  id: 'backlog-b', wbs_path: '1.3', name: 'Audit existing UX flows',
  parent_id: 'phase-1', status: 'BACKLOG',
  ...commonTaskShape(),
  // 7 days old — stalled (≥ 5d).
  status_changed_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
};

async function setup(page: import('@playwright/test').Page, tasks: object[]) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks,
    statusSummary: { task_count: tasks.length },
  });
  await page.route('**/api/v1/tasks/**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: tasks.length, next: null, previous: null, results: tasks }),
    });
  });
}

test.describe('Board BACKLOG rail (ADR-0057, epic #361 child A)', () => {
  test.beforeEach(() => {
    // Each test starts with the rail expanded. Playwright runs in a fresh
    // browser context per test so localStorage is empty by default; this is
    // a defensive guard for parallel runs reusing the preview server.
  });

  test('renders BACKLOG cards inside the left rail, not a phase column', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_TASK_A, BACKLOG_TASK_B]);
    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(rail.getByText('Inbox · backlog')).toBeVisible();
    await expect(rail.getByText('Tone-of-voice study')).toBeVisible();
    await expect(rail.getByText('Audit existing UX flows')).toBeVisible();
    // Plural copy on the rail header — the aside carries the accessible name
    // from the count heading via aria-labelledby.
    await expect(
      page.getByRole('complementary', { name: /2 ideas in backlog/i }),
    ).toBeVisible();
  });

  test('uses singular copy for one backlog idea', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_TASK_A]);
    await page.goto(`${BASE_URL}/board`);

    await expect(
      page.getByRole('complementary', { name: /1 idea in backlog/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('renders the empty-state hint when no backlog cards exist', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK]);
    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail).toBeVisible({ timeout: 10_000 });
    await expect(rail.getByText(/No backlog yet/)).toBeVisible();
  });

  test('does not surface a stalled signal even when an idea has been sitting for days', async ({ page }) => {
    // Stalled is a commitment-progression concept — it does not apply to
    // BACKLOG ideas. An old idea in the inbox isn't a problem; that's
    // literally what the inbox is for. Guards against the badge accidentally
    // re-leaking onto rail cards (#381 follow-up).
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_TASK_A, BACKLOG_TASK_B]);
    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail.getByText(/Inbox · backlog/i)).toBeVisible({ timeout: 10_000 });
    await expect(rail.locator('[aria-label*="stalled" i]')).toHaveCount(0);
    await expect(rail.getByText(/stalled/i)).toHaveCount(0);
  });

  test('synthetic Project Tasks lane defaults task creation to BACKLOG (issue #387)', async ({ page }) => {
    // #387 — Option C from the VoC panel. On a phase-less project the
    // Project Tasks lane is intake scaffolding, so its "+" button reads
    // "Add to backlog" and TaskFormModal opens with status pre-set to
    // BACKLOG. Phase lanes are unaffected (covered by board.spec.ts).
    const PHASE_LESS_BACKLOG = {
      id: 'idea-387',
      wbs_path: '1',
      name: 'Refine landing copy',
      parent_id: null,
      status: 'BACKLOG',
      ...commonTaskShape(),
      status_changed_at: new Date().toISOString(),
    };
    await setup(page, [PHASE_LESS_BACKLOG]);
    await page.goto(`${BASE_URL}/board`);

    const addBtn = page.getByRole('button', { name: 'Add to backlog' });
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();

    const dialog = page.getByRole('dialog', { name: /Add to backlog/i });
    await expect(dialog).toBeVisible();

    // Status selector must default to "Backlog" so the user doesn't have to
    // override every time on a phase-less project.
    const statusSelect = dialog.getByLabel(/Status/i);
    await expect(statusSelect).toHaveValue('BACKLOG');
  });

  test('phase-less project still renders Project Tasks lane as a drop target (issue #386)', async ({ page }) => {
    // Fixture: ONE backlog card, NO summary tasks, NO committed cards.
    // Without #386 the grid renders the empty-state copy and the rail's
    // "Drag right onto a phase" affordance has no target; with the fix
    // the synthetic Project Tasks lane appears with the four status columns.
    const PHASE_LESS_BACKLOG = {
      id: 'idea-phaseless',
      wbs_path: '1',
      name: 'Polish onboarding copy',
      parent_id: null,
      status: 'BACKLOG',
      ...commonTaskShape(),
      status_changed_at: new Date().toISOString(),
    };
    await setup(page, [PHASE_LESS_BACKLOG]);
    await page.goto(`${BASE_URL}/board`);

    // Rail still shows the idea so it can be dragged.
    const rail = page.getByTestId('backlog-band');
    await expect(rail.getByText('Polish onboarding copy')).toBeVisible({ timeout: 10_000 });

    // Empty-state copy must NOT render — the synthetic lane keeps the grid alive.
    await expect(page.getByText(/No tasks yet\. Create tasks to see them on the board/)).toHaveCount(0);

    // Project Tasks lane appears with the four status columns to drop onto.
    await expect(page.getByText('Project Tasks')).toBeVisible();
    await expect(page.getByRole('heading', { name: /^To Do,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^In Progress,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Review,/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Done,/ })).toBeVisible();
  });

  test('collapses to a 44px vertical strip and re-expands via the toggle', async ({ page }) => {
    await setup(page, [SUMMARY_TASK, COMMITTED_TASK, BACKLOG_TASK_A]);
    await page.goto(`${BASE_URL}/board`);

    const rail = page.getByTestId('backlog-band');
    await expect(rail.getByText('Tone-of-voice study')).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Collapse backlog rail' }).click();
    await expect(rail.getByText('Tone-of-voice study')).not.toBeVisible();

    await page.getByRole('button', { name: /Expand backlog rail/i }).click();
    await expect(rail.getByText('Tone-of-voice study')).toBeVisible();
  });
});

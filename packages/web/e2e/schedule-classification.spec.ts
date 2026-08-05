/**
 * Declaring the hybrid split, end to end (#2736 + #2737).
 *
 * The act and its result ship together on purpose: a cascade with no visible
 * outcome is a popover that appears to do nothing. So each flow here ends on
 * what the outline shows, not on the request that was sent.
 *
 * Reads and the cascade share one stateful store (`setupTaskStore`). The
 * popover invalidates `['tasks', projectId]` on success, so a stateless task
 * mock would re-serve the pre-cascade fixture and the mode chip would appear
 * and then vanish — the #2752 class of flake, which no timeout can fix.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import { setupTaskStore } from './fixtures/task-store';

const PROJECT_ID = 'e2e-class-0000-0000-0000-000000002736';
const BASE_URL = `/projects/${PROJECT_ID}/schedule`;

const PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Hybrid Split Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
  },
];

function row(
  id: string,
  wbs: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    wbs_path: wbs,
    name,
    early_start: '2026-04-05',
    early_finish: '2026-04-09',
    planned_start: '2026-04-05',
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
    ...extra,
  };
}

// Phase 4 with three children, one of which is a gate. Mirrors the design
// handoff's case 04: 4.1 keeps a gated override, 4.2/4.3 go sprint-driven,
// and the gate must survive untouched.
const TASKS = [
  row('t4', '4', 'Build & integration', { is_summary: true }),
  row('t41', '4.1', 'Structural steel', {
    parent_id: 't4',
    governance_class: 'gated',
    parent_governance_inherited: false,
  }),
  row('t42', '4.2', 'Control software', { parent_id: 't4' }),
  row('t43', '4.3', 'Comms cutover', { parent_id: 't4' }),
  row('t4g', '4.4', 'Integration gate', {
    parent_id: 't4',
    is_milestone: true,
    delivery_mode: 'milestone',
    duration: 0,
  }),
];

test.describe('Hybrid classification — declare it once, then see it (#2736/#2737)', () => {
  test.beforeEach(async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: PROJECTS,
      projectId: PROJECT_ID,
      tasks: TASKS,
    });
    // Registered last so it owns the task reads AND the cascade write.
    await setupTaskStore(page, { tasks: TASKS });
  });

  test('⌘⇧M on the focused row opens the popover naming the subtree', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');

    const popover = page.getByTestId('classification-popover');
    await expect(popover).toBeVisible();
    await expect(popover).toContainText('Build & integration');
    await expect(popover).toContainText('4 descendants');
  });

  test('the row menu reaches the same popover without knowing the shortcut', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click({ button: 'right' });
    await page
      .getByRole('menu', { name: 'Row actions' })
      .getByRole('menuitem', { name: /Classification/ })
      .click();
    await expect(page.getByTestId('classification-popover')).toBeVisible();
  });

  test('the preview names the milestone it will not touch, before applying', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-preset-scrum').click();

    const preview = page.getByTestId('classification-preview');
    await expect(preview).toContainText('1 milestone unchanged');
    await expect(preview).toContainText('a gate is not a delivery mode');
    // Only governance can report an override count; delivery mode says why not.
    await expect(preview).toContainText('governance overrides kept');
    await expect(preview).toContainText('has no inherit bit');
  });

  test('applying a preset makes the split visible in the outline', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Control software').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    // Just this row, so the phase ends up genuinely mixed.
    await page.getByTestId('classification-cascade').uncheck();
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    await expect(page.getByTestId('classification-popover')).toHaveCount(0);

    // The result, not the request: 4.2 reads SCRUM and its parent reads MIXED
    // because 4.1/4.3 are still gated.
    const row42 = page.getByRole('row').filter({ hasText: 'Control software' });
    await expect(row42.getByTestId('mode-chip')).toHaveText('SCRUM');
    const phase = page.getByRole('row').filter({ hasText: 'Build & integration' });
    await expect(phase.getByTestId('mode-chip')).toHaveText('MIXED');
  });

  test('the gate keeps its delivery mode through a cascade over the whole phase', async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await page.getByTestId('classification-preset-scrum').click();
    await page.getByTestId('classification-apply').click();

    // Every non-milestone row is now scrum, so the phase reads SCRUM rather
    // than MIXED — the gate contributed nothing, which is the invariant.
    const phase = page.getByRole('row').filter({ hasText: 'Build & integration' });
    await expect(phase.getByTestId('mode-chip')).toHaveText('SCRUM');
    const gate = page.getByRole('row').filter({ hasText: 'Integration gate' });
    await expect(gate.getByTestId('mode-chip')).toHaveCount(0);
  });

  test('a gated plan carries no mode chips at all', async ({ page }) => {
    // The baseline draws nothing, matching the canvas. A 400-row gated plan
    // must not carry 400 identical marks.
    await page.goto(BASE_URL);
    await expect(page.getByText('Build & integration')).toBeVisible();
    await expect(page.getByTestId('mode-chip')).toHaveCount(0);
    await expect(page.getByTestId('mode-gutter')).toHaveCount(0);
  });

  test('Escape closes the popover without writing anything', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.getByText('Build & integration').click();
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await expect(page.getByTestId('classification-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('classification-popover')).toHaveCount(0);
    await expect(page.getByTestId('mode-chip')).toHaveCount(0);
  });
});

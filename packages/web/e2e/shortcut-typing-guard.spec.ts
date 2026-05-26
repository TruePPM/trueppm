/**
 * E2E: single-key shortcuts are suppressed while typing in a field (#644).
 *
 * Regression guard for the isTypingInInput() helper — a literal `?` typed into
 * a text input must NOT open the keyboard cheatsheet. The "Save current view"
 * input is used deliberately: board shortcuts stay *enabled* while it is open
 * (unlike the add-task modal, which sets `enabled=false`), so this isolates the
 * typing guard rather than the board's modal-owns-keyboard gate.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const FIXTURE_PROJECT_ID = 'e2e-kbd-00000000-0000-0000-0000-000000000644';
const BASE_URL = `/projects/${FIXTURE_PROJECT_ID}`;

const FIXTURE_PROJECTS = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Shortcut Guard Project',
    description: '',
    start_date: '2026-01-01',
    calendar: 'default',
  },
];

const FIXTURE_TASKS = [
  {
    id: 'k1', wbs_path: '1', name: 'Alpha Phase',
    early_start: '2026-01-05', early_finish: '2026-02-14',
    duration: 30, percent_complete: 50, is_critical: false,
    is_milestone: false, is_summary: true, parent_id: null,
    status: 'IN_PROGRESS', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
  {
    id: 'k2', wbs_path: '1.1', name: 'Design',
    early_start: '2026-01-05', early_finish: '2026-01-16',
    planned_start: '2026-01-05',
    duration: 10, percent_complete: 100, is_critical: false,
    is_milestone: false, is_summary: false, parent_id: 'k1',
    status: 'COMPLETE', assignees: [], total_float: null,
    predecessor_count: 0, is_blocked: false,
    linked_risks_count: 0, linked_risks_max_severity: null,
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, {
    projects: FIXTURE_PROJECTS,
    projectId: FIXTURE_PROJECT_ID,
    tasks: FIXTURE_TASKS,
    statusSummary: { task_count: 1 },
  });
}

test.describe('Single-key shortcut typing guard (#644)', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page);
    await page.goto(`${BASE_URL}/board`);
    await expect(page.getByText('Alpha Phase')).toBeVisible({ timeout: 10_000 });
  });

  test('? opens the cheatsheet on the board surface (positive control)', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeVisible();
  });

  test('? does not fire while a text input is focused', async ({ page }) => {
    // Open the "Save current view" input — board shortcuts remain enabled here.
    await page.getByRole('button', { name: /^Board view:/ }).click();
    await page.getByRole('menuitem', { name: /Save current view/ }).click();

    const input = page
      .getByRole('dialog', { name: 'Save current view' })
      .getByRole('textbox', { name: 'View name' });
    await expect(input).toBeFocused();

    await page.keyboard.press('?');

    // The board's `?` shortcut must be suppressed: no cheatsheet…
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeVisible();
    // …and the keystroke lands in the input instead.
    await expect(input).toHaveValue('?');
  });
});

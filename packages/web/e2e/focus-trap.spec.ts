/**
 * E2E for the shared `useFocusTrap` migration (#2148 / #2193).
 *
 * A generation of aria-modal dialogs hand-rolled (or omitted) focus handling, so
 * Tab walked out behind the scrim and focus was never restored to the trigger on
 * close (WCAG 2.4.3 / 2.1.2). Those surfaces now share `useFocusTrap`. The hook
 * itself is unit-tested (`hooks/useFocusTrap.test.tsx`) and each dialog has its
 * own component test; this spec is the integration foothold the issue asks for —
 * it drives one representative migrated dialog (the ⌘K command palette) end to
 * end and asserts the three things a real trap must do: seat focus inside on
 * open, keep Tab from escaping, and restore focus to the trigger on close.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll, setupTaskStore } from './fixtures';

/**
 * Walk the whole trap in one direction and assert focus never leaves it (#3208).
 *
 * Deliberately a bounded press-loop rather than "query the tab stops, focus the
 * last one, press Tab once": the query would mean hand-copying
 * `FOCUSABLE_SELECTOR` into this spec, which is the exact duplication #3208
 * exists to delete — and a spec carrying its own copy would keep passing after
 * the shared one regressed. Pressing past the end of the real tab order is what
 * surfaces the bug, and `steps` is sized to exceed either dialog's stop count.
 *
 * **The BACKWARD direction is the load-bearing one.** When the roving members
 * trail the dialog (the CommandPalette shape), a forward-only walk can look
 * clean while the trap's `last` points at an element the tab order never
 * reaches — which is how this regression shipped twice.
 */
async function expectFocusStaysInside(
  page: import('@playwright/test').Page,
  dialog: import('@playwright/test').Locator,
  { steps = 14 }: { steps?: number } = {},
) {
  for (const key of ['Tab', 'Shift+Tab'] as const) {
    for (let i = 0; i < steps; i++) {
      await page.keyboard.press(key);
      const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
      expect(inside, `focus escaped the dialog after ${i + 1} x ${key}`).toBe(true);
    }
  }
}

const PROJECT_ID = 'e2e-trap-0000-0000-0000-000000002148';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Focus Trap Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'trap-prog-1', name: 'Trap Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('focus-trap migration (#2148/#2193)', () => {
  test('command palette traps focus and restores it to the trigger on close', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // Gate on the shell painting before driving keyboard chrome.
    await expect(
      page.getByRole('complementary', { name: 'Primary navigation' }),
    ).toBeVisible({ timeout: 10_000 });

    // Put focus on a stable, identifiable trigger. The skip link is the shell's
    // first focusable element and is always present, so it is a deterministic
    // "previously focused" anchor for the restore assertion.
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await skipLink.focus();
    await expect(skipLink).toBeFocused();

    // Open the palette. The trap captures the trigger (skip link) as the element
    // to restore to, synchronously, before the palette's own input-focus fires.
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    // Seat: focus moved into the dialog (onto the search combobox).
    const search = palette.getByRole('combobox');
    await expect(search).toBeFocused();

    // Trap: Tab must not walk focus out behind the scrim — it stays in the dialog.
    await page.keyboard.press('Tab');
    const focusStillInside = await palette.evaluate(
      (el) => el.contains(document.activeElement),
    );
    expect(focusStillInside).toBe(true);

    // Restore: Escape closes and returns focus to the trigger, not <body>.
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
    await expect(skipLink).toBeFocused();
  });

  // #3208. The palette's result rows are `<button role="option" tabIndex={-1}>`
  // roving members and they TRAIL the dialog, so the old selector — which only
  // applied `:not([tabindex="-1"])` to its generic `[tabindex]` branch — counted
  // the last row as the trap's `last`. Nobody can ever be focused there, so the
  // forward wrap branch never fired from the real last stop and Tab walked out.
  test('Tab and Shift+Tab both stay inside the palette despite roving option rows', async ({
    page,
  }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(
      page.getByRole('complementary', { name: 'Primary navigation' }),
    ).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    // Gate on the rows actually being rendered — the roving members are the
    // whole premise, and an empty listbox would make this vacuous.
    await expect(palette.getByRole('option').first()).toBeVisible();

    await expectFocusStaysInside(page, palette);
  });
});

const DEP_PROJECT_ID = 'e2e-trap-dep-0000-0000-000000003208';

function depTaskRow(id: string, wbs: string, name: string) {
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
    linked_risks_biggest: null,
    linked_risks_max_severity: null,
  };
}

const DEP_TASKS = [depTaskRow('dt1', '1', 'Cutover'), depTaskRow('dt2', '2', 'Power drop')];

/**
 * The picker's scope tabs render only when the project belongs to a program
 * (`canCrossProject = Boolean(programId)`), so this fixture carries one — a
 * program-less project would render no ScopeTabs and make the spec vacuous.
 */
const DEP_PROJECT = {
  id: DEP_PROJECT_ID,
  name: 'Trap Depot',
  description: '',
  start_date: '2026-04-01',
  calendar: 'default',
  program: 'trap-prog-3208',
  program_detail: { id: 'trap-prog-3208', name: 'Trap Program' },
};

test.describe('dependency picker focus trap (#3208)', () => {
  // A LATENT-instance guard, not a reproduction — and the distinction is
  // measured, not assumed. #3208 listed this dialog as a live Shift+Tab escape;
  // it is not. The header's Close button is a real tab stop and precedes the
  // tablist, so the roving ScopeTabs are never the trap's `first` and this spec
  // passes on the broken selector too (negative-control verified). What saves it
  // is DOM order alone, which is exactly what #3130 proved expires on the next
  // reorder, so the walk stays. The live instance is the palette case above.
  test('Shift+Tab stays inside the dialog despite roving scope tabs', async ({ page }) => {
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page, {
      projects: [DEP_PROJECT],
      projectId: DEP_PROJECT_ID,
      tasks: DEP_TASKS,
    });
    await setupTaskStore(page, { tasks: DEP_TASKS });

    await page.goto(`/projects/${DEP_PROJECT_ID}/schedule`);
    await expect(page.getByText('Cutover')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Cutover').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Row actions' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /Add dependency/ }).click();

    const dialog = page.getByRole('dialog', { name: /Add dependency/ });
    await expect(dialog).toBeVisible();
    // Gate on the roving tabs existing — they are the premise of this spec.
    await expect(dialog.getByRole('tab')).toHaveCount(2);

    await expectFocusStaysInside(page, dialog);
  });
});

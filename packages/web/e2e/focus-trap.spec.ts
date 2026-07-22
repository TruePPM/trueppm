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
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

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
});

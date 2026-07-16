/**
 * E2E for the global `?` keyboard-shortcuts hotkey (#2058).
 *
 * The app-wide KeyboardShortcutsModal was previously reachable only from the
 * UserMenu. This asserts the new global `?` binding opens it from a non-board
 * surface (Overview), that it lists the previously-omitted wired bindings, and
 * that it is suppressed while typing in a text field.
 */
import { test, expect } from '@playwright/test';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-helpkey-0000-0000-0000-000000002058';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Help Hotkey Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'helpkey-prog-1', name: 'Hotkey Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('global ? keyboard-shortcuts hotkey (#2058)', () => {
  test('? opens the global shortcuts modal and Esc closes it', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    // Wait for the shell to paint before firing the hotkey.
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible({
      timeout: 10_000,
    });

    // Ensure focus is on a neutral (non-editable) element, as it would be for a
    // user pressing `?` on the page — the guard deliberately suppresses `?` when
    // a field happens to be focused (covered by the second test).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    // A binding unique to the unified global modal (the board cheatsheet omits it).
    await expect(dialog.getByText('Save your changes')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('? is suppressed while typing in a text field', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);
    await expect(page.getByRole('complementary', { name: 'Primary navigation' })).toBeVisible({
      timeout: 10_000,
    });

    // Focus the command-palette search input, then press `?` — it must land as
    // text in the field, never open the modal.
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('combobox').or(page.getByRole('textbox')).first();
    await expect(search).toBeVisible();
    await search.focus();
    await page.keyboard.press('?');

    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeVisible();
    await expect(search).toHaveValue('?');
  });
});

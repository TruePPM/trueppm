/**
 * E2E for the ⌘/Ctrl+B sidebar collapse hotkey (#1193, v2 row 14, ADR-0127).
 *
 * The collapse button's tooltip has always advertised ⌘/Ctrl+B, but the chord
 * was never bound. This asserts the binding now honors the advertised shortcut:
 * it hides the rail and shows it again, and it yields the chord (= bold) while a
 * text field is focused.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

const PROJECT_ID = 'e2e-sbhotkey-0000-0000-0000-000000001193';

const FIXTURE_PROJECTS = [
  {
    id: PROJECT_ID,
    name: 'Sidebar Hotkey Project',
    description: '',
    start_date: '2026-04-01',
    calendar: 'default',
    program_detail: { id: 'sbhotkey-prog-1', name: 'Hotkey Program' },
  },
];

async function setup(page: import('@playwright/test').Page) {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page, { projects: FIXTURE_PROJECTS, projectId: PROJECT_ID });
}

test.describe('sidebar collapse hotkey (#1193)', () => {
  test('⌘/Ctrl+B hides the rail and shows it again', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // ControlOrMeta resolves to ⌘ on macOS and Ctrl elsewhere — matches the hook.
    await page.keyboard.press('ControlOrMeta+b');
    await expect(rail).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show navigation' })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+b');
    await expect(rail).toBeVisible();
  });

  test('the chord is ignored while a text field is focused (it stays bold)', async ({ page }) => {
    await setup(page);
    await page.goto(`/projects/${PROJECT_ID}/overview`);

    const rail = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(rail).toBeVisible({ timeout: 10_000 });

    // Open the command palette (⌘K) and focus its search input, then fire ⌘B.
    // The palette guard + editable-target guard must both keep the rail shown.
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('combobox').or(page.getByRole('textbox')).first();
    await expect(search).toBeVisible();
    await search.focus();
    await page.keyboard.press('ControlOrMeta+b');

    await page.keyboard.press('Escape');
    await expect(rail).toBeVisible();
  });
});

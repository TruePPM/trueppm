/**
 * E2E for the shell v2 Pass 3 shared primitives (#4802, rule 471) behind
 * `?ff=shell_v2`, mounted on the page-kit fixture with `&p3=1`: the dialog's
 * trap / Escape / scrim, the banner taking the toolbar row inside the 191px
 * budget, the trail, 44px targets, and axe in both themes.
 */
import { test, expect, type Page } from './fixtures/coverage';
import { expectNoA11yViolations, setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

async function open(page: Page, query = '', theme?: 'dark') {
  if (theme) await page.addInitScript((t) => localStorage.setItem('trueppm.theme', t), theme);
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page);
  // The rail's Work flyout reads the member-scoped program list.
  await page.route('**/api/v1/programs/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    }),
  );
  await page.goto(`/shell2/kit?ff=shell_v2&p3=1${query}`);
  await expect(page.getByRole('list', { name: 'Change trail' })).toBeVisible({ timeout: 10_000 });
}

const bodyTop = async (page: Page) =>
  (await page.getByTestId('page-frame-body').boundingBox())?.y ?? Number.NaN;

test.describe('shell v2 Pass 3 primitives', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('dialog traps focus, closes on Escape and scrim, and restores focus', async ({
    page,
  }, testInfo) => {
    await open(page);
    const trigger = page.getByRole('button', { name: 'Re-baseline' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Re-baseline' });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Close' });
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await expectNoA11yViolations(page, testInfo);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByTestId('modal-scrim').click({ position: { x: 5, y: 5 } });
    await expect(dialog).toHaveCount(0);
  });

  test('the banner takes the toolbar row and costs no height', async ({ page }) => {
    await open(page);
    const plain = await bodyTop(page);
    await open(page, '&banner=1');
    await expect(page.getByTestId('page-frame-toolbar')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('didn’t post');
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);
    expect(Math.abs((await bodyTop(page)) - plain)).toBeLessThanOrEqual(1);
  });

  test('trail, stepper targets and axe in light', async ({ page }, testInfo) => {
    await open(page, '&banner=1');
    const trail = page.getByRole('list', { name: 'Change trail' });
    await expect(trail).toContainText('Scope added');
    await expect(trail).toContainText('Float 3 → 0');
    await expect(trail.getByRole('button')).toHaveCount(0);
    for (const name of ['Decrease Allocation', 'Increase Allocation']) {
      const box = await page.getByRole('button', { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    await expectNoA11yViolations(page, testInfo);
  });

  test('dark theme is axe clean, page and dialog', async ({ page }, testInfo) => {
    await open(page, '&banner=1', 'dark');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expectNoA11yViolations(page, testInfo);
    await page.getByRole('button', { name: 'Re-baseline' }).click();
    await expect(page.getByRole('dialog', { name: 'Re-baseline' })).toBeVisible();
    await expectNoA11yViolations(page, testInfo);
  });
});

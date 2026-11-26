/**
 * E2E for the shell v2 Pass 3 shared primitives (#4802, rule 471) behind
 * `?ff=shell_v2`, mounted on the page-kit fixture with `&p3=1`: the dialog's
 * trap / Escape / scrim, the banner taking the toolbar row inside the 191px
 * budget, the trail, 44px targets, and axe in both themes.
 */
import { test, expect, type Locator, type Page } from './fixtures/coverage';
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

test.describe('shell v2 Pass 3 primitives at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the page never scrolls sideways', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });

  test('the grid name column stays on top when scrolled sideways', async ({ page }) => {
    await open(page);
    const grid = page.getByRole('region', { name: 'Team load, next 13 weeks, scrollable' });
    await grid.scrollIntoViewIfNeeded();
    expect(await grid.evaluate((el) => (el.scrollLeft = 200))).toBe(200);
    for (const header of await grid.locator('tbody th').all()) {
      await header.scrollIntoViewIfNeeded();
      // A later positioned cell that paints over the sticky header would be the hit.
      const onTop = await header.evaluate((th) => {
        const box = th.getBoundingClientRect();
        return th.contains(
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
        );
      });
      expect(onTop).toBe(true);
    }
    expect(await grid.evaluate((el) => el.scrollLeft)).toBe(200);
  });
});

test.describe('shell v2 Pass 3 primitives under a coarse pointer', () => {
  // Wider than `md`, so the compact fine-pointer sizes would apply by width alone.
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });

  const atLeast44 = async (target: Locator, name: string, widthToo = true) => {
    const box = await target.boundingBox();
    expect(box?.height, `${name} height`).toBeGreaterThanOrEqual(44);
    if (widthToo) expect(box?.width, `${name} width`).toBeGreaterThanOrEqual(44);
  };

  test('reason rows, scope boxes, dialog close and banner are 44px', async ({ page }) => {
    await open(page, '&banner=1');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    await atLeast44(page.getByRole('alert'), 'banner', false);

    const reasons = page.getByRole('group', { name: 'Why did it move?' }).locator('label');
    await expect(reasons).toHaveCount(2);
    for (const row of await reasons.all()) await atLeast44(row, 'reason row');

    const scope = page.getByRole('table', { name: 'Agent scope' });
    const boxes = scope.locator('label');
    await expect(boxes).toHaveCount(5);
    for (const box of await boxes.all()) await atLeast44(box, 'scope box');

    await page.getByRole('button', { name: 'Re-baseline' }).tap();
    const dialog = page.getByRole('dialog', { name: 'Re-baseline' });
    // The panel scales in; measure once it has settled.
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await atLeast44(dialog.getByRole('button', { name: 'Close' }), 'dialog close');
  });
});

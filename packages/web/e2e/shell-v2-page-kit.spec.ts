/**
 * E2E for the shell v2 Pass 2 page kit (#4795, rule 439) behind `?ff=shell_v2`.
 *
 * Mounts the kit fixture page — the page frame, the table, the empty and the
 * error state, inside the real shell — and checks the geometry jsdom cannot:
 * gutters per breakpoint, the 1120 cap, the page starting at or above 191px,
 * row heights at desktop vs phone, the sticky identity column's edge once the
 * table scrolls, and axe in both themes.
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
  await page.goto(`/shell2/kit?ff=shell_v2${query}`);
  await expect(page.getByTestId('shell2')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Page kit' })).toBeVisible();
}

const body = (page: Page) => page.getByTestId('page-frame-body');
const table = (page: Page) => page.getByRole('region', { name: 'Fixture tasks' });

test.describe('shell v2 page kit', () => {
  test.describe('desktop 1440', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('frame, table, empty and error state render on the conventions', async ({
      page,
    }, testInfo) => {
      await open(page);

      // The PAGE (the body, below the title and toolbar rows) starts at 191px or
      // less; gutter 32; content capped at 1120. Measured on the body, not the
      // frame: the frame's top sits just under the top bar whatever stacks inside it.
      const top = (await body(page).boundingBox())?.y ?? Infinity;
      expect(top).toBeLessThanOrEqual(191);
      await expect(body(page)).toHaveCSS('padding-left', '32px');
      const inner = (await body(page).locator('> div').boundingBox())?.width ?? 0;
      expect(inner).toBeLessThanOrEqual(1120);

      // The table skeleton's rows are the table's rows.
      const ghost = page.getByTestId('skeleton-row').first();
      expect(Math.round((await ghost.boundingBox())?.height ?? 0)).toBe(36);

      // Table: 32px header, 36px rows, numbers right-aligned.
      const header = table(page).getByRole('columnheader', { name: 'Task' });
      expect((await header.boundingBox())?.height).toBe(32);
      const row = table(page).getByRole('row').nth(1);
      expect(Math.round((await row.boundingBox())?.height ?? 0)).toBe(36);
      await expect(table(page).getByRole('columnheader', { name: 'Float (d)' })).toHaveCSS(
        'text-align',
        'right',
      );

      // States: left-aligned empty with two actions; neutral error with a support code.
      const empty = page.getByTestId('empty-state');
      await expect(empty.getByRole('heading', { name: 'No risks logged yet' })).toBeVisible();
      await expect(empty.getByRole('button')).toHaveCount(2);
      const error = page.getByRole('alert').filter({ hasText: 'Support code' });
      await expect(error).toContainText('still work');
      await expect(error).toContainText('APP-091500');

      await expectNoA11yViolations(page, testInfo);
    });

    test('under a project context header the page still starts at 191px or less', async ({
      page,
    }) => {
      const projectId = 'e2e-shell2-0000-0000-0000-000000000001';
      const programId = 'e2e-shell2-prog-0000-0000-000000000001';
      await page.addInitScript(() => {
        localStorage.setItem('trueppm.featureFlags', JSON.stringify({ shell_v2: true }));
      });
      await setupAuth(page);
      await setupCatchAll(page);
      await setupApiMocks(page, {
        projects: [
          {
            id: projectId,
            name: 'Atlas Migration',
            description: '',
            start_date: '2026-04-01',
            calendar: 'default',
            program: programId,
            program_detail: { id: programId, name: 'Platform Modernization' },
          },
        ],
        projectId,
      });
      await page.route('**/api/v1/programs/', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
        }),
      );
      await page.goto(`/projects/${projectId}/shell2-kit`);
      await expect(page.getByTestId('shell2-context-title')).toHaveText('Atlas Migration', {
        timeout: 10_000,
      });
      await expect(page.getByTestId('page-frame-toolbar')).toBeVisible();
      // Real context header (title row + tab row) above the frame: the body is
      // what the budget measures.
      const top = (await body(page).boundingBox())?.y ?? Infinity;
      expect(top).toBeLessThanOrEqual(191);
    });

    test('a filters-applied row replaces the toolbar, never stacks under it', async ({ page }) => {
      await open(page);
      const plainTop = (await body(page).boundingBox())?.y ?? Number.NaN;
      await open(page, '&filtered=1');
      // Replacing the row costs no height: the page starts exactly where it did.
      const filteredTop = (await body(page).boundingBox())?.y ?? Number.NaN;
      expect(Math.abs(filteredTop - plainTop)).toBeLessThanOrEqual(1);
      expect(filteredTop).toBeLessThanOrEqual(191);
      await expect(page.getByTestId('page-frame-toolbar')).toHaveCount(1);
      await expect(page.getByTestId('page-frame-toolbar')).toHaveAttribute('data-override', 'true');
      await expect(page.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    });

    test('dark theme is axe clean', async ({ page }, testInfo) => {
      await open(page, '', 'dark');
      await expect(page.locator('html')).toHaveClass(/dark/);
      await expectNoA11yViolations(page, testInfo);
    });

    test('the definition tip opens on focus and closes on Escape', async ({ page }) => {
      await open(page);
      const term = page.getByRole('button', { name: 'Float', exact: true });
      await term.focus();
      await expect(page.getByRole('tooltip')).toContainText('working days');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    });
  });

  for (const [width, gutter] of [
    [1024, '24px'],
    [768, '20px'],
  ] as const) {
    test.describe(`${width}`, () => {
      test.use({ viewport: { width, height: 900 } });

      test(`${gutter} gutter`, async ({ page }) => {
        await open(page);
        await expect(body(page)).toHaveCSS('padding-left', gutter);
        await expect(body(page)).toHaveCSS('padding-right', gutter);
      });
    });
  }

  test.describe('coarse pointer at desktop width', () => {
    test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true });

    test('page-state actions and the toolbar are 44px targets', async ({ page }) => {
      await open(page);
      const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
      test.skip(!coarse, 'Chromium did not emulate a coarse primary pointer here');
      const empty = page.getByTestId('empty-state');
      for (const name of ['Log a risk', 'Import from CSV']) {
        const box = await empty.getByRole('button', { name }).boundingBox();
        expect(Math.round(box?.height ?? 0)).toBe(44);
      }
    });
  });

  test.describe('phone 390', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('16px gutter, 44px rows, back button, and the identity column edges once scrolled', async ({
      page,
    }) => {
      await open(page);
      await expect(body(page)).toHaveCSS('padding-left', '16px');
      await expect(page.getByRole('button', { name: 'Home' })).toBeVisible();
      for (const name of ['Log a risk', 'Import from CSV']) {
        const box = await page
          .getByTestId('empty-state')
          .getByRole('button', { name })
          .boundingBox();
        expect(Math.round(box?.height ?? 0)).toBe(44);
      }

      const row = table(page).getByRole('row').nth(1);
      expect(Math.round((await row.boundingBox())?.height ?? 0)).toBe(44);
      const ghost = page.getByTestId('skeleton-row').first();
      expect(Math.round((await ghost.boundingBox())?.height ?? 0)).toBe(44);

      const identity = table(page).getByRole('rowheader').first();
      await expect(identity).toHaveCSS('border-right-width', '0px');
      await table(page).evaluate((el) => {
        el.scrollLeft = 120;
      });
      await expect(table(page)).toHaveAttribute('data-scrolled', 'true');
      await expect(identity).toHaveCSS('border-right-width', '1px');
      // The frozen column stays put while the content passes beneath it.
      const regionLeft = (await table(page).boundingBox())?.x ?? 0;
      expect(Math.abs(((await identity.boundingBox())?.x ?? 0) - regionLeft)).toBeLessThanOrEqual(
        1,
      );
    });
  });
});

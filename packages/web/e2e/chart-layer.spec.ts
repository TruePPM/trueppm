import { test, expect } from './fixtures/coverage';

import { expectNoA11yViolations, setupCatchAll } from './fixtures';

/**
 * Shared chart layer (#4767): every chart at the design's sample data, on the
 * public network-free specimen sheet (`/design/charts`).
 *
 * Screenshot baselines are Linux/Chromium (the CI image); they are skipped on
 * other platforms because font rasterization differs by OS and a darwin baseline
 * would fail in CI. Regenerate with the CI Playwright image
 * (`--update-snapshots`), never from a laptop.
 */

const SECTIONS = [
  ['scurve', 'specimen-scurve'],
  ['burndown', 'specimen-burn'],
  ['risk-zones', 'specimen-zones'],
  ['heat', 'specimen-heat'],
] as const;

const VIEWPORTS = [
  ['1440', { width: 1440, height: 900 }],
  ['390', { width: 390, height: 844 }],
] as const;

async function open(page: import('@playwright/test').Page, dark = false) {
  await setupCatchAll(page);
  await page.route('**/api/v1/edition/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        edition: 'community',
        demo_read_only: false,
        demo_login_hint: null,
        demo_reset_schedule: null,
      }),
    }),
  );
  if (dark) {
    await page.addInitScript(() => localStorage.setItem('trueppm.theme', 'dark'));
    await page.emulateMedia({ colorScheme: 'dark' });
  }
  await page.goto('/design/charts');
  await expect(page.getByRole('heading', { name: 'Chart specimens' })).toBeVisible();
  await expect(page.getByTestId('specimen-scurve').getByRole('img').first()).toBeVisible();
  if (dark) await expect(page.locator('html')).toHaveClass(/dark/);
}

test.describe('shared chart layer', () => {
  test.describe('screenshots', () => {
    test.skip(process.platform !== 'linux', 'baselines are Linux/Chromium (CI image)');

    for (const [vpName, viewport] of VIEWPORTS) {
      test.describe(`viewport ${vpName}`, () => {
        test.use({ viewport });
        for (const [name, testId] of SECTIONS) {
          test(`${name} @ ${vpName}`, async ({ page }) => {
            await open(page);
            await expect(page.getByTestId(testId)).toHaveScreenshot(`${name}-${vpName}.png`, {
              animations: 'disabled',
            });
          });
        }
      });
    }

    test('dark theme s-curve @ 1440', async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, true);
      await expect(page.getByTestId('specimen-scurve')).toHaveScreenshot('scurve-dark-1440.png', {
        animations: 'disabled',
      });
    });
  });

  test('burndown draws steps only: no curve commands in the path', async ({ page }) => {
    await open(page);
    const d = await page.getByTestId('specimen-burn').locator('path.chart-line').getAttribute('d');
    expect(d).toMatch(/^M[\d. ]+( [HV][\d.]+)+$/);
  });

  test('S-curve labels never share a row position when markers sit days apart', async ({
    page,
  }) => {
    await open(page);
    const labels = page
      .getByTestId('specimen-scurve')
      .getByRole('img')
      .nth(1)
      .locator('text[font-weight]');
    const boxes = await labels.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { t: e.textContent, l: r.left, r: r.right, top: r.top, b: r.bottom };
      }),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.l < b.r && b.l < a.r && a.top < b.b && b.top < a.b;
        expect(overlap, `${a.t} overlaps ${b.t}`).toBe(false);
      }
    }
  });

  test('definition is reachable by keyboard focus', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'What is Progress S-curve?' }).focus();
    await expect(page.getByRole('tooltip')).toContainText('Cumulative percent complete');
  });

  test('axe clean in light theme', async ({ page }, testInfo) => {
    await open(page);
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('axe clean in dark theme', async ({ page }, testInfo) => {
    await open(page, true);
    await expectNoA11yViolations(page, testInfo, { gateModerate: true });
  });

  test('forced-colors: marks repaint with system colors, not oklch tokens', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page);
    const stroke = await page
      .getByTestId('specimen-burn')
      .locator('path.chart-line')
      .evaluate((e) => getComputedStyle(e).stroke);
    expect(stroke).not.toMatch(/oklch|var\(/);
    // CanvasText resolves to an rgb() the UA picks; the point is it is the system one.
    const canvasText = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'CanvasText';
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(stroke).toBe(canvasText);
  });
});

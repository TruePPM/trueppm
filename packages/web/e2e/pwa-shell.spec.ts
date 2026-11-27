/**
 * Installable PWA shell (ADR-1523, #1425).
 *
 * Every other spec runs with service workers blocked (playwright.config.ts), so
 * this is the one place the real `/sw.js` from the preview build registers. It
 * proves the properties the ADR depends on:
 * - the manifest is linked and installable (standalone, maskable icon, PNG
 *   apple-touch-icon),
 * - the worker registers at scope `/` and takes control,
 * - a cold reload with no network boots the precached shell instead of the
 *   browser's offline page,
 * - server-owned paths (`/api/`) are NOT answered with the SPA shell offline, and
 *   the worker caches no API response,
 * - the kill-switch header unregisters the worker.
 *
 * The worker handles no `/api/` request, so `page.route` mocks still see every API
 * call.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';

test.use({ serviceWorkers: 'allow' });

async function waitForControllingWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // clientsClaim() hands the already-open page to the worker; a reload guarantees it.
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}

test.describe('PWA shell (ADR-1523)', () => {
  test('links an installable manifest and a PNG apple-touch-icon', async ({ page, request }) => {
    await setupCatchAll(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest',
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/apple-touch-icon.png',
    );

    const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
      display: string;
      start_url: string;
      theme_color: string;
      icons: { src: string; purpose: string; sizes: string }[];
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.theme_color).toBe('#1B2A4A');
    expect(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(
      true,
    );
    const icon = await request.get('/apple-touch-icon.png');
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/png');
  });

  test('boots the precached shell offline, and never serves the shell for /api/', async ({
    page,
    context,
  }) => {
    await setupCatchAll(page);
    await page.goto('/login');
    await waitForControllingWorker(page);

    // Nothing under /api/ may sit in Cache Storage (ADR-1523 §2).
    const cachedApiUrls = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) urls.push(req.url);
      }
      return urls.filter((u) => new URL(u).pathname.startsWith('/api/'));
    });
    expect(cachedApiUrls).toEqual([]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    // A server-owned path must go past the worker to the network (here, the spec's
    // catch-all mock), never be answered with the precached SPA index.html.
    const apiNavigation = await page.goto('/api/v1/health/');
    expect(apiNavigation?.headers()['content-type']).toContain('application/json');
    await context.setOffline(false);
  });

  test('the kill-switch header unregisters the worker', async ({ page }) => {
    // Signed in: the kill switch rides the app's API client, which the signed-in
    // shell uses for every read (the login screen's edition probe does not).
    await setupAuth(page);
    await setupCatchAll(page);
    await setupApiMocks(page);
    await page.goto('/');
    await waitForControllingWorker(page);

    // The shell reads /auth/me/ through the app's API client on every load; this
    // override (registered last, so it wins) carries the kill-switch header back.
    await page.route('**/api/v1/auth/me/', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-TruePPM-Service-Worker': 'disable' },
        body: JSON.stringify({
          id: 'e2e-user',
          username: 'dana',
          display_name: 'Dana',
          initials: 'D',
          email: 'dana@example.com',
          max_project_role: 100,
          workspace_role: null,
          can_access_admin_settings: false,
        }),
      }),
    );
    // The shell's own API reads carry the header back after this reload.
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
      )
      .toBe(0);
  });
});

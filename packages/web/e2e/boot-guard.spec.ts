import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures/coverage';
import { setupCatchAll } from './fixtures';

/**
 * Boot guard (#4408) — public/boot-guard.js recovers from a hashed boot asset
 * that 404s during a web-tier rollout.
 *
 * The rollout shape: the browser gets the new index.html, then requests its
 * entry script (or an eager chunk) from a pod still on the previous release,
 * which answers 404. The in-app recovery in src/lib/chunkReload.ts lives inside
 * that entry graph, so without the guard the page stays blank. These specs fail
 * the first N requests for a boot asset the way a mixed rollout does, and
 * assert the app boots once the asset is served again, or that a persistent
 * failure ends on the static notice rather than a blank page or a reload loop.
 */

const BOOT_KEY = 'trueppm:boot-reload';

/**
 * The entry script's URL glob, read from the served index.html so the spec
 * never guesses a hash or matches a lazy chunk that happens to share a name.
 */
async function entryScript(page: Page): Promise<string> {
  const html = await (await page.request.get('/')).text();
  const match = /<script type="module"[^>]*\ssrc="([^"]+)"/.exec(html);
  if (!match) throw new Error('no module entry <script> in the served index.html');
  return `**${match[1]}`;
}

/** 404s the first `failures` requests matching `pattern`, then serves normally. */
async function failFirst(page: Page, pattern: string, failures: number): Promise<() => number> {
  let seen = 0;
  await page.route(pattern, async (route: Route) => {
    seen += 1;
    if (seen <= failures) {
      await route.fulfill({ status: 404, contentType: 'text/html', body: '' });
      return;
    }
    await route.fallback();
  });
  return () => seen;
}

test.describe('Boot guard — rollout skew on boot assets', () => {
  test.beforeEach(async ({ page }) => {
    await setupCatchAll(page);
  });

  test('a 404 on the entry script reloads with backoff until the app boots', async ({ page }) => {
    const entryRequests = await failFirst(page, await entryScript(page), 2);

    await page.goto('/login');

    // Two failed loads, two backoff reloads (1 s, then 3 s), third load boots.
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({
      timeout: 20_000,
    });
    expect(entryRequests()).toBe(3);
    await expect(page.locator('#trueppm-boot-notice')).toHaveCount(0);
    // A clean boot refunds the budget, so the next rollout starts from zero.
    expect(await page.evaluate((key) => sessionStorage.getItem(key), BOOT_KEY)).toBeNull();
  });

  test('a 404 on an eager dependency chunk (not the entry) is recovered too', async ({ page }) => {
    // jsx-runtime is a static import of the entry and is modulepreloaded by
    // index.html, so its failure breaks the entry graph before main.tsx runs.
    const chunkRequests = await failFirst(page, '**/assets/jsx-runtime-*.js', 1);

    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible({
      timeout: 15_000,
    });
    expect(chunkRequests()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#trueppm-boot-notice')).toHaveCount(0);
  });

  test('a persistent failure ends on the notice, not a blank page or a reload loop', async ({
    page,
  }) => {
    // Seed a spent budget on the first load only, standing in for the reloads
    // already used up, so the spec does not wait out the full backoff.
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem('e2e:seeded')) {
        sessionStorage.setItem('e2e:seeded', '1');
        sessionStorage.setItem(key, JSON.stringify({ n: 99, t: Date.now() }));
      }
    }, BOOT_KEY);
    const entryRequests = await failFirst(page, await entryScript(page), Number.MAX_SAFE_INTEGER);

    await page.goto('/login');

    const notice = page.getByRole('alert').filter({ hasText: 'TruePPM is being updated' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
    // No reload follows: give a scheduled one (shortest backoff is 1 s) time to fire.
    await page.waitForTimeout(2_000);
    expect(entryRequests()).toBe(1);
  });

  test('the Reload button refunds the budget and boots once the asset is back', async ({
    page,
  }) => {
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem('e2e:seeded')) {
        sessionStorage.setItem('e2e:seeded', '1');
        sessionStorage.setItem(key, JSON.stringify({ n: 99, t: Date.now() }));
      }
    }, BOOT_KEY);
    await failFirst(page, await entryScript(page), 1);

    await page.goto('/login');
    await page.getByRole('button', { name: 'Reload' }).click();

    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.locator('#trueppm-boot-notice')).toHaveCount(0);
  });
});

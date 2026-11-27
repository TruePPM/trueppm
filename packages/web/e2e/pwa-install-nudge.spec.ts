/**
 * iOS Add-to-Home-Screen nudge (ADR-1523 §7, #1426).
 *
 * The nudge is pure client-side detection, so these specs emulate the platform
 * (user agent, `navigator.standalone`) rather than install anything. Golden path:
 * iPhone Safari sees the card, "Show me how" reveals the steps, and a dismissal
 * survives a reload. Suppression cases: the installed app, Chrome on iOS, desktop.
 */
import { test, expect } from './fixtures/coverage';
import { setupAuth, setupApiMocks, setupCatchAll } from './fixtures';
import type { Page } from '@playwright/test';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';

async function openSignedInShell(page: Page): Promise<void> {
  await setupAuth(page);
  await setupCatchAll(page);
  await setupApiMocks(page);
  await page.goto('/');
  // Gate on the rendered shell before asserting presence or absence of the nudge.
  await expect(page.getByRole('main')).toBeVisible();
}

test.describe('iOS install nudge — iPhone Safari', () => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 402, height: 874 }, hasTouch: true });

  test('shows, explains the Share steps, and stays dismissed after a reload', async ({ page }) => {
    await openSignedInShell(page);
    const nudge = page.getByRole('region', { name: 'Install TruePPM' });
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText('Share, then Add to Home Screen');

    await nudge.getByRole('button', { name: 'Show me how' }).click();
    const steps = nudge.getByRole('list', { name: 'How to install' });
    await expect(steps).toBeFocused();
    await expect(steps).toContainText('Add to Home Screen');

    await nudge.getByRole('button', { name: 'Done' }).click();
    await expect(nudge).toBeHidden();

    await page.reload();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Install TruePPM' })).toHaveCount(0);
  });

  test('is suppressed inside the installed (standalone) app', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    });
    await openSignedInShell(page);
    await expect(page.getByRole('region', { name: 'Install TruePPM' })).toHaveCount(0);
  });
});

test.describe('iOS install nudge — other browsers', () => {
  test.describe('Chrome on iOS', () => {
    test.use({ userAgent: IPHONE_CHROME, viewport: { width: 402, height: 874 } });
    test('does not show', async ({ page }) => {
      await openSignedInShell(page);
      await expect(page.getByRole('region', { name: 'Install TruePPM' })).toHaveCount(0);
    });
  });

  test('does not show on desktop', async ({ page }) => {
    await openSignedInShell(page);
    await expect(page.getByRole('region', { name: 'Install TruePPM' })).toHaveCount(0);
  });
});

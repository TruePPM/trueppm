import type { Page } from '@playwright/test';

/**
 * Inject the auth state directly into localStorage so the app boots logged-in
 * without going through the login flow. Mirrors the shape Zustand persists
 * under `trueppm-auth` (state + version envelope).
 *
 * Call BEFORE the first `page.goto(...)` — Playwright runs the init script on
 * every navigation, so this is invoked before any app code reads localStorage.
 */
export async function setupAuth(
  page: Page,
  opts: { accessToken?: string; refreshToken?: string } = {},
): Promise<void> {
  const accessToken = opts.accessToken ?? 'e2e-token';
  const refreshToken = opts.refreshToken ?? 'e2e-refresh';
  await page.addInitScript(
    ([access, refresh]) => {
      localStorage.setItem(
        'trueppm-auth',
        JSON.stringify({
          state: {
            accessToken: access,
            refreshToken: refresh,
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
    },
    [accessToken, refreshToken],
  );
}

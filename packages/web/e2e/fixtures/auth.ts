import type { Page } from '@playwright/test';

/**
 * Inject the auth state directly into localStorage so the app boots logged-in
 * without going through the login flow. Mirrors the shape Zustand persists
 * under `trueppm-auth` (state + version envelope).
 *
 * Since #897 the store's `partialize` persists ONLY `isAuthenticated` — the
 * access token is in-memory and the refresh token is an httpOnly cookie. We
 * seed just `isAuthenticated: true`, which is all RequireAuth gates on; specs
 * using this fixture route-mock their API calls, so no token is needed.
 *
 * Call BEFORE the first `page.goto(...)` — Playwright runs the init script on
 * every navigation, so this is invoked before any app code reads localStorage.
 */
export async function setupAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          isAuthenticated: true,
        },
        version: 0,
      }),
    );
  });
}

import type { Page } from '@playwright/test';

/** Options for {@link setupAuth}. */
export interface SetupAuthOptions {
  /**
   * Seed an in-memory access token into the rehydrated store. The app itself
   * never persists the access token (#897) — it is re-minted lazily on the
   * first API 401 via a cookie refresh. Specs that route-mock every API call
   * therefore never trigger that refresh, so any feature gated on a present
   * access token (e.g. the project WebSocket in `useProjectWebSocket`) would
   * never activate. Passing a token here restores it on rehydration so those
   * specs can exercise the gated path without standing up the 401→refresh flow
   * (which is unit-tested in `api/client.test.ts`). Omit it for specs that only
   * need to be past `RequireAuth`.
   */
  accessToken?: string;
}

/**
 * Inject the auth state directly into localStorage so the app boots logged-in
 * without going through the login flow. Mirrors the shape Zustand persists
 * under `trueppm-auth` (state + version envelope).
 *
 * Since #897 the store's `partialize` persists ONLY `isAuthenticated` — the
 * access token is in-memory and the refresh token is an httpOnly cookie. We
 * seed just `isAuthenticated: true`, which is all RequireAuth gates on; specs
 * using this fixture route-mock their API calls, so no token is needed. Specs
 * that need a live access token in memory (the WebSocket connection pill) pass
 * `{ accessToken }` — the store has no custom `merge`, so a token placed in the
 * persisted envelope is shallow-merged back into the runtime store on rehydrate.
 *
 * Call BEFORE the first `page.goto(...)` — Playwright runs the init script on
 * every navigation, so this is invoked before any app code reads localStorage.
 */
export async function setupAuth(page: Page, options: SetupAuthOptions = {}): Promise<void> {
  const { accessToken } = options;
  await page.addInitScript((token: string | undefined) => {
    localStorage.setItem(
      'trueppm-auth',
      JSON.stringify({
        state: {
          isAuthenticated: true,
          ...(token ? { accessToken: token } : {}),
        },
        version: 0,
      }),
    );
  }, accessToken);
}

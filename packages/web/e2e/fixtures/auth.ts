import type { Page } from '@playwright/test';

/** Default placeholder token seeded into the store so specs boot past the
 *  #911 bootstrap refresh. Specs route-mock their API calls, so the value is
 *  never validated server-side. */
const DEFAULT_ACCESS_TOKEN = 'e2e-token';

/** Options for {@link setupAuth}. */
export interface SetupAuthOptions {
  /**
   * In-memory access token to seed into the rehydrated store. Defaults to a
   * placeholder so the app boots straight through.
   *
   * The app never persists the access token (#897), and since #911 `RequireAuth`
   * mints one from the refresh cookie on a tokenless load before rendering.
   * Specs that route-mock every API call have no refresh backend, so a tokenless
   * boot would stall on that bootstrap refresh and fall into the session-expired
   * state. Seeding a token by default skips the bootstrap (the cookie-refresh
   * flow is unit-tested in `api/client.test.ts`) so specs render the app shell.
   *
   * Pass an explicit string to control the token value, or `null` to seed no
   * token — only for specs that deliberately exercise the tokenless / expired
   * path and mock the refresh endpoint themselves.
   */
  accessToken?: string | null;
}

/**
 * Inject the auth state directly into localStorage so the app boots logged-in
 * without going through the login flow. Mirrors the shape Zustand persists
 * under `trueppm-auth` (state + version envelope).
 *
 * Since #897 the store's `partialize` persists ONLY `isAuthenticated` — the
 * access token is in-memory and the refresh token is an httpOnly cookie. Since
 * #911 `RequireAuth` mints an access token from the cookie before rendering when
 * none is present, so a tokenless boot stalls in a route-mocked spec (no refresh
 * backend). We therefore seed a placeholder access token by default; the store
 * has no custom `merge`, so a token placed in the persisted envelope is
 * shallow-merged back into the runtime store on rehydrate. Pass `accessToken:
 * null` to opt out for specs that exercise the tokenless / expired path.
 *
 * Call BEFORE the first `page.goto(...)` — Playwright runs the init script on
 * every navigation, so this is invoked before any app code reads localStorage.
 */
export async function setupAuth(page: Page, options: SetupAuthOptions = {}): Promise<void> {
  const accessToken =
    options.accessToken === undefined ? DEFAULT_ACCESS_TOKEN : options.accessToken;
  await page.addInitScript((token: string | null) => {
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

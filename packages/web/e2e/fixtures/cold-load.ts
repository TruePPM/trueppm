/**
 * Cold-load helper — force a surface past its loading skeleton (#2365).
 *
 * Most specs mock every endpoint to resolve instantly, so whether a component
 * renders its loading branch before its real content is left to chance: it
 * depends on whether the relevant query key was already warm when the component
 * mounted. That makes the *cold* path — the common one for real users — only
 * incidentally covered, and a bug that lives there reads as an intermittent
 * failure rather than a reproducible one.
 *
 * That is exactly how #2365 hid for two triage rounds: `useSpaceDragPan`
 * attached its listeners to a container that does not exist while the board
 * shows its skeleton, and never re-attached, so Space+drag panning was dead
 * whenever the board lost the race — which the e2e reported as flake.
 *
 * Delaying a route makes the ordering deterministic, so a spec can assert the
 * surface still works when its container mounts after first paint.
 */
import type { Page } from '@playwright/test';

/** Default delay: long enough that the skeleton reliably paints first. */
export const COLD_LOAD_DELAY_MS = 1200;

/**
 * Delay matching responses so the calling surface renders its loading state
 * before its real content.
 *
 * Register this **after** `setupApiMocks` — the last-registered route wins, and
 * `fallback()` then defers to the fixture handler for the actual payload, so
 * this only changes *when* the response arrives, never *what* it contains.
 *
 * @param page Playwright page.
 * @param urlPattern Route glob to delay, e.g. `'** /api/v1/tasks/**'`.
 * @param delayMs How long to hold the response. Defaults to
 *   {@link COLD_LOAD_DELAY_MS}.
 */
export async function delayRoute(
  page: Page,
  urlPattern: string,
  delayMs: number = COLD_LOAD_DELAY_MS,
): Promise<void> {
  await page.route(urlPattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fallback();
  });
}

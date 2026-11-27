/**
 * Service-worker registration for the installable PWA shell (ADR-1523 §1–2).
 *
 * Why our own module instead of vite-plugin-pwa's `virtual:pwa-register`: the
 * plugin's auto-update path reloads the page when a new worker takes control. A
 * reload under a user mid-edit discards the in-memory mutation queue
 * (`PendingWritesGuard`), so here an update NEVER reloads. The worker calls
 * skipWaiting/clientsClaim; the open tab keeps the JS it booted with and picks up
 * the new shell on its next navigation. Its lazy chunks are not in the new
 * precache, so they reach the network, where ADR-1249's previous-asset window
 * serves them.
 *
 * Guards: a no-op without `navigator.serviceWorker` (jsdom, old browsers,
 * insecure origins) and in the Vite dev server, where a worker would cache-poison
 * HMR. The dev server does not build `/sw.js` at all.
 */

/** URL of the worker vite-plugin-pwa emits (`filename: 'sw.js'` in vite.config.ts). */
export const SERVICE_WORKER_URL = '/sw.js';

/** How often an installed app that is never closed checks for a new worker. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Response header that makes the page unregister every worker and drop its
 * caches (ADR-1523 §2; the push and schedule-outbox designs rely on it). An operator sets
 * it at their ingress or in the web nginx `location /api/` block; no API code.
 */
export const KILL_SWITCH_HEADER = 'x-trueppm-service-worker';
export const KILL_SWITCH_VALUE = 'disable';

function serviceWorkerContainer(): ServiceWorkerContainer | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker;
}

let disabled = false;

/** Vite's dev flag, read defensively: this module is also type-checked by the e2e
 *  project (via the API client), whose tsconfig has no `vite/client` types. */
function isDevServer(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/**
 * Register `/sw.js` once the page has loaded, and keep it fresh: check for an
 * update hourly and whenever the app returns to the foreground. Returns the
 * registration, or null when the environment has no worker support, the build is
 * the dev server, or the kill switch fired this page load.
 */
export async function registerServiceWorker({
  isDev = isDevServer(),
}: { isDev?: boolean } = {}): Promise<ServiceWorkerRegistration | null> {
  const container = serviceWorkerContainer();
  if (!container || isDev || disabled) return null;
  try {
    const registration = await container.register(SERVICE_WORKER_URL, { scope: '/' });
    const check = () => {
      if (disabled) return;
      // A failed update check (offline, a pod mid-rollout) keeps the current worker.
      registration.update().catch(() => undefined);
    };
    window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    return registration;
  } catch {
    // Registration failure (a pod without sw.js answering the SPA fallback, a
    // private window) leaves the app exactly as it was before the PWA existed.
    return null;
  }
}

/**
 * Unregister every worker on this origin and delete its Cache Storage. Idempotent;
 * also stops `registerServiceWorker` from registering again this page load.
 */
export async function disableServiceWorker(): Promise<void> {
  disabled = true;
  const container = serviceWorkerContainer();
  if (container) {
    try {
      const registrations = await container.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    } catch {
      // Nothing more to do: the next load retries via the header again.
    }
  }
  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      // Cache Storage can be unavailable (private mode); nothing was cached then.
    }
  }
}

/**
 * Inspect one response's headers for the kill switch. Accepts axios' header bag
 * (lower-cased keys) or a fetch `Headers`. Fire-and-forget by design: the response
 * itself is unaffected.
 */
export function honorKillSwitch(headers: unknown): void {
  if (disabled || !headers) return;
  let value: unknown;
  if (typeof (headers as Headers).get === 'function') {
    value = (headers as Headers).get(KILL_SWITCH_HEADER);
  } else if (typeof headers === 'object') {
    value = (headers as Record<string, unknown>)[KILL_SWITCH_HEADER];
  }
  if (typeof value === 'string' && value.trim().toLowerCase() === KILL_SWITCH_VALUE) {
    void disableServiceWorker();
  }
}

/** Test seam: forget a kill-switch firing. */
export function resetServiceWorkerStateForTests(): void {
  disabled = false;
}

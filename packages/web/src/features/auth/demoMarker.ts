/**
 * A durable "this browser holds a demo session" marker (#4500).
 *
 * The silent re-login after a failed refresh must only renew a session that WAS the
 * shared demo account — a real account (an operator signed in on the demo host) must
 * get the signed-out modal, never be swapped to the demo user. `isAuthenticated` is a
 * persisted hint with no identity, so this is the identity-bearing signal. It holds no
 * credential or token, only a boolean, so persisting it past the tab is harmless; it is
 * localStorage so it survives a browser restart, which is when a session-only refresh
 * cookie is genuinely gone. Every access is guarded: storage can throw or be absent.
 * Imports nothing, so the auth store can clear it without a cycle.
 */
const KEY = 'trueppm-demo-session';

export function markDemoSession(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* storage unavailable — the silent renewal simply will not apply */
  }
}

export function clearDemoSessionMarker(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export function hasDemoSessionMarker(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

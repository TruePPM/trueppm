/**
 * Carries the post-login deep link (`?next=`) across the SSO round-trip (#3563).
 *
 * The SSO handoff is a top-level navigation to the IdP and back to `/sso/complete`,
 * so the SPA's `?next=` query is gone by the time it returns. The browser's
 * `sessionStorage` survives that same-tab round-trip and is cleared on tab close,
 * so it is where the target waits. A short TTL bounds how long a stale target can
 * redirect a later, unrelated sign-in. Callers pass only an already-validated
 * path (`loginRedirectDest`), and the reader's caller re-validates it on the way
 * out: storage is writable by anything on the origin, so it is never trusted blind.
 */

const KEY = 'tppm.sso.next';
const TTL_MS = 10 * 60 * 1000;

interface Stored {
  next: string;
  at: number;
}

/** Remember `next` for the SSO return trip. A storage failure is silent: it only loses the deep link. */
export function stashSsoNext(next: string): void {
  try {
    const value: Stored = { next, at: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* private mode / blocked storage — the user lands on the default front door */
  }
}

/** Drop any remembered target (a fresh SSO click without a deep link must not inherit an old one). */
export function clearSsoNext(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Read and clear the remembered target; null when absent, expired, or malformed. */
export function takeSsoNext(now: number = Date.now()): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.next !== 'string' || typeof parsed.at !== 'number') return null;
    if (now - parsed.at > TTL_MS) return null;
    return parsed.next;
  } catch {
    return null;
  }
}

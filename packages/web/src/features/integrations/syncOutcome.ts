/**
 * What the last pull of an external source actually did (#2925).
 *
 * The backend records this on the connection (`config["last_sync"]`, written by
 * the sync worker) and exposes it on two surfaces with the same shape: the
 * connection summary (`GET /me/connections/{source}/`) and the My Work
 * `external_sources` block. Before it, a connection reported only a status and a
 * timestamp — so "Connected, last synced 5 minutes ago" read identically whether
 * the pull stored 200 items, zero, or failed, and a contributor with more
 * assigned issues than the source's page size got a silently partial My Work.
 *
 * This module owns the *copy*, not just the type, because both surfaces must say
 * the same thing about the same fact — a truncation worded two ways is two
 * different claims to the person reading them.
 */

/** Mirrors the backend `ExternalConnectionLastSyncSerializer`. */
export interface ExternalSyncOutcome {
  /** ISO timestamp of the pull, or null on a row written without one. */
  at: string | null;
  ok: boolean;
  /**
   * A fixed token from the backend's closed vocabulary (blank on success), never
   * a server-formatted message — see `tasks.SYNC_FAILURE_REASONS` for why. Map it
   * through {@link syncFailureMessage}; never render it raw.
   */
  reason: string;
  /** Items the source returned on this pull. */
  fetched: number;
  /** Items actually stored after the cache cap — the "first N" the user sees. */
  stored: number;
  /**
   * The provider's own count of everything matching the filter, or `null` when it
   * did not report one. `null` means **unknown**, never zero: never render it as
   * a denominator, and never subtract from it.
   */
  total_available: number | null;
  /** The source had more than this pull stored. */
  truncated: boolean;
}

/**
 * User-facing sentence for a failed pull, keyed on the backend's reason token.
 *
 * Every branch names the remedy, because the four failures have four different
 * ones and telling a user with a valid token to reconnect sends them to re-issue
 * a credential that was never the problem.
 */
export function syncFailureMessage(outcome: ExternalSyncOutcome, sourceName: string): string {
  switch (outcome.reason) {
    case 'auth_failed':
      return `${sourceName} rejected the saved token — reconnect to resume pulling.`;
    case 'invalid_filter':
      return `${sourceName}'s saved filter or project keys are no longer valid — update them to resume.`;
    case 'rate_limited':
      // Deliberately does NOT promise the next sync resumes automatically.
      // Polling is default-off with no toggle, and a pull has no resume cursor —
      // this token is only written once the retry budget is spent, so the honest
      // remedy is the manual control the user is looking at.
      return `${sourceName} is rate-limiting requests, so the last sync gave up. Try Sync now again in a few minutes.`;
    case 'credential_unreadable':
      return `The stored ${sourceName} credential could not be read — reconnect to replace it.`;
    case 'unreachable':
      return `Couldn't reach ${sourceName} on the last sync. Your items are the ones from the last successful pull.`;
    default:
      return `The last ${sourceName} sync didn't complete. Your items are the ones from the last successful pull.`;
  }
}

/**
 * Whether this failure's remedy is the connect wizard — i.e. whether the notice
 * that states it must also carry the control that fixes it.
 *
 * `credential_unreadable` is the case that forced this to be explicit: the stored
 * ciphertext is unusable, so the fix is replacing the token, but the connection's
 * status stays `connected` — which means the card renders its healthy Sync now /
 * Disconnect pair and no Reconnect anywhere. Naming a remedy the surface does not
 * offer is worse than naming none.
 *
 * The other reasons are genuinely not fixable here: an unreachable host and a
 * rate limit both resolve on their own or on the next manual sync, and offering
 * "Reconnect" for either would have the user re-issue a working credential.
 */
export function syncFailureNeedsReconnect(outcome: ExternalSyncOutcome): boolean {
  return outcome.reason === 'credential_unreadable' || outcome.reason === 'auth_failed';
}

/**
 * "Showing the first 100 of 412 items assigned to you" — `null` when nothing was cut.
 *
 * Two shapes on purpose. With a provider total the sentence is exact and the user
 * can see how much is missing; without one the honest sentence has no
 * denominator, because `total_available: null` means the provider did not say —
 * and inventing a total would be a fabricated number in the one place the feature
 * exists to stop guessing.
 *
 * "items", not "assigned issues": three caps can produce this sentence (the
 * provider's page size, our per-source cache cap, and a full page with no total)
 * and the noun has to be true of all three and of every source — the registry
 * already lists a source whose unit is "issues and pull requests". It also has to
 * match {@link pullCountLabel}, which describes the same number on the same card.
 */
export function truncationNotice(
  outcome: ExternalSyncOutcome | null | undefined,
): string | null {
  if (!outcome?.truncated || !outcome.ok) return null;
  const { stored, total_available: total } = outcome;
  if (typeof total === 'number' && total > stored) {
    return `Showing the first ${stored} of ${total} items assigned to you.`;
  }
  return `Showing the first ${stored} items assigned to you — there may be more.`;
}

/**
 * "Pulled 42 items" — the plain success line, so a completed pull that returned
 * nothing is visibly different from one that returned work.
 */
export function pullCountLabel(outcome: ExternalSyncOutcome | null | undefined): string | null {
  if (!outcome || !outcome.ok) return null;
  if (outcome.stored === 0) return 'No assigned items pulled';
  return `${outcome.stored} item${outcome.stored === 1 ? '' : 's'} pulled`;
}

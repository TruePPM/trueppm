/**
 * Cross-tab session coordination (#4296). Every tab of the origin shares one refresh
 * cookie, so when the session ends or is restored in one tab the others are in the
 * same state whether they know it yet or not. Without this a sibling tab learns only
 * when its own next request fails, so one expiry costs two "Sign in" clicks.
 *
 * Only the *kind* of event travels; never a token. The access token is memory-only
 * by design (#897) and a restored tab re-mints its own from the shared cookie.
 * `BroadcastChannel` is same-origin by construction. Where it is missing (older
 * embedded WebViews, jsdom) every function here is a no-op and the tab falls back to
 * discovering the change on its next request, which is the pre-#4296 behavior.
 */
export type AuthBroadcastType = 'expired' | 'readonly' | 'restored' | 'cleared';

export const AUTH_CHANNEL_NAME = 'trueppm-auth';

const VALID: readonly string[] = ['expired', 'readonly', 'restored', 'cleared'];

// ONE channel instance both posts and listens. A channel never receives its own
// posts, but a *second* instance in the same tab would — which made a tab react to
// its own change. Handlers are fanned out from this single instance instead.
let channel: BroadcastChannel | null | undefined;
const handlers = new Set<(type: AuthBroadcastType) => void>();

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    if (typeof BroadcastChannel === 'undefined') {
      channel = null;
    } else {
      const created = new BroadcastChannel(AUTH_CHANNEL_NAME);
      created.onmessage = (event: MessageEvent<unknown>) => {
        const type = (event.data as { type?: unknown } | null)?.type;
        if (typeof type !== 'string' || !VALID.includes(type)) return;
        for (const handler of handlers) handler(type as AuthBroadcastType);
      };
      channel = created;
    }
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell every sibling tab what just happened here. Never throws. */
export function postAuthMessage(type: AuthBroadcastType): void {
  try {
    getChannel()?.postMessage({ type });
  } catch {
    // A closed channel or structured-clone failure must not break the auth write.
  }
}

/**
 * Listen for events from sibling tabs (never this tab's own). Returns an
 * unsubscribe; a no-op subscription where `BroadcastChannel` is unavailable.
 */
export function subscribeAuthMessages(handler: (type: AuthBroadcastType) => void): () => void {
  handlers.add(handler);
  getChannel();
  return () => {
    handlers.delete(handler);
  };
}

/** Test seam: drop the cached channel so a stubbed `BroadcastChannel` is picked up. */
export function resetAuthBroadcastForTests(): void {
  channel?.close();
  channel = undefined;
}

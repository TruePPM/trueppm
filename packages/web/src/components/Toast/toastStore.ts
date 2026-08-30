import { create } from 'zustand';

/**
 * Global toast store (v2 fluidity, ADR-0126; issue 1225). Backs the single
 * `ToastHost` mounted in `AppShell`. Kept pure/synchronous — auto-dismiss timing
 * lives in the host so the store stays trivially testable.
 *
 * App-wide confirmations only (task created/completed/saved, pin/unpin, theme).
 * Board-local transient notices stay in `BoardDropNotice` (web rule 170).
 *
 * ## Two slots with fixed roles, not a queue (#3149, D5)
 *
 * The queue used to be unbounded, so three confirmations at once covered a third
 * of the plan. Capping it is right; **evicting the oldest is not.** This tree has
 * two dwells — `TOAST_DEFAULT_DURATION_MS` for a passive confirmation and the far
 * longer `TOAST_ACTION_DURATION_MS` for a toast carrying an Undo (#1113) — so an
 * action toast is the *oldest* toast for its entire life. Under drop-oldest, two
 * passive confirmations would evict the Undo before the user's hand arrived: the
 * exact case the long dwell was bought for. Age was standing in for
 * disposability while dwell was being set by importance, and the proxy is what
 * was wrong, not the cap.
 *
 * So the state is not a list at all. It is two named slots:
 *
 * - `transient` — the newest passive confirmation. A new passive replaces it in
 *   place; the outgoing one's remaining dwell is discarded, not transferred.
 * - `action` — the newest actionable toast. Rendered *below* the transient one,
 *   nearest the thumb.
 *
 * A passive toast can never displace an action toast, because they do not
 * compete for the same slot. The cap is two, and it is structural: there is
 * nowhere for a third to go.
 */
export type ToastVariant = 'success' | 'info' | 'error';

/** Which of the host's two fixed slots a toast occupies. Derived from `action`. */
export type ToastSlot = 'transient' | 'action';

/**
 * An optional inline action button rendered inside the toast pill (issue 1113). Used
 * for the "Deleted — Undo" affordance: `onClick` performs the action (e.g. restore)
 * and typically dismisses the toast. Kept to a single action to preserve the pill's
 * one-line ink-pill shape and mobile reachability.
 */
export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Accessible name for the button when the visible label needs more context. */
  ariaLabel?: string;
}

export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  /** Auto-dismiss after this many ms (handled by the host). */
  durationMs: number;
  action?: ToastAction;
  /** The slot this toast owns. `action ? 'action' : 'transient'`. */
  slot: ToastSlot;
  /**
   * How many identical passives coalesced into this pill; 1 means none did.
   * Rendered as a `×n` suffix by `toastDisplayMessage`.
   */
  count: number;
  /**
   * Bumped on every coalesce. The host's dwell timer depends on it, so an
   * absorbed repeat restarts the clock *without* changing `id` — the pill keeps
   * its React key, so it neither remounts nor replays its entrance animation.
   * Restarting the clock by minting a new id would reintroduce the flicker that
   * coalescing exists to stop.
   */
  revision: number;
  /** `Date.now()` of the push that last touched this toast — the coalescing window. */
  pushedAt: number;
}

export interface ToastInput {
  message: string;
  variant?: ToastVariant;
  durationMs?: number;
  action?: ToastAction;
}

/** Default auto-dismiss — the prototype toast lingers ~2.6s. */
export const TOAST_DEFAULT_DURATION_MS = 2600;

/**
 * Longer dwell for actionable toasts (issue 1113) — an Undo the user must have time to
 * read and reach on a phone. 8s balances "long enough to react" against "not a
 * standing modal".
 */
export const TOAST_ACTION_DURATION_MS = 8000;

/**
 * Two identical passives raised inside this window are the same event seen twice
 * (a held key, a rapid-edit burst), not two things worth two pills. They coalesce
 * into one toast with a count suffix and a restarted clock.
 */
export const TOAST_COALESCE_WINDOW_MS = 600;

/** How many displaced action toasts the demotion trail keeps. Newest last. */
export const TOAST_TRAIL_CAP = 10;

// Monotonic id source. A module counter (not Date.now()/Math.random()) keeps ids
// deterministic for tests and unique within a session — which is all the host needs.
let seq = 0;
function nextToastId(): string {
  seq += 1;
  return `toast-${seq}`;
}

interface ToastState {
  /** Newest passive confirmation, or null. Rendered above the action slot. */
  transient: ToastItem | null;
  /** Newest actionable toast, or null. Rendered below — nearest the thumb. */
  action: ToastItem | null;
  /**
   * An incoming actionable held back because focus is inside the one on screen
   * (D8). Depth **one**: a second arrival replaces the waiting one rather than
   * growing a queue, because a stack of undos the user never asked to see is the
   * unbounded stack this issue removed, only invisible.
   */
  pending: ToastItem | null;
  /**
   * Action toasts that lost the slot to a newer one, newest last, capped.
   *
   * D6: eviction may cost convenience, never capability. A displaced toast's
   * `action` closure is still callable here, so the undo it offered survives the
   * pill that offered it.
   *
   * **Nothing renders this yet.** The design assumed the displaced action demotes
   * into the session trail, but that trail (`features/schedule/trail/trailStore`)
   * is Schedule-scoped and keyed on a server ledger handle, while action toasts
   * are raised app-wide (pins, time entries, notifications, sync conflicts). This
   * field is the app-wide durable home the argument needs; wiring a surface onto
   * it is the open integration question recorded on #3149.
   */
  trail: ToastItem[];
  /** Id of the toast that currently contains focus, reported by the host. */
  focusedId: string | null;
  /** Enqueue a toast; returns its id so a caller can dismiss it early. */
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  /**
   * The host reports focus entering or leaving a pill. The store needs this — not
   * just the host — because focus decides *displacement*, which is a store rule.
   */
  setFocusWithin: (id: string, within: boolean) => void;
  clear: () => void;
}

/** Append to the demotion trail, dropping the oldest past the cap. */
function demote(trail: ToastItem[], toast: ToastItem): ToastItem[] {
  const next = [...trail, toast];
  return next.length > TOAST_TRAIL_CAP ? next.slice(next.length - TOAST_TRAIL_CAP) : next;
}

export const useToastStore = create<ToastState>((set) => ({
  transient: null,
  action: null,
  pending: null,
  trail: [],
  focusedId: null,
  push: ({ message, variant = 'info', durationMs, action }) => {
    const slot: ToastSlot = action ? 'action' : 'transient';
    const dwell = durationMs ?? (action ? TOAST_ACTION_DURATION_MS : TOAST_DEFAULT_DURATION_MS);
    const now = Date.now();
    // The id is minted inside the reducer for the action slot but has to be
    // returned, so it is captured here rather than read back off the state.
    let id = '';

    set((s) => {
      if (slot === 'transient') {
        const current = s.transient;
        if (
          current &&
          current.message === message &&
          current.variant === variant &&
          now - current.pushedAt < TOAST_COALESCE_WINDOW_MS
        ) {
          id = current.id;
          return {
            transient: {
              ...current,
              count: current.count + 1,
              revision: current.revision + 1,
              // The longer of the two, never the incoming one blindly: a coalesce
              // restarts a window and must not shorten one. A caller that asked for
              // a 9s dwell should not have it cut to the 2.6s default by a duplicate
              // it did not raise and cannot see.
              durationMs: Math.max(current.durationMs, dwell),
              pushedAt: now,
            },
          };
        }
        if (
          current &&
          current.variant === 'error' &&
          variant !== 'error' &&
          now - current.pushedAt < current.durationMs
        ) {
          // The same argument that replaced drop-oldest, applied to the axis the
          // slot split does not read. `slot` is derived from actionability alone,
          // so a passive failure notice and a routine confirmation land in the same
          // slot — and the confirmation wins purely by being newer, which is
          // drop-oldest coming back in through the other door. An error is not
          // disposable the way "Estimate saved" is: it holds its slot until its own
          // dwell is up, and only another error replaces it early. The incoming
          // confirmation is dropped rather than queued, because a confirmation the
          // user sees three seconds late is worse than one they never see.
          //
          // Dwell is measured from `pushedAt` rather than from the host's live
          // timer: the store cannot see a hover pause, so a hovered error holds the
          // slot for its nominal duration and no longer. Erring short here only
          // ever costs a confirmation, never the error.
          id = nextToastId();
          return {};
        }
        id = nextToastId();
        // Replaced in place. No focus check is needed here and none is missing: a
        // passive pill holds nothing focusable, so focus can never be inside one.
        return {
          transient: {
            id,
            message,
            variant,
            durationMs: dwell,
            slot,
            count: 1,
            revision: 0,
            pushedAt: now,
          },
        };
      }

      id = nextToastId();
      const incoming: ToastItem = {
        id,
        message,
        variant,
        durationMs: dwell,
        action,
        slot,
        count: 1,
        revision: 0,
        pushedAt: now,
      };
      const current = s.action;

      if (current && s.focusedId === current.id) {
        // D8: a toast with focus inside it is never displaced. The only way a
        // keyboard user loses the control is by leaving it. The incoming one waits;
        // whatever was already waiting demotes rather than evaporating, so its undo
        // survives even though it never painted.
        return { pending: incoming, trail: s.pending ? demote(s.trail, s.pending) : s.trail };
      }
      return { action: incoming, trail: current ? demote(s.trail, current) : s.trail };
    });

    return id;
  },
  dismiss: (id) =>
    set((s) => {
      const focusedId = s.focusedId === id ? null : s.focusedId;
      if (s.transient?.id === id) return { transient: null, focusedId };
      if (s.action?.id === id) {
        // The slot frees, so anything held back by D8 takes it now — this is the
        // "released when the user presses Undo" half of the queue's release rule.
        return { action: s.pending, pending: null, focusedId };
      }
      // `focusedId` is normalized on every branch, including this one. A pending
      // toast never paints, so it cannot hold focus today and this cannot fire —
      // but the whole reducer's correctness rests on `focusedId` being accurate,
      // and the first change that renders `pending` would otherwise inherit a
      // stuck claim that queues every later action toast behind a dead id.
      if (s.pending?.id === id) return { pending: null, focusedId };
      return {};
    }),
  setFocusWithin: (id, within) =>
    set((s) => {
      if (within) return s.focusedId === id ? {} : { focusedId: id };
      if (s.focusedId !== id) return {};
      if (s.pending && s.action?.id === id) {
        // Focus left the protected toast: release the queued one and demote the one
        // it was waiting on, exactly as an unprotected displacement would have.
        return {
          focusedId: null,
          action: s.pending,
          pending: null,
          trail: demote(s.trail, s.action),
        };
      }
      return { focusedId: null };
    }),
  clear: () => set({ transient: null, action: null, pending: null, trail: [], focusedId: null }),
}));

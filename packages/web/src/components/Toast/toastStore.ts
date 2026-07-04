import { create } from 'zustand';

/**
 * Global toast store (v2 fluidity, ADR-0126; issue 1225). Backs the single
 * `ToastHost` mounted in `AppShell`. Kept pure/synchronous — auto-dismiss timing
 * lives in the host so the store stays trivially testable. Modeled on the
 * `scheduleActionToast` slice shape (`stores/scheduleStore.ts`) and the
 * `commandPaletteStore` Zustand pattern.
 *
 * App-wide confirmations only (task created/completed/saved, pin/unpin, theme).
 * Board-local transient notices stay in `BoardDropNotice` (web rule 170).
 */
export type ToastVariant = 'success' | 'info' | 'error';

/**
 * An optional inline action button rendered inside the toast pill (#1113). Used
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
 * Longer dwell for actionable toasts (#1113) — an Undo the user must have time to
 * read and reach on a phone. 8s balances "long enough to react" against "not a
 * standing modal".
 */
export const TOAST_ACTION_DURATION_MS = 8000;

// Monotonic id source. A module counter (not Date.now()/Math.random()) keeps ids
// deterministic for tests and unique within a session — which is all the host needs.
let seq = 0;
function nextToastId(): string {
  seq += 1;
  return `toast-${seq}`;
}

interface ToastState {
  toasts: ToastItem[];
  /** Enqueue a toast; returns its id so a caller can dismiss it early. */
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: ({ message, variant = 'info', durationMs = TOAST_DEFAULT_DURATION_MS, action }) => {
    const id = nextToastId();
    set((s) => ({ toasts: [...s.toasts, { id, message, variant, durationMs, action }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

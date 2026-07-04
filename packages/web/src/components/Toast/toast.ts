import { useToastStore, TOAST_ACTION_DURATION_MS } from './toastStore';
import type { ToastAction, ToastVariant } from './toastStore';

/**
 * Imperative toast API (v2 fluidity, ADR-0126; issue 1225). Callable from
 * anywhere — mutation `onSuccess` callbacks, event handlers, plain modules —
 * without a React hook, because it reads the store via `getState()`. Backs the
 * global `ToastHost` mounted once in `AppShell`.
 *
 * Use for app-wide confirmations only. Board-local transient notices stay in
 * `BoardDropNotice` (web rule 170 — do not route those here).
 */
function show(message: string, variant: ToastVariant, durationMs?: number): string {
  return useToastStore.getState().push({ message, variant, durationMs });
}

export const toast = {
  success: (message: string, durationMs?: number) => show(message, 'success', durationMs),
  info: (message: string, durationMs?: number) => show(message, 'info', durationMs),
  error: (message: string, durationMs?: number) => show(message, 'error', durationMs),
  /** A success-toned toast with celebratory copy (e.g. the task-complete moment). */
  warm: (message: string, durationMs?: number) => show(message, 'success', durationMs),
  /**
   * A toast carrying a single inline action button (issue 1113) — the "Deleted — Undo"
   * affordance. Dwells longer (`TOAST_ACTION_DURATION_MS`) so the user can reach the
   * button on a phone. Defaults to the neutral `info` tone; pass `variant` to override.
   */
  action: (
    message: string,
    action: ToastAction,
    opts?: { variant?: ToastVariant; durationMs?: number },
  ) =>
    useToastStore.getState().push({
      message,
      action,
      variant: opts?.variant ?? 'info',
      durationMs: opts?.durationMs ?? TOAST_ACTION_DURATION_MS,
    }),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

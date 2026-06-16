import { useToastStore } from './toastStore';
import type { ToastVariant } from './toastStore';

/**
 * Imperative toast API (v2 fluidity, ADR-0126; issue #1225). Callable from
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
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
};

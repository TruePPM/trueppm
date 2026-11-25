import { create } from 'zustand';

/**
 * The one open "why does this slip?" prompt (ADR-1485 D1).
 *
 * A caller who can accept scope changes may move committed sprint work past the
 * sprint end, but the server requires a reason (`slip_reason`). The task mutations
 * that hit that 400 call {@link requestSlipReason}, which opens
 * `SlipReasonDialog` and resolves with the typed reason, or `null` on cancel. Only
 * one prompt is open at a time: a second request cancels the first (resolves it
 * `null`), so a stale promise never applies a reason to the wrong edit.
 */
interface SlipReasonPromptState {
  open: boolean;
  resolve: ((reason: string | null) => void) | null;
  settle: (reason: string | null) => void;
}

export const useSlipReasonPromptStore = create<SlipReasonPromptState>((set, get) => ({
  open: false,
  resolve: null,
  settle: (reason) => {
    const { resolve } = get();
    set({ open: false, resolve: null });
    resolve?.(reason);
  },
}));

/** Open the reason prompt; resolves with the trimmed reason, or `null` if canceled. */
export function requestSlipReason(): Promise<string | null> {
  const { resolve: previous } = useSlipReasonPromptStore.getState();
  previous?.(null);
  return new Promise((resolve) => {
    useSlipReasonPromptStore.setState({ open: true, resolve });
  });
}

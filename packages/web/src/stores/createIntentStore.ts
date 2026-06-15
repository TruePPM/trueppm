import { create } from 'zustand';

/**
 * Create-intent dispatch (ADR-0130, #1179). A single chrome-level "+ New" affordance
 * (and, later, the ⌘K palette) opens a create flow by publishing a `CreateIntent`;
 * `<CreateDispatcher>` (mounted once in AppShell) renders the self-contained modal
 * targets (task / milestone / project), while the inline backlog quick-add target
 * (`story`) is consumed by `ProductBacklogPage` — which is always mounted when the
 * story target is reachable (it only resolves on the backlog route).
 *
 * Sprint-safe (ADR-0102): a `task` intent never carries a sprint, so the task is
 * created unassigned and can never silently inject into an active sprint. The
 * deliberate path is the user explicitly picking the active sprint inside the form.
 */
export type CreateIntent =
  | { kind: 'task'; projectId: string; isMilestone?: boolean }
  | { kind: 'project'; programId?: string }
  | { kind: 'story'; projectId: string };

interface CreateIntentState {
  intent: CreateIntent | null;
  /** Publish a create intent (replaces any prior, unconsumed one). */
  open: (intent: CreateIntent) => void;
  /** Clear the intent — called on modal close or once a view consumes it. */
  close: () => void;
}

export const useCreateIntentStore = create<CreateIntentState>((set) => ({
  intent: null,
  open: (intent) => set({ intent }),
  close: () => set({ intent: null }),
}));

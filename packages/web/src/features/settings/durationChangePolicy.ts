import type { InheritableSelectOption } from './components/InheritableSelectField';
import type { DurationChangePercentPolicy } from '@/api/types';

/**
 * Duration-change percent-policy options (ADR-0151, issue 1254). Shared across the
 * Workspace, Program, and Project settings pages so the labels never fork.
 * `keep` preserves today's behavior exactly (the entered % is left untouched).
 */
export const DURATION_CHANGE_POLICY_OPTIONS: ReadonlyArray<
  InheritableSelectOption<DurationChangePercentPolicy>
> = [
  { value: 'keep', label: 'Keep entered %' },
  { value: 'prorate', label: 'Prorate automatically' },
  { value: 'confirm', label: 'Ask me inline' },
];

/** Help text shared by the duration-change policy control on all three scopes. */
export const DURATION_CHANGE_POLICY_HINT =
  "When a task's duration changes and it already has progress, decide what happens to its % complete.";

/** One-line meaning of each policy, for helper copy near the control. */
export const DURATION_CHANGE_POLICY_DESCRIPTIONS: Record<DurationChangePercentPolicy, string> = {
  keep: 'Keep the entered % unchanged.',
  prorate: 'Scale % to the new duration automatically.',
  confirm: 'Show an inline "Recalc %?" prompt each time (desktop).',
};

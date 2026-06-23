/**
 * Oversight-visibility consent control (ADR-0165 §3, #748).
 *
 * The team's single upward-exposure switch for the project Decisions view, shown only to
 * the consent authority (a project Admin — `policy.can_edit`). Default-closed: decisions
 * are visible to the team and project managers; turning this on lets oversight
 * stakeholders (read-only members) see the log. The team owns this choice.
 */

import { useDecisionsPolicy, useSetDecisionsPolicy } from '@/hooks/useDecisions';

export function OversightConsentControl({ projectId }: { projectId: string }) {
  const { data: policy } = useDecisionsPolicy(projectId);
  const setPolicy = useSetDecisionsPolicy();

  // Only the consent authority (Admin+) sees the control. Everyone else just gets the
  // gate's effect, never the switch.
  if (!policy?.can_edit) return null;

  const on = policy.oversight_visible;

  return (
    <div className="flex items-start justify-between gap-4 rounded border border-neutral-border bg-neutral-surface-raised p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-neutral-text-primary">Oversight visibility</p>
        <p className="mt-0.5 text-xs text-neutral-text-secondary">
          {on
            ? 'On — oversight stakeholders can see this project’s decisions.'
            : 'Off — decisions are visible to the team and project managers only.'}{' '}
          Your team owns this choice.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Oversight visibility"
        disabled={setPolicy.isPending}
        onClick={() => setPolicy.mutate({ projectId, oversightVisible: !on })}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-50 ${on ? 'bg-brand-primary' : 'bg-neutral-border'}`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            on ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

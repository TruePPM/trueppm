import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useSprintHealth } from '@/hooks/useSprints';

interface Props {
  /** Project whose sprint-health signals to render. Null disables the fetch. */
  projectId: string | null | undefined;
}

/**
 * Tier-3 health badges (ADR-0101 §4, #988).
 *
 * Read-only signals on planning surfaces — never blocks anything. Audience is
 * the team and the agile coach: each badge surfaces a *symptom* the team can
 * choose to act on, never a "you are wrong" verdict.
 *
 * The count, the show/hide verdict, the tone, AND the consequence copy are all
 * server-owned (`GET /projects/{id}/sprint-health/`). This component renders the
 * server `detail` string verbatim — it does NOT re-derive orphan/phase-span
 * counts from WBS dot-paths or synthesize its own jargon copy (web-rule 141).
 * A headless/MCP client reading the same endpoint gets identical guidance.
 *
 * Renders nothing when the server returns no signals — the goal is to fade away
 * when the project is healthy.
 *
 * Velocity numbers are *never* added to this surface — per ADR a PMO surface
 * never sees auto-exposed velocity, and this row is consumed by both team and
 * coach in the existing Sprints workspace.
 */
export function GuardrailHealthBadges({ projectId }: Props) {
  const itl = useIterationLabel();
  const { data } = useSprintHealth(projectId);

  const signals = data?.signals ?? [];
  if (signals.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${itl.singular} health signals`}
      className="flex flex-wrap items-center gap-1.5"
    >
      {signals.map((signal) => (
        <span
          key={signal.key}
          className={[
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs',
            signal.tone === 'warn'
              ? 'border border-semantic-at-risk/40 text-semantic-at-risk bg-sem-at-risk-bg'
              : 'border border-neutral-border text-neutral-text-secondary bg-neutral-surface-raised',
          ].join(' ')}
        >
          <span aria-hidden="true">●</span>
          {signal.detail}
        </span>
      ))}
    </div>
  );
}

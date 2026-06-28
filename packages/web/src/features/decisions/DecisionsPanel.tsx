/**
 * Decisions view (ADR-0167, issue 748) — the project + sprint decision log.
 *
 * Renders the decision-flagged task notes for a project, grouped by sprint. A scope
 * segmented control toggles between "All decisions" (every decision, closed sprints
 * included — Alex's Sprint-Review recall) and "Current sprint" (scoped to the active
 * sprint). The visibility gate is server-enforced; a denied oversight reader sees an
 * explanatory locked state rather than an error. The consent control (Admin+ only)
 * lets the team opt oversight readers in.
 */

import { useMemo, useState } from 'react';
import { useDecisions } from '@/hooks/useDecisions';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useSprints } from '@/hooks/useSprints';
import { useScheduleStore } from '@/stores/scheduleStore';
import { formatRelative } from '@/lib/formatRelative';
import type { DecisionNote } from '@/types';
import { groupDecisionsBySprint } from './groupDecisions';
import { OversightConsentControl } from './OversightConsentControl';

type Scope = 'all' | 'sprint';

function SprintStateBadge({ state }: { state: string }) {
  // Active sprint is the live one; closed/other states read as muted history.
  const active = state === 'ACTIVE';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${
        active
          ? 'bg-brand-primary/10 text-brand-primary'
          : 'bg-neutral-surface text-neutral-text-secondary'
      }`}
    >
      {state.toLowerCase()}
    </span>
  );
}

function DecisionRow({ decision }: { decision: DecisionNote }) {
  const setSelectedTaskId = useScheduleStore((s) => s.setSelectedTaskId);
  const author = decision.author?.display_name ?? 'Unknown';
  const ts = formatRelative(new Date(decision.created_at));
  return (
    <li className="flex flex-col gap-1 rounded border border-neutral-border bg-neutral-surface-raised p-3">
      <div className="text-sm whitespace-pre-wrap break-words text-neutral-text-primary">
        <span aria-hidden="true" className="mr-1 text-brand-primary">
          ⚖
        </span>
        {decision.body}
      </div>
      <div className="flex items-baseline gap-2 flex-wrap text-xs text-neutral-text-secondary">
        <span className="font-medium text-neutral-text-primary">{author}</span>
        <span className="tppm-mono">{ts}</span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={() => setSelectedTaskId(decision.task.id)}
          className="truncate text-left rounded hover:text-brand-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          {decision.task.name}
        </button>
      </div>
    </li>
  );
}

export function DecisionsPanel({ projectId }: { projectId: string }) {
  const itl = useIterationLabel();
  const [scope, setScope] = useState<Scope>('all');
  const { sprints } = useSprints(projectId);
  const activeSprint = useMemo(() => sprints.find((s) => s.state === 'ACTIVE') ?? null, [sprints]);

  // "Current sprint" needs an active sprint; without one, force back to "all".
  const sprintId = scope === 'sprint' ? (activeSprint?.id ?? null) : null;
  const effectiveScope: Scope = scope === 'sprint' && !activeSprint ? 'all' : scope;

  const { decisions, isLoading, isLocked, error, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useDecisions(projectId, sprintId);

  const groups = useMemo(() => groupDecisionsBySprint(decisions), [decisions]);

  return (
    <div className="flex flex-col gap-4">
      <OversightConsentControl projectId={projectId} />

      {/* Scope segmented control (rule 167 roving tabindex via radiogroup semantics). */}
      <div
        role="radiogroup"
        aria-label="Decisions scope"
        className="inline-flex self-start rounded border border-neutral-border p-0.5"
      >
        {(
          [
            { key: 'all', label: 'All decisions' },
            { key: 'sprint', label: `Current ${itl.lower}` },
          ] as const
        ).map((opt) => {
          const selected = effectiveScope === opt.key;
          const disabled = opt.key === 'sprint' && !activeSprint;
          return (
            <button
              key={opt.key}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              title={disabled ? `No active ${itl.lower}` : undefined}
              onClick={() => setScope(opt.key)}
              tabIndex={selected ? 0 : -1}
              className={`rounded px-3 h-7 text-xs font-medium
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:opacity-40 disabled:cursor-not-allowed ${
                  selected
                    ? 'bg-brand-primary text-white'
                    : 'text-neutral-text-secondary hover:bg-neutral-surface'
                }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {isLocked ? (
        <p className="rounded border border-neutral-border bg-neutral-surface-raised p-4 text-sm text-neutral-text-secondary">
          Decisions are visible to the team and project managers. A project admin can extend
          visibility to oversight stakeholders.
        </p>
      ) : isLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading decisions">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded border border-neutral-border bg-neutral-surface-raised animate-pulse"
            />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-semantic-critical" role="alert">
          Couldn&apos;t load decisions.
        </p>
      ) : decisions.length === 0 ? (
        <p className="px-1 text-sm text-neutral-text-secondary">
          No decisions recorded yet — mark a task note as a Decision to start the log.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.sprintId ?? '__backlog__'} aria-label={`Decisions — ${g.label}`}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-neutral-text-primary">{g.label}</h3>
                {g.state && <SprintStateBadge state={g.state} />}
              </div>
              <ol className="flex flex-col gap-2 list-none p-0">
                {g.decisions.map((d) => (
                  <DecisionRow key={d.id} decision={d} />
                ))}
              </ol>
            </section>
          ))}
          {hasNextPage && (
            <button
              type="button"
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="self-start rounded border border-neutral-border px-3 h-8 text-sm font-medium
                text-neutral-text-secondary hover:bg-neutral-surface
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:opacity-50"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

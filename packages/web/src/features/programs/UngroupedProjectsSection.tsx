import { useState } from 'react';
import type { HealthState } from '@/types';
import { useUngroupedProjects, type UngroupedProject } from '@/hooks/useUngroupedProjects';
import { MoveToProgramModal } from './MoveToProgramModal';

/** Health dot color + screen-reader label (rule 6: dot is aria-hidden, state is
 * also conveyed as text; rule 7: semantic health tokens). */
const HEALTH: Record<HealthState, { dot: string; label: string }> = {
  'on-track': { dot: 'bg-semantic-on-track', label: 'On track' },
  'at-risk': { dot: 'bg-semantic-at-risk', label: 'At risk' },
  critical: { dot: 'bg-semantic-critical', label: 'Critical' },
  unknown: { dot: 'bg-neutral-text-disabled', label: 'Health unknown' },
};

function UngroupedRow({
  project,
  onMove,
}: {
  project: UngroupedProject;
  onMove: (p: UngroupedProject) => void;
}) {
  const health = HEALTH[project.healthState];
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} aria-hidden="true" />
        <span className="sr-only">{health.label}.</span>
        <span className="truncate font-medium text-neutral-text-primary">{project.name}</span>
        {project.code && (
          <span className="tppm-mono shrink-0 text-xs text-neutral-text-disabled">
            {project.code}
          </span>
        )}
      </span>

      <span className="tppm-mono w-12 shrink-0 text-xs text-neutral-text-secondary" aria-label="Percent complete">
        {project.percentComplete === null ? '—' : `${Math.round(project.percentComplete)}%`}
      </span>

      <span className="w-24 shrink-0 text-xs text-neutral-text-secondary">
        {project.memberCount === null
          ? '—'
          : `${project.memberCount} member${project.memberCount === 1 ? '' : 's'}`}
      </span>

      <span className="shrink-0 text-xs text-neutral-text-disabled">standalone</span>

      <button
        type="button"
        onClick={() => onMove(project)}
        className="ml-auto h-9 shrink-0 rounded-control border border-neutral-border px-3 text-xs font-medium text-neutral-text-primary
          hover:bg-neutral-surface-raised
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Move to program
      </button>
    </li>
  );
}

/**
 * "Ungrouped projects" section on the Programs directory (ADR-0171, #697).
 *
 * Surfaces the user's standalone projects (those not in any program) with a
 * one-click "Move to program" action. Self-hides when there are none — a clean
 * directory shouldn't carry a "0 need a home" header. Loading and error states
 * are quiet because the program grid above already owns the page's primary
 * loading affordance.
 */
export function UngroupedProjectsSection() {
  const { data: projects, isLoading, error } = useUngroupedProjects();
  const [moving, setMoving] = useState<UngroupedProject | null>(null);

  // Quiet while loading / on error / when empty — never render an empty shell.
  if (isLoading || error || !projects || projects.length === 0) return null;

  return (
    <section aria-labelledby="ungrouped-heading" className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2 border-t border-neutral-border pt-4">
        <h2 id="ungrouped-heading" className="text-sm font-semibold text-neutral-text-primary">
          Ungrouped projects
        </h2>
        <span className="rounded-chip border border-semantic-at-risk/80 bg-semantic-at-risk-bg px-2 py-0.5 text-xs font-medium text-semantic-at-risk">
          {projects.length} need a home
        </span>
        <p className="w-full text-xs text-neutral-text-secondary sm:ml-auto sm:w-auto">
          These don&rsquo;t belong to a program. Add them to one or leave standalone.
        </p>
      </div>

      <ul
        aria-label="Ungrouped projects"
        className="divide-y divide-neutral-border rounded-card border border-neutral-border bg-neutral-surface"
      >
        {projects.map((p) => (
          <UngroupedRow key={p.id} project={p} onMove={setMoving} />
        ))}
      </ul>

      {moving && (
        <MoveToProgramModal
          projectId={moving.id}
          projectName={moving.name}
          onClose={() => setMoving(null)}
        />
      )}
    </section>
  );
}

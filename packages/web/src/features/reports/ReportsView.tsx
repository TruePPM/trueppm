import { useMemo, useState } from 'react';
import { BurnChart } from './BurnChart';
import { DecisionsPanel } from '@/features/decisions/DecisionsPanel';
import { useProjectId } from '@/hooks/useProjectId';
import { useSprints } from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import type { ApiSprint } from '@/types';

type ReportsTab = 'metrics' | 'decisions';

const TABS: readonly { key: ReportsTab; label: string }[] = [
  { key: 'metrics', label: 'Metrics' },
  { key: 'decisions', label: 'Decisions' },
];

/**
 * Order sprints for the selector: the active sprint first (it is what a reader
 * most often wants), then the rest newest-first by start date.
 */
function orderSprints(sprints: ApiSprint[]): ApiSprint[] {
  return [...sprints].sort((a, b) => {
    if (a.state === 'ACTIVE' && b.state !== 'ACTIVE') return -1;
    if (b.state === 'ACTIVE' && a.state !== 'ACTIVE') return 1;
    return b.start_date.localeCompare(a.start_date);
  });
}

export function ReportsView() {
  const projectId = useProjectId();
  const [tab, setTab] = useState<ReportsTab>('metrics');
  const { sprints } = useSprints(projectId);
  const itl = useIterationLabel(projectId);

  const ordered = useMemo(() => orderSprints(sprints), [sprints]);
  // The sprint-scoped burndown is the full analytical home the board demotes to
  // (#1983). Default to the ordered head (active sprint, else newest); a null
  // selection means "not chosen yet" and falls back to that default, so no
  // effect is needed to seed it.
  const [chosenSprintId, setChosenSprintId] = useState<string | null>(null);
  const selectedSprintId = chosenSprintId ?? ordered[0]?.id ?? null;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-lg font-semibold text-neutral-text-primary">Reports</h1>
        <p className="mt-0.5 text-sm text-neutral-text-secondary">
          {tab === 'metrics'
            ? 'Burn charts and progress metrics for this project.'
            : 'The team’s recorded decisions, grouped by sprint.'}
        </p>
      </div>

      <div role="tablist" aria-label="Reports sections" className="flex gap-1 border-b border-neutral-border">
        {TABS.map((t) => {
          const selected = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.key)}
              className={`-mb-px rounded-t px-3 h-9 text-sm font-medium border-b-2
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
                  selected
                    ? 'border-brand-primary text-brand-primary'
                    : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary'
                }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'metrics' ? (
        <div className="flex flex-col gap-6">
          {/* Sprint-scoped burndown — the full analytical home the Board demotes
              to (#1983). Shown only when the project has sprints; otherwise the
              project-scoped burn chart below stands alone. */}
          {selectedSprintId && (
            <section className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm text-neutral-text-secondary">
                <span>{itl.singular}</span>
                <select
                  value={selectedSprintId}
                  onChange={(e) => setChosenSprintId(e.target.value)}
                  aria-label={`${itl.singular} to chart`}
                  className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  {ordered.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.state === 'ACTIVE' ? ' (active)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <BurnChart sprintId={selectedSprintId} defaultVariant="burndown" />
            </section>
          )}
          <BurnChart projectId={projectId ?? undefined} />
        </div>
      ) : projectId ? (
        <DecisionsPanel projectId={projectId} />
      ) : null}
    </div>
  );
}

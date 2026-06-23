import { useState } from 'react';
import { BurnChart } from './BurnChart';
import { DecisionsPanel } from '@/features/decisions/DecisionsPanel';
import { useProjectId } from '@/hooks/useProjectId';

type ReportsTab = 'metrics' | 'decisions';

const TABS: readonly { key: ReportsTab; label: string }[] = [
  { key: 'metrics', label: 'Metrics' },
  { key: 'decisions', label: 'Decisions' },
];

export function ReportsView() {
  const projectId = useProjectId();
  const [tab, setTab] = useState<ReportsTab>('metrics');

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
        <BurnChart projectId={projectId ?? undefined} />
      ) : projectId ? (
        <DecisionsPanel projectId={projectId} />
      ) : null}
    </div>
  );
}

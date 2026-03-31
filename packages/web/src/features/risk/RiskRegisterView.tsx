import { useState } from 'react';
import type { Risk } from '@/api/types';
import { useRisks } from '@/hooks/useRisks';
import { RiskChip } from './RiskChip';
import { RiskMatrix } from './RiskMatrix';
import { RiskDrawer } from './RiskDrawer';

// Status badge styling — outlined pill (rule 39)
const STATUS_CLASSES: Record<Risk['status'], string> = {
  OPEN:       'border-neutral-border text-neutral-text-secondary',
  MITIGATING: 'border-brand-primary/40 text-brand-primary',
  RESOLVED:   'border-semantic-on-track/40 text-semantic-on-track',
  ACCEPTED:   'border-semantic-at-risk/40 text-semantic-at-risk',
  CLOSED:     'border-neutral-text-disabled/40 text-neutral-text-disabled',
};

const STATUS_LABELS: Record<Risk['status'], string> = {
  OPEN:       'Open',
  MITIGATING: 'Mitigating',
  RESOLVED:   'Resolved',
  ACCEPTED:   'Accepted',
  CLOSED:     'Closed',
};

interface RiskRegisterViewProps {
  projectId: string;
}

export function RiskRegisterView({ projectId }: RiskRegisterViewProps) {
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-surface">
        <p className="text-sm text-neutral-text-secondary">Select a project to view risks.</p>
      </div>
    );
  }

  const { risks, isLoading, error } = useRisks(projectId || null);

  // null   = drawer closed
  // undefined = create mode (drawer open, no risk)
  // Risk  = view/edit mode
  const [selectedRisk, setSelectedRisk] = useState<Risk | null | undefined>(null);

  const isDrawerOpen = selectedRisk !== null;

  function openCreate() {
    setSelectedRisk(undefined);
  }

  function openRisk(risk: Risk) {
    setSelectedRisk(risk);
  }

  function closeDrawer() {
    setSelectedRisk(null);
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-neutral-surface p-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-semibold text-neutral-text-primary">Risks</h2>
        {!isLoading && !error && (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
            bg-neutral-surface-raised text-neutral-text-secondary border border-neutral-border">
            {risks.length}
          </span>
        )}
        <div className="flex-1" />
        {/* Add Risk button — desktop only (rule 90: mobile uses FAB) */}
        <button
          type="button"
          onClick={openCreate}
          className="hidden md:flex items-center gap-1.5 h-8 px-3 rounded text-sm font-medium
            text-neutral-text-inverse bg-brand-primary border border-brand-primary-dark
            hover:bg-brand-primary-dark
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          + Add Risk
        </button>
      </div>

      {/* Loading state — 3 skeleton rows */}
      {isLoading && (
        <div className="flex flex-col gap-1" aria-label="Loading risks" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-11 rounded bg-neutral-surface-raised animate-pulse border border-neutral-border"
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {/* Error state */}
      {!isLoading && error && (
        <div
          role="alert"
          className="flex flex-col items-center justify-center gap-3 py-12 text-center"
        >
          <p className="text-sm text-semantic-critical">Failed to load risks.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-8 px-3 rounded text-sm font-medium border border-neutral-border
              text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && risks.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <p className="text-sm text-neutral-text-secondary">No risks recorded</p>
        </div>
      )}

      {/* Risk table */}
      {!isLoading && !error && risks.length > 0 && (
        <div className="overflow-x-auto border border-neutral-border rounded">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-neutral-surface-raised border-b border-neutral-border">
                <th
                  scope="col"
                  className="text-left px-3 py-2 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                >
                  Severity
                </th>
                <th
                  scope="col"
                  className="text-left px-3 py-2 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                >
                  Title
                </th>
                <th
                  scope="col"
                  className="text-left px-3 py-2 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="text-left px-3 py-2 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide"
                >
                  P×I
                </th>
                <th
                  scope="col"
                  className="text-left px-3 py-2 font-medium text-neutral-text-secondary text-xs uppercase tracking-wide hidden md:table-cell"
                >
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {risks.map((risk) => (
                <tr
                  key={risk.id}
                  onClick={() => openRisk(risk)}
                  className="h-11 border-b border-neutral-border last:border-b-0
                    hover:bg-neutral-surface-raised cursor-pointer
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset"
                  tabIndex={0}
                  role="button"
                  aria-label={`Open risk: ${risk.title}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openRisk(risk);
                    }
                  }}
                >
                  <td className="px-3">
                    <RiskChip severity={risk.severity} />
                  </td>
                  <td className="px-3 text-neutral-text-primary font-medium truncate max-w-[200px]">
                    {risk.title}
                  </td>
                  <td className="px-3">
                    <span
                      className={[
                        'inline-flex items-center border rounded px-2 py-0.5 text-xs',
                        STATUS_CLASSES[risk.status],
                      ].join(' ')}
                    >
                      {STATUS_LABELS[risk.status]}
                    </span>
                  </td>
                  <td className="px-3 text-neutral-text-secondary text-xs">
                    {risk.probability}×{risk.impact}={risk.severity}
                  </td>
                  <td className="px-3 text-neutral-text-secondary text-xs hidden md:table-cell">
                    {new Date(risk.updated_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Risk matrix */}
      {!isLoading && !error && (
        <RiskMatrix risks={risks} />
      )}

      {/* Mobile FAB — opens create drawer (rule 90) */}
      <button
        type="button"
        onClick={openCreate}
        className="md:hidden fixed bottom-16 right-4 w-14 h-14 rounded-full
          bg-brand-primary border border-brand-primary-dark
          flex items-center justify-center
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2
          z-20"
        aria-label="Add risk"
      >
        <span className="text-neutral-text-inverse text-2xl leading-none" aria-hidden="true">
          +
        </span>
      </button>

      {/* Drawer / bottom sheet */}
      <RiskDrawer
        projectId={projectId}
        risk={selectedRisk ?? null}
        isOpen={isDrawerOpen}
        onClose={closeDrawer}
      />
    </div>
  );
}

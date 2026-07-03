import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  useTaskRisks,
  severityRagBand,
  severityDotCount,
  type TaskRiskSummary,
} from '@/hooks/useTaskDependencies';
import type { Task } from '@/types';

interface RiskPopoverProps {
  projectId: string;
  task: Task;
  onClose: () => void;
}

const STATUS_LABEL: Record<TaskRiskSummary['status'], string> = {
  OPEN: 'Open',
  MITIGATING: 'Mitigating',
  RESOLVED: 'Resolved',
  ACCEPTED: 'Accepted',
  CLOSED: 'Closed',
};

function severityDotColor(severity: number): string {
  const band = severityRagBand(severity);
  switch (band) {
    case 'red':
      return 'bg-semantic-critical';
    case 'amber':
      return 'bg-brand-accent-dark dark:bg-brand-accent';
    case 'green':
      return 'bg-semantic-on-track';
    default:
      return 'bg-neutral-text-disabled';
  }
}

function SeverityDots({ severity }: { severity: number }) {
  const count = severityDotCount(severity);
  const color = severityDotColor(severity);
  return (
    <span className="inline-flex gap-0.5 items-center" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />
      ))}
    </span>
  );
}

/**
 * Popover listing the risks linked to a board card (issue #188).
 *
 * Severity rendered as RAG dots (1–5) so the encoding works for color-blind
 * users (color + count, ADR-0035 §Q2).  Footer link routes to the risk register
 * scoped to this project.
 */
export function RiskPopover({ projectId, task, onClose }: RiskPopoverProps) {
  const { risks, isLoading } = useTaskRisks(projectId, task.id);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    closeBtnRef.current?.focus();
  }, []);

  const handleOpenRegister = () => {
    onClose();
    void navigate(`/projects/${projectId}/risk`);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`risk-popover-${task.id}-title`}
      className="fixed inset-0 z-30 flex items-start justify-center bg-neutral-text-primary/40 p-4 pt-20"
      onPointerDown={onClose}
    >
      <div
        className="bg-neutral-surface border border-neutral-border rounded-card w-full max-w-[320px] max-h-[60vh] overflow-y-auto"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-3 border-b border-neutral-border">
          <div className="min-w-0">
            <h2
              id={`risk-popover-${task.id}-title`}
              className="text-sm font-semibold text-neutral-text-primary truncate"
            >
              Linked risks
            </h2>
            <p className="text-xs text-neutral-text-secondary truncate">{task.name}</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            className="text-neutral-text-secondary hover:text-neutral-text-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:outline-none rounded-control p-1 -mt-1 -mr-1"
            aria-label="Close risk list"
          >
            ×
          </button>
        </div>

        {isLoading ? (
          <div className="p-3 text-xs text-neutral-text-secondary">Loading…</div>
        ) : risks.length === 0 ? (
          <div className="p-3 text-xs text-neutral-text-secondary">
            No active risks linked.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-border">
            {risks.map((risk) => (
              <li key={risk.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <span aria-hidden="true" className="shrink-0 text-brand-accent-dark dark:text-brand-accent">
                    ⚠
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs tppm-mono text-neutral-text-disabled shrink-0">
                        {risk.shortId.toUpperCase()}
                      </span>
                      <span className="text-xs font-medium text-neutral-text-primary truncate">
                        {risk.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-neutral-text-secondary">
                        {STATUS_LABEL[risk.status]}
                      </span>
                      <span className="text-neutral-text-disabled" aria-hidden="true">·</span>
                      <SeverityDots severity={risk.severity} />
                      <span
                        className="text-xs tppm-mono text-neutral-text-secondary"
                        aria-label={`Severity ${risk.severity} of 25`}
                      >
                        {risk.severity}
                      </span>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="border-t border-neutral-border">
          <button
            type="button"
            onClick={handleOpenRegister}
            className="w-full text-left px-3 py-2 text-xs text-brand-primary
              hover:bg-neutral-surface-raised
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-inset
              focus-visible:outline-none"
          >
            → Open in risk register
          </button>
        </div>
      </div>
    </div>
  );
}

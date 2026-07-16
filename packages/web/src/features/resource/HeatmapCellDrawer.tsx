import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';

interface Task {
  id: string;
  name: string;
  status: string;
  early_start: string | null;
  early_finish: string | null;
  units: string;
  hours: number;
}

interface Props {
  projectId: string;
  resourceId: string;
  resourceName: string;
  resourceInitials: string;
  resourceColor: string;
  weekLabel: string; // e.g. "2026-W18"
  weekStart: string; // YYYY-MM-DD Monday
  weekEnd: string;   // YYYY-MM-DD Sunday
  utilPct: number;
  onClose: () => void;
}

function statusLabel(s: string): string {
  return s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  const fmt = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  if (start && end) return `${fmt(start)} → ${fmt(end)}`;
  if (start) return `from ${fmt(start)}`;
  return `until ${end ? new Date(end + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}`;
}

/**
 * Slide-in drawer showing tasks assigned to a resource in a given ISO week.
 * Opens as right-side panel on desktop (≥ 768px), bottom sheet on mobile.
 */
export function HeatmapCellDrawer({
  projectId,
  resourceId,
  resourceName,
  resourceInitials,
  resourceColor,
  weekLabel,
  weekStart,
  weekEnd,
  utilPct,
  onClose,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const headerId = `heatmap-drawer-${resourceId}-${weekLabel}`;

  // Fetch tasks for this resource in this week by querying the allocation endpoint
  // filtered to the resource and date window.
  const { data, isLoading } = useQuery({
    queryKey: ['heatmap-cell-tasks', projectId, resourceId, weekStart, weekEnd],
    queryFn: async () => {
      const res = await apiClient.get<{ resources: Array<{ id: string; tasks: Task[] }> }>(
        `/projects/${projectId}/resource-allocation/`,
        { params: { resource: resourceId, start: weekStart, end: weekEnd } },
      );
      return res.data.resources.find((r) => r.id === resourceId)?.tasks ?? [];
    },
    enabled: !!projectId && !!resourceId,
  });

  // Trap focus on mount; return focus to trigger on close.
  useEffect(() => {
    closeRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const isOverAllocated = utilPct > 100;
  const weekNum = weekLabel.includes('-W') ? `W${weekLabel.split('-W')[1]}` : weekLabel;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-neutral-overlay"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headerId}
        className={[
          'fixed z-50 bg-neutral-surface border-neutral-border flex flex-col',
          // Desktop: right-side panel; Mobile: bottom sheet
          'inset-y-0 right-0 w-full sm:w-[480px] border-l',
          'md:inset-y-0 md:bottom-auto',
          // Mobile bottom-sheet overrides
          'max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-[75vh]',
          'max-md:rounded-t-card max-md:border-l-0 max-md:border-t',
        ].join(' ')}
      >
        {/* Drag handle (mobile only) */}
        <div className="md:hidden flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-neutral-border" aria-hidden="true" />
        </div>

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-neutral-border shrink-0">
          <div
            className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0"
            style={{ backgroundColor: resourceColor }}
            aria-hidden="true"
          >
            {resourceInitials}
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id={headerId}
              className="text-sm font-semibold text-neutral-text-primary truncate"
            >
              {resourceName}
            </h2>
            <p className="text-xs text-neutral-text-secondary tppm-mono">
              {weekNum} · {formatDateRange(weekStart, weekEnd)}
            </p>
          </div>
          {isOverAllocated && (
            <span className="shrink-0 text-xs font-medium px-2 py-0.5 rounded border border-semantic-critical/80 bg-semantic-critical-bg text-semantic-critical tppm-mono">
              {utilPct}% over
            </span>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="shrink-0 p-1 rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-5 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 rounded border border-neutral-border motion-safe:animate-pulse bg-neutral-surface-raised" />
              ))}
            </div>
          ) : !data || data.length === 0 ? (
            <div
              className="flex items-center justify-center h-full text-sm text-neutral-text-secondary py-12"
              role="status"
            >
              No assignments for {resourceName} in {weekNum}.
            </div>
          ) : (
            <ul className="divide-y divide-neutral-border">
              {data.map((task) => (
                <li key={task.id} className="px-5 py-4">
                  <p className="text-sm font-medium text-neutral-text-primary">{task.name}</p>
                  <p className="mt-0.5 text-xs text-neutral-text-secondary tppm-mono">
                    {task.hours.toFixed(1)}h · {task.units}× ·{' '}
                    <span className="capitalize">{statusLabel(task.status)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-text-disabled tppm-mono">
                    {formatDateRange(task.early_start, task.early_finish)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer — over-allocation delta */}
        {isOverAllocated && data && data.length > 0 && (
          <div className="px-5 py-3 border-t border-neutral-border bg-semantic-critical-bg shrink-0">
            <p className="text-xs text-semantic-critical tppm-mono">
              {utilPct - 100}% above capacity this week
            </p>
          </div>
        )}
      </div>
    </>
  );
}

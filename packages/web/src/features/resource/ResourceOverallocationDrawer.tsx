/**
 * ResourceOverallocationDrawer — slide-in drawer showing overallocation detail
 * for a specific resource on a specific date.
 *
 * Opens when the user activates (click or Enter/Space) an overallocated cell
 * (load > 100% of capacity) in the ResourceGrid.
 *
 * Design rules:
 * - Rule 89: right-side 480px drawer on desktop, 85vh bottom sheet on mobile
 * - Rule 4: focus trap — Tab/Shift+Tab stays inside drawer; Escape closes
 * - Aria: role="dialog" aria-modal aria-label={title}
 */

import { useRef, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { statusLabel } from './HeatmapCellDrawer';
import { capacityHours } from './resourceUtils';
import type { UtilizationDayEntry } from './resourceUtils';

export interface OverallocationTarget {
  resourceId: string;
  resourceName: string;
  iso: string; // YYYY-MM-DD
  entry: UtilizationDayEntry;
  hoursPerDay: number;
  maxUnits: number;
}

interface Props {
  projectId: string;
  target: OverallocationTarget | null;
  isOpen: boolean;
  onClose: () => void;
}

interface DrawerBodyProps {
  projectId: string;
  target: OverallocationTarget | null;
  pct: number;
  overHours: number;
  capacity: number;
  drawerTitle: string;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** Slim task shape resolved from `GET /tasks/?id__in=` — just enough to label the pill (#3843). */
interface ResolvedTask {
  id: string;
  name: string;
  status: string;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// Hoisted to module scope so React does not re-create the component type on every
// render of the parent, which would cause unnecessary unmounts of the inner tree.
function DrawerBody({
  projectId,
  target,
  pct,
  overHours,
  capacity,
  drawerTitle,
  closeButtonRef,
  onClose,
}: DrawerBodyProps) {
  const taskIds = target?.entry.tasks ?? [];

  // Batch-resolve the contributing task ids to names/status in one request
  // (#3843) — same idiom as HeatmapCellDrawer's own task fetch, but against
  // `?id__in=` (#3843's new filter) instead of the allocation endpoint, since
  // all we have here is a bare list of ids, not a resource+window to re-derive
  // them from. Query key is the sorted id list so re-opening on the same day
  // cell (identical ids, any order) reuses the cache.
  const {
    data: resolvedTasks,
    isLoading: tasksLoading,
    isError: tasksError,
    refetch: refetchTasks,
  } = useQuery({
    queryKey: ['overallocation-drawer-tasks', projectId, [...taskIds].sort((a, b) => a.localeCompare(b))],
    queryFn: async () => {
      const res = await apiClient.get<{ results: ResolvedTask[] }>('/tasks/', {
        params: { project: projectId, id__in: taskIds.join(',') },
      });
      return res.data.results;
    },
    enabled: !!projectId && taskIds.length > 0,
  });

  const taskById = new Map((resolvedTasks ?? []).map((t) => [t.id, t]));

  return (
    <>
      {/* Header — fixed min-h-14 to match TaskDetailDrawer and RiskDrawer (rule 89) */}
      <div className="flex items-center justify-between px-4 min-h-14 border-b border-neutral-border shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-neutral-text-primary">{drawerTitle}</h2>
          {target && (
            <p className="text-xs text-semantic-critical mt-0.5">
              {Math.round(pct)}% load — {overHours.toFixed(1)}h over {capacity.toFixed(1)}h capacity
            </p>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close overallocation drawer"
          className="
            w-8 h-8 flex items-center justify-center rounded
            text-neutral-text-secondary hover:text-neutral-text-primary hover:bg-neutral-surface-raised
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1
          "
        >
          {/* U+00D7 MULTIPLICATION SIGN — matches TaskDetailDrawer and RiskDrawer */}
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!target && (
          <p className="text-xs text-neutral-text-secondary">No overallocation selected.</p>
        )}

        {target && (
          <>
            {/* Load summary */}
            <section className="mb-5">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary mb-3">
                Load summary
              </h3>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Hours scheduled</dt>
                  <dd className="font-medium text-neutral-text-primary">{target.entry.hours.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Capacity</dt>
                  <dd className="font-medium text-neutral-text-primary">{capacity.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Overallocation</dt>
                  <dd className="font-medium text-semantic-critical">+{overHours.toFixed(1)}h</dd>
                </div>
                <div>
                  <dt className="text-xs text-neutral-text-secondary">Load</dt>
                  <dd className="font-medium text-semantic-critical">{Math.round(pct)}%</dd>
                </div>
              </dl>
            </section>

            {/* Contributing tasks */}
            {taskIds.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-text-secondary mb-3">
                  Contributing tasks ({taskIds.length})
                </h3>
                {tasksLoading ? (
                  <ul className="space-y-1.5" aria-busy="true" aria-label="Loading contributing tasks">
                    {taskIds.map((taskId) => (
                      <li
                        key={taskId}
                        className="h-9 rounded bg-neutral-surface-raised motion-safe:animate-pulse"
                      />
                    ))}
                  </ul>
                ) : (
                  <ul className="space-y-1.5">
                    {taskIds.map((taskId) => {
                      const resolved = taskById.get(taskId);
                      return (
                        <li
                          key={taskId}
                          className="text-xs bg-neutral-surface-raised rounded px-3 py-2"
                        >
                          {resolved ? (
                            <>
                              <p className="text-neutral-text-primary font-medium">
                                {resolved.name}
                              </p>
                              <p className="text-neutral-text-secondary mt-0.5">
                                {statusLabel(resolved.status)}
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-neutral-text-primary font-mono">{taskId}</p>
                              <p className="text-neutral-text-secondary mt-0.5 italic">
                                {tasksError
                                  ? 'Name unavailable — could not load task names.'
                                  : 'Name unavailable — this task may have been deleted.'}
                              </p>
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {tasksError && (
                  <p className="mt-2 text-xs text-neutral-text-secondary">
                    Couldn’t load task names.{' '}
                    <button
                      type="button"
                      onClick={() => void refetchTasks()}
                      className="underline text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
                    >
                      Retry
                    </button>
                  </p>
                )}
                <p className="mt-3 text-xs text-neutral-text-secondary">
                  To resolve, reassign or delay one of the contributing tasks so this
                  resource is not scheduled beyond their daily capacity.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

export function ResourceOverallocationDrawer({ projectId, target, isOpen, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // `sm` (< 768px) → bottom sheet; `md`/`lg` → right-side drawer. Render exactly
  // one shell (rule 211) so the body isn't double-mounted and closeButtonRef
  // binds to the visible copy — the hand-rolled trap previously covered only the
  // desktop shell and closeButtonRef bound to the display:none mobile copy.
  const isMobile = useBreakpoint() === 'sm';

  const capacity = target ? capacityHours(target.hoursPerDay, target.maxUnits) : 0;
  // load% is server-owned (#989); capacity stays local only for the over-hours math.
  const pct = target ? target.entry.load_pct : 0;
  const overHours = target ? Math.max(0, target.entry.hours - capacity) : 0;
  const drawerTitle = target
    ? `Overallocation — ${target.resourceName} on ${formatDate(target.iso)}`
    : 'Overallocation';

  const bodyProps: DrawerBodyProps = {
    projectId,
    target,
    pct,
    overHours,
    capacity,
    drawerTitle,
    closeButtonRef,
    onClose,
  };

  // Both shells are modal, so the trap runs for whichever one is rendered: seat
  // initial focus, cycle Tab, route Escape to close, and restore focus to the
  // trigger on close (WCAG 2.4.3/2.1.2, rule 206). drawerTitle is the focusKey so
  // reopening for a different overallocated cell re-seats focus.
  const drawerRef = useFocusTrap<HTMLDivElement>(isOpen, onClose, drawerTitle);

  return (
    <>
      {/* Backdrop — mobile only */}
      {isOpen && isMobile && (
        <div
          className="fixed inset-0 bg-black/30 z-30"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      {isMobile ? (
        /* Mobile: bottom sheet (rule 89). aria-hidden when closed for AT that
           don't honour the off-screen transform. */
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label={drawerTitle}
          aria-hidden={!isOpen}
          tabIndex={-1}
          className={[
            'fixed inset-x-0 bottom-0 z-40 focus:outline-none',
            'rounded-t-card bg-neutral-surface border-t border-neutral-border',
            'h-[85vh] flex flex-col',
            'transition-transform duration-200',
            isOpen ? 'translate-y-0' : 'translate-y-full',
          ].join(' ')}
        >
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1 flex-shrink-0">
            <div className="w-10 h-1 rounded-full bg-neutral-border" aria-hidden="true" />
          </div>
          <DrawerBody {...bodyProps} />
        </div>
      ) : (
        /* Desktop: right-side drawer (rule 89). aria-hidden when closed for AT
           that don't honour the off-screen transform. */
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label={drawerTitle}
          aria-hidden={!isOpen}
          tabIndex={-1}
          className={[
            'flex fixed inset-y-0 right-0 w-[480px] flex-col focus:outline-none',
            'bg-neutral-surface border-l border-neutral-border z-40',
            'transition-transform duration-200',
            isOpen ? 'translate-x-0' : 'translate-x-full',
          ].join(' ')}
        >
          <DrawerBody {...bodyProps} />
        </div>
      )}
    </>
  );
}

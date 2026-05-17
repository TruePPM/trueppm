import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@/types';
import {
  formatCycleMessage,
  parseCyclicDependencyError,
  useAddDependency,
} from '@/hooks/useTaskMutations';

/**
 * Schedule-canvas dependency picker (ADR-0066 Q4).
 *
 * Lightweight search-and-pick modal opened from the right-click context menu's
 * "Add predecessor…" / "Add successor…" actions. NOT a reuse of Board's
 * `PredecessorsEditor` — that one is embedded inside `TaskFormModal` and
 * row-list shaped; this surface needs an open → search → pick → close flow.
 *
 * Submits via the shared `useAddDependency` hook (FS, lag 0). The server's
 * cycle-detection 400 surfaces inline below the result list so the user
 * can pick a different task without dismissing the modal.
 */
export interface ScheduleDependencyPickerProps {
  /** Source task — never appears in the result list. */
  task: Task;
  /** Picker mode. `predecessor` adds picked → source; `successor` adds source → picked. */
  mode: 'predecessor' | 'successor';
  /** Project UUID — invalidates the right cache key after success. */
  projectId: string;
  /** Full task list for filtering. */
  allTasks: Task[];
  /** Task ids already linked to source in this mode (excluded from results). */
  excludedIds: ReadonlySet<string>;
  onClose: () => void;
}

const MAX_RESULTS = 12;

export function ScheduleDependencyPicker({
  task,
  mode,
  projectId,
  allTasks,
  excludedIds,
  onClose,
}: ScheduleDependencyPickerProps) {
  const addDep = useAddDependency(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [cycleMessage, setCycleMessage] = useState<string | null>(null);

  // Focus search input on mount; respects motion preference by jumping
  // synchronously rather than scroll-into-view animation.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // All keyboard interaction goes through a window-scoped listener — keeps the
  // dialog container free of inline handlers (a11y lint
  // jsx-a11y/no-noninteractive-element-interactions). The search input still
  // owns the visible focus; the listener only acts while the picker is open.
  const submitRef = useRef<((target: Task) => void) | null>(null);
  const itemsRef = useRef<Task[]>([]);
  const activeIdxRef = useRef(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(itemsRef.current.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = itemsRef.current[activeIdxRef.current];
        if (target) submitRef.current?.(target);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allTasks
      .filter((t) => t.id !== task.id)
      .filter((t) => !excludedIds.has(t.id))
      .filter(
        (t) =>
          q === '' ||
          t.name.toLowerCase().includes(q) ||
          (t.wbs ?? '').toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [allTasks, task.id, excludedIds, search]);

  // Clamp active index when the list shrinks during typing.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, activeIdx]);

  const submit = useCallback(
    (target: Task) => {
      setCycleMessage(null);
      const payload =
        mode === 'predecessor'
          ? { predecessor: target.id, successor: task.id }
          : { predecessor: task.id, successor: target.id };
      addDep.mutate(payload, {
        onSuccess: () => onClose(),
        onError: (err) => {
          const cyc = parseCyclicDependencyError(err);
          setCycleMessage(cyc ? formatCycleMessage(cyc) : 'Failed to add dependency. Retry?');
        },
      });
    },
    [addDep, mode, task.id, onClose],
  );

  // Keep refs in sync for the window keydown handler.
  useEffect(() => { submitRef.current = submit; }, [submit]);
  useEffect(() => { itemsRef.current = filtered; }, [filtered]);
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  const title =
    mode === 'predecessor'
      ? `Add predecessor to “${task.name}”`
      : `Add successor to “${task.name}”`;

  return createPortal(
    <div className="fixed inset-0 z-[51] flex items-center justify-center">
      {/* Backdrop — separate button so the close affordance is keyboard- and
          screen-reader-accessible without bolting onClick onto a non-interactive
          parent (a11y rule jsx-a11y/click-events-have-key-events). */}
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[480px] max-h-[480px] bg-neutral-surface border border-neutral-border rounded-lg flex flex-col"
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-neutral-border">
          <h2 className="text-sm font-medium text-neutral-text-primary truncate">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded text-neutral-text-secondary hover:bg-neutral-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="px-4 pt-3 pb-2">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIdx(0);
              setCycleMessage(null);
            }}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="w-full h-9 px-3 text-[13px] border border-neutral-border rounded bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        </div>

        <ul role="listbox" aria-label="Task results" className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <li className="py-3 px-2 text-[13px] text-neutral-text-secondary">
              No matching tasks. Try a different search.
            </li>
          ) : (
            filtered.map((t, i) => (
              <li key={t.id} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => submit(t)}
                  className={[
                    'w-full flex items-center gap-2 h-9 px-2 rounded text-left text-[13px]',
                    i === activeIdx ? 'bg-neutral-row-hover' : '',
                  ].join(' ')}
                >
                  <span className="tppm-mono text-[11px] text-neutral-text-disabled w-12 shrink-0 truncate">
                    {t.wbs || '—'}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-neutral-text-primary">
                    {t.name}
                  </span>
                  <StatusChip status={t.status} isMilestone={t.isMilestone} />
                </button>
              </li>
            ))
          )}
        </ul>

        {cycleMessage && (
          <div
            role="alert"
            className="mx-4 mb-2 p-2 text-[12px] rounded border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk"
          >
            {cycleMessage}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-border text-[11px] text-neutral-text-secondary tppm-mono">
          ↑↓ navigate · Enter add · Esc cancel
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Compact status pill matching the design system semantics. */
function StatusChip({ status, isMilestone }: { status: Task['status']; isMilestone: boolean }) {
  if (isMilestone) {
    return (
      <span className="text-[11px] text-neutral-text-disabled w-24 text-right shrink-0">
        — milestone
      </span>
    );
  }
  const label = status.replace('_', ' ').toLowerCase();
  return (
    <span className="text-[11px] text-neutral-text-secondary w-24 text-right shrink-0 truncate">
      {label}
    </span>
  );
}

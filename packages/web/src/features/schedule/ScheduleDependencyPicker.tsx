import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@/types';
import {
  formatCycleMessage,
  parseCyclicDependencyError,
  useAddDependency,
} from '@/hooks/useTaskMutations';
import { toast } from '@/components/Toast';
import { useProgramTaskSearch } from '@/features/programs/hooks/useProgramTaskSearch';

/**
 * Schedule-canvas dependency picker (ADR-0066 Q4; cross-project ADR-0120).
 *
 * Lightweight search-and-pick modal opened from the right-click context menu's
 * "Add predecessor…" / "Add successor…" actions. NOT a reuse of Board's
 * `PredecessorsEditor` — that one is embedded inside `TaskFormModal` and
 * row-list shaped; this surface needs an open → search → pick → close flow.
 *
 * Two scopes:
 *  - **This project** (default): filters the local `allTasks` — instant, offline.
 *  - **Program** (only when `programId` is set): searches sibling projects of the
 *    same program via `useProgramTaskSearch`, so a user can gate a task against a
 *    task in another project (ADR-0120 cross-project critical path). The scope
 *    toggle is hidden entirely for a standalone project, so single-project
 *    behavior is unchanged.
 *
 * Submits via the shared `useAddDependency` hook (FS, lag 0). A cross-project
 * edge may come back `pending_acceptance` (ADR-0120 D2 consent gate); the
 * success toast reflects that. The server's cycle-detection 400 (now
 * program-scoped) surfaces inline below the result list so the user can pick a
 * different task without dismissing the modal.
 */
export interface ScheduleDependencyPickerProps {
  /** Source task — never appears in the result list. */
  task: Task;
  /** Picker mode. `predecessor` adds picked → source; `successor` adds source → picked. */
  mode: 'predecessor' | 'successor';
  /** Project UUID — invalidates the right cache key after success. */
  projectId: string;
  /**
   * Program UUID the current project belongs to, or null for a standalone
   * project. When null the scope toggle is hidden and the picker is single-
   * project only (no behavior change from before ADR-0120).
   */
  programId?: string | null;
  /** Full task list for filtering. */
  allTasks: Task[];
  /** Task ids already linked to source in this mode (excluded from results). */
  excludedIds: ReadonlySet<string>;
  /**
   * Scope tab to land on when opened. Defaults to `'project'` (unchanged
   * behavior for the right-click entry point). The drawer's Dependencies
   * section opens straight into `'program'` — a user reaching for this modal
   * from the drawer has already exhausted the inline same-project dropdown.
   */
  initialScope?: Scope;
  onClose: () => void;
}

const MAX_RESULTS = 12;

type Scope = 'project' | 'program';

/** Normalized pickable row — either a local task or a sibling-project task. */
interface PickItem {
  id: string;
  name: string;
  projectId: string;
  isCross: boolean;
  /** Local-only display fields. */
  wbs?: string | null;
  status?: Task['status'];
  isMilestone?: boolean;
  /** Cross-project display fields. */
  shortId?: string;
  projectName?: string;
}

/** One project's rows in program scope, in server order. */
interface CrossGroup {
  projectId: string;
  projectName: string;
  items: PickItem[];
}

export function ScheduleDependencyPicker({
  task,
  mode,
  projectId,
  programId,
  allTasks,
  excludedIds,
  initialScope = 'project',
  onClose,
}: ScheduleDependencyPickerProps) {
  const addDep = useAddDependency(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const canCrossProject = Boolean(programId);
  const [scope, setScope] = useState<Scope>(canCrossProject ? initialScope : 'project');
  const [search, setSearch] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [cycleMessage, setCycleMessage] = useState<string | null>(null);

  // Debounce the term feeding the program search so we don't fire a request per
  // keystroke; local (project-scope) filtering stays instant off `search`.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const programSearch = useProgramTaskSearch(
    scope === 'program' ? programId : null,
    scope === 'program' ? debouncedSearch : '',
    projectId,
  );

  // Focus search input on mount; respects motion preference by jumping
  // synchronously rather than scroll-into-view animation.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const projectItems = useMemo<PickItem[]>(() => {
    if (scope !== 'project') return [];
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
      .slice(0, MAX_RESULTS)
      .map<PickItem>((t) => ({
        id: t.id,
        name: t.name,
        projectId,
        isCross: false,
        wbs: t.wbs,
        status: t.status,
        isMilestone: t.isMilestone,
      }));
  }, [scope, allTasks, task.id, excludedIds, search, projectId]);

  const crossGroups = useMemo<CrossGroup[]>(() => {
    if (scope !== 'program') return [];
    const rows = programSearch.data ?? [];
    const byProject = new Map<string, CrossGroup>();
    for (const row of rows) {
      // The source task is same-project (excluded by the endpoint's
      // `exclude_project`), but guard anyway; and skip already-linked ids.
      if (row.id === task.id || excludedIds.has(row.id)) continue;
      let group = byProject.get(row.project_id);
      if (!group) {
        group = { projectId: row.project_id, projectName: row.project_name, items: [] };
        byProject.set(row.project_id, group);
      }
      group.items.push({
        id: row.id,
        name: row.name,
        projectId: row.project_id,
        isCross: true,
        shortId: row.short_id,
        projectName: row.project_name,
      });
    }
    return [...byProject.values()];
  }, [scope, programSearch.data, task.id, excludedIds]);

  // Flat list backing keyboard navigation — group order in program scope.
  const flatItems = useMemo<PickItem[]>(
    () => (scope === 'project' ? projectItems : crossGroups.flatMap((g) => g.items)),
    [scope, projectItems, crossGroups],
  );

  // Clamp active index when the list shrinks during typing / scope change.
  useEffect(() => {
    if (activeIdx >= flatItems.length) setActiveIdx(Math.max(0, flatItems.length - 1));
  }, [flatItems.length, activeIdx]);

  const submit = useCallback(
    (target: PickItem) => {
      setCycleMessage(null);
      const payload =
        mode === 'predecessor'
          ? { predecessor: target.id, successor: task.id }
          : { predecessor: task.id, successor: target.id };
      addDep.mutate(payload, {
        onSuccess: (data) => {
          if (target.isCross) {
            const where = target.projectName ?? 'another project';
            if (data.pending_acceptance) {
              toast.info(`Dependency proposed — waiting for ${where} to accept`);
            } else {
              toast.success(`Linked across projects to ${target.name} in ${where}`);
            }
          }
          onClose();
        },
        onError: (err) => {
          const cyc = parseCyclicDependencyError(err);
          setCycleMessage(cyc ? formatCycleMessage(cyc) : 'Failed to add dependency. Retry?');
        },
      });
    },
    [addDep, mode, task.id, onClose],
  );

  // Keep refs in sync for the window keydown handler.
  const submitRef = useRef<((target: PickItem) => void) | null>(null);
  const itemsRef = useRef<PickItem[]>([]);
  const activeIdxRef = useRef(0);
  useEffect(() => { submitRef.current = submit; }, [submit]);
  useEffect(() => { itemsRef.current = flatItems; }, [flatItems]);
  useEffect(() => { activeIdxRef.current = activeIdx; }, [activeIdx]);

  const switchScope = useCallback((next: Scope) => {
    setScope(next);
    setActiveIdx(0);
    setCycleMessage(null);
  }, []);

  // All keyboard interaction goes through a window-scoped listener — keeps the
  // dialog container free of inline handlers (a11y lint
  // jsx-a11y/no-noninteractive-element-interactions). The search input owns the
  // visible focus; ←/→ switch scope (the list is vertical, so horizontal arrows
  // are free), ↑/↓ move the active row, Enter adds, Esc cancels.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowLeft' && canCrossProject) {
        e.preventDefault();
        switchScope('project');
        return;
      }
      if (e.key === 'ArrowRight' && canCrossProject) {
        e.preventDefault();
        switchScope('program');
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
  }, [onClose, canCrossProject, switchScope]);

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
        className="absolute inset-0 bg-neutral-overlay"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative mx-3 w-full max-w-[480px] max-h-[480px] bg-neutral-surface border border-neutral-border rounded-card flex flex-col"
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-neutral-border">
          <h2 className="text-sm font-medium text-neutral-text-primary truncate">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {canCrossProject && (
          <div
            role="tablist"
            aria-label="Dependency search scope"
            className="mx-4 mt-3 grid grid-cols-2 gap-1 rounded-control bg-neutral-row-hover p-1 text-xs"
          >
            <ScopeTab
              label="This project"
              selected={scope === 'project'}
              onSelect={() => switchScope('project')}
            />
            <ScopeTab
              label="Program"
              selected={scope === 'program'}
              onSelect={() => switchScope('program')}
            />
          </div>
        )}

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
            placeholder={scope === 'program' ? 'Search tasks in this program…' : 'Search tasks…'}
            aria-label="Search tasks"
            className="w-full h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-disabled focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        </div>

        {scope === 'project' ? (
          <ul role="listbox" aria-label="Task results" className="flex-1 overflow-y-auto px-2 pb-2">
            {projectItems.length === 0 ? (
              <li className="py-3 px-2 text-[13px] text-neutral-text-secondary">
                No matching tasks. Try a different search.
              </li>
            ) : (
              projectItems.map((item, i) => (
                <ResultRow
                  key={item.id}
                  item={item}
                  active={i === activeIdx}
                  onHover={() => setActiveIdx(i)}
                  onPick={() => submit(item)}
                />
              ))
            )}
          </ul>
        ) : (
          <ProgramResults
            groups={crossGroups}
            flatItems={flatItems}
            activeIdx={activeIdx}
            isLoading={programSearch.isLoading && debouncedSearch.trim().length > 0}
            isError={programSearch.isError}
            hasQuery={debouncedSearch.trim().length > 0}
            onHover={setActiveIdx}
            onPick={submit}
            onRetry={() => void programSearch.refetch()}
          />
        )}

        {cycleMessage && (
          <div
            role="alert"
            className="mx-4 mb-2 p-2 text-[12px] rounded-card border border-semantic-at-risk/40 bg-semantic-at-risk-bg text-semantic-at-risk"
          >
            {cycleMessage}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary tppm-mono">
          {canCrossProject ? '←→ scope · ↑↓ navigate · Enter add · Esc cancel' : '↑↓ navigate · Enter add · Esc cancel'}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A single tab in the scope segmented control. tabIndex -1 keeps focus on the
 *  search input; the toggle is driven by click or the ←/→ window bindings. */
function ScopeTab({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      tabIndex={-1}
      onClick={onSelect}
      className={[
        'h-7 rounded-control px-2 font-medium transition-colors',
        selected
          ? 'bg-brand-primary text-white'
          : 'text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

/** Program-scope result body: grouped rows, plus loading / empty / error states. */
function ProgramResults({
  groups,
  flatItems,
  activeIdx,
  isLoading,
  isError,
  hasQuery,
  onHover,
  onPick,
  onRetry,
}: {
  groups: CrossGroup[];
  flatItems: PickItem[];
  activeIdx: number;
  isLoading: boolean;
  isError: boolean;
  hasQuery: boolean;
  onHover: (idx: number) => void;
  onPick: (item: PickItem) => void;
  onRetry: () => void;
}) {
  if (!hasQuery) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        Search for a task in another project of this program to depend on.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 pt-1" aria-busy="true" aria-label="Loading tasks">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-9 my-1 rounded-control bg-neutral-row-hover motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        Couldn’t load program tasks.{' '}
        <button
          type="button"
          onClick={onRetry}
          className="underline text-brand-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none rounded-control"
        >
          Retry
        </button>
      </div>
    );
  }
  if (flatItems.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 pb-2 py-3 text-[13px] text-neutral-text-secondary">
        No matching tasks in this program. Try a different search.
      </div>
    );
  }
  // Map each rendered row back to its flat index for keyboard highlight.
  let flat = -1;
  return (
    <ul role="listbox" aria-label="Program task results" className="flex-1 overflow-y-auto px-2 pb-2">
      {groups.map((group) => (
        <li key={group.projectId} className="mb-1">
          <div className="sticky top-0 z-[1] flex items-center gap-1.5 px-2 py-1 bg-neutral-surface text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-chip bg-neutral-text-disabled" />
            <span className="truncate">{group.projectName}</span>
          </div>
          <ul>
            {group.items.map((item) => {
              flat += 1;
              const idx = flat;
              return (
                <ResultRow
                  key={item.id}
                  item={item}
                  active={idx === activeIdx}
                  onHover={() => onHover(idx)}
                  onPick={() => onPick(item)}
                />
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** One result row, shared by both scopes. */
function ResultRow({
  item,
  active,
  onHover,
  onPick,
}: {
  item: PickItem;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={onHover}
        onClick={onPick}
        className={[
          'w-full flex items-center gap-2 min-h-11 sm:h-9 px-2 rounded-control text-left text-[13px]',
          active ? 'bg-neutral-row-hover' : '',
        ].join(' ')}
      >
        <span className="tppm-mono text-xs text-neutral-text-disabled w-12 shrink-0 truncate">
          {item.isCross ? item.shortId || '—' : item.wbs || '—'}
        </span>
        <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{item.name}</span>
        {!item.isCross && (
          <StatusChip status={item.status ?? 'NOT_STARTED'} isMilestone={item.isMilestone ?? false} />
        )}
      </button>
    </li>
  );
}

/** Compact status pill matching the design system semantics. */
function StatusChip({ status, isMilestone }: { status: Task['status']; isMilestone: boolean }) {
  if (isMilestone) {
    return (
      <span className="text-xs text-neutral-text-disabled w-24 text-right shrink-0">
        — milestone
      </span>
    );
  }
  const label = status.replace('_', ' ').toLowerCase();
  return (
    <span className="text-xs text-neutral-text-secondary w-24 text-right shrink-0 truncate">
      {label}
    </span>
  );
}

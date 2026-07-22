import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RelationType, Task } from '@/types';
import { useCreateTaskRelation } from '@/hooks/useTaskRelations';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useProgramTaskSearch } from '@/features/programs/hooks/useProgramTaskSearch';
import { forwardRelationLabel } from './relationLabel';

/**
 * Relative-link picker (#2068). A portaled, focus-trapped search-and-pick dialog
 * modeled on {@link ScheduleDependencyPicker}: This-project scope filters the
 * local schedule cache instantly, Program scope searches sibling projects via
 * `useProgramTaskSearch` (hidden for a standalone project). It adds a
 * relation-type `<select>` — the created relation is always `source = task.id`,
 * `target = picked`, so the select shows the FORWARD labels ("Relates to" /
 * "Blocks" / "Duplicates").
 *
 * Distinct from the dependency picker: no cycle detection, no lag, no CPM
 * cascade — a relation is a non-scheduling cross-reference.
 */
export interface RelatedLinkPickerProps {
  /** Source task — always the relation's `source`; never appears in results. */
  task: Task;
  projectId: string;
  /** Program UUID, or null for a standalone project (hides the scope toggle). */
  programId?: string | null;
  /** Full local task list for This-project filtering. */
  allTasks: Task[];
  /** Counterpart ids already related to this task — excluded from results. */
  excludedIds: ReadonlySet<string>;
  onClose: () => void;
}

const MAX_RESULTS = 12;

type Scope = 'project' | 'program';

const RELATION_OPTIONS: RelationType[] = ['relates_to', 'blocks', 'duplicates'];

interface PickItem {
  id: string;
  name: string;
  isCross: boolean;
  hexId?: string | null;
  projectName?: string;
}

interface CrossGroup {
  projectId: string;
  projectName: string;
  items: PickItem[];
}

export function RelatedLinkPicker({
  task,
  projectId,
  programId,
  allTasks,
  excludedIds,
  onClose,
}: RelatedLinkPickerProps) {
  const createRel = useCreateTaskRelation(task.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const canCrossProject = Boolean(programId);
  const [scope, setScope] = useState<Scope>(canCrossProject ? 'program' : 'project');
  const [search, setSearch] = useState('');
  const [relationType, setRelationType] = useState<RelationType>('relates_to');
  const [activeIdx, setActiveIdx] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Debounce the program search term; local filtering stays instant.
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

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Focus trap + Escape-to-close (web-rule 206). Declared after the input-focus
  // effect so the trap's initial focus is a no-op and the search input keeps it.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, onClose);

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
        isCross: false,
        hexId: t.shortId ?? t.wbs ?? null,
      }));
  }, [scope, allTasks, task.id, excludedIds, search]);

  const crossGroups = useMemo<CrossGroup[]>(() => {
    if (scope !== 'program') return [];
    const rows = programSearch.data ?? [];
    const byProject = new Map<string, CrossGroup>();
    for (const row of rows) {
      if (row.id === task.id || excludedIds.has(row.id)) continue;
      let group = byProject.get(row.project_id);
      if (!group) {
        group = { projectId: row.project_id, projectName: row.project_name, items: [] };
        byProject.set(row.project_id, group);
      }
      group.items.push({
        id: row.id,
        name: row.name,
        isCross: true,
        hexId: row.short_id,
        projectName: row.project_name,
      });
    }
    return [...byProject.values()];
  }, [scope, programSearch.data, task.id, excludedIds]);

  const flatItems = useMemo<PickItem[]>(
    () => (scope === 'project' ? projectItems : crossGroups.flatMap((g) => g.items)),
    [scope, projectItems, crossGroups],
  );

  useEffect(() => {
    if (activeIdx >= flatItems.length) setActiveIdx(Math.max(0, flatItems.length - 1));
  }, [flatItems.length, activeIdx]);

  const submit = useCallback(
    (target: PickItem) => {
      setErrorMessage(null);
      createRel.mutate(
        { source: task.id, target: target.id, relation_type: relationType },
        {
          onSuccess: () => onClose(),
          onError: () => setErrorMessage('Couldn’t link task. Try again.'),
        },
      );
    },
    [createRel, task.id, relationType, onClose],
  );

  // Refs for the window keydown handler.
  const submitRef = useRef<((target: PickItem) => void) | null>(null);
  const itemsRef = useRef<PickItem[]>([]);
  const activeIdxRef = useRef(0);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);
  useEffect(() => {
    itemsRef.current = flatItems;
  }, [flatItems]);
  useEffect(() => {
    activeIdxRef.current = activeIdx;
  }, [activeIdx]);

  const switchScope = useCallback((next: Scope) => {
    setScope(next);
    setActiveIdx(0);
    setErrorMessage(null);
  }, []);

  // Keyboard interaction on a window listener (keeps the container handler-free
  // for a11y lint). ←/→ switch scope, ↑/↓ move the active row, Enter adds.
  // Escape is owned by the focus trap.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
  }, [canCrossProject, switchScope]);

  const title = `Link a task to “${task.name}”`;
  const listboxId = 'related-link-results';
  const activeId = flatItems.length > 0 ? `related-link-opt-${activeIdx}` : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[51] flex items-center justify-center">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-neutral-overlay"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative mx-3 w-full max-w-[480px] max-h-[520px] bg-neutral-surface border border-neutral-border rounded-card flex flex-col focus:outline-none"
      >
        <div className="h-12 flex items-center justify-between px-4 border-b border-neutral-border">
          <h2 className="text-sm font-medium text-neutral-text-primary truncate">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            className="w-7 h-7 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-row-hover focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="px-4 pt-3">
          <label
            htmlFor="related-link-relation-type"
            className="block text-xs font-medium text-neutral-text-secondary mb-1"
          >
            Relation
          </label>
          <select
            id="related-link-relation-type"
            value={relationType}
            onChange={(e) => setRelationType(e.target.value as RelationType)}
            className="w-full h-9 px-2 text-[13px] border border-neutral-border rounded-control bg-neutral-surface text-neutral-text-primary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          >
            {RELATION_OPTIONS.map((rt) => (
              <option key={rt} value={rt}>
                {forwardRelationLabel(rt)}
              </option>
            ))}
          </select>
        </div>

        {canCrossProject && (
          <div
            role="tablist"
            aria-label="Task search scope"
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
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActiveIdx(0);
              setErrorMessage(null);
            }}
            placeholder={scope === 'program' ? 'Search tasks in this program…' : 'Search tasks…'}
            aria-label="Search tasks"
            className="w-full h-9 px-3 text-[13px] border border-neutral-border rounded-control bg-neutral-surface text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
          />
        </div>

        {scope === 'project' ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Task results"
            className="flex-1 overflow-y-auto px-2 pb-2"
          >
            {projectItems.length === 0 ? (
              <li className="py-3 px-2 text-[13px] text-neutral-text-secondary">
                No matching tasks. Try a different search.
              </li>
            ) : (
              projectItems.map((item, i) => (
                <ResultRow
                  key={item.id}
                  optionId={`related-link-opt-${i}`}
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
            listboxId={listboxId}
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

        {errorMessage && (
          <div
            role="alert"
            className="mx-4 mb-2 p-2 text-[12px] rounded-card border border-semantic-critical/40 bg-semantic-critical-bg text-semantic-critical"
          >
            {errorMessage}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-border text-xs text-neutral-text-secondary tppm-mono">
          {canCrossProject
            ? '←→ scope · ↑↓ navigate · Enter add · Esc cancel'
            : '↑↓ navigate · Enter add · Esc cancel'}
        </div>
      </div>
    </div>,
    document.body,
  );
}

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
          ? 'bg-brand-primary text-neutral-text-inverse'
          : 'text-neutral-text-secondary hover:text-neutral-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function ProgramResults({
  listboxId,
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
  listboxId: string;
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
        Search for a task in another project of this program to link.
      </div>
    );
  }
  if (isLoading) {
    return (
      <div
        className="flex-1 overflow-y-auto px-4 pb-2 pt-1"
        aria-busy="true"
        aria-label="Loading tasks"
      >
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
  let flat = -1;
  return (
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Program task results"
      className="flex-1 overflow-y-auto px-2 pb-2"
    >
      {groups.map((group) => (
        <li key={group.projectId} className="mb-1">
          <div className="sticky top-0 z-[1] flex items-center gap-1.5 px-2 py-1 bg-neutral-surface text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-chip bg-neutral-text-disabled"
            />
            <span className="truncate">{group.projectName}</span>
          </div>
          <ul>
            {group.items.map((item) => {
              flat += 1;
              const idx = flat;
              return (
                <ResultRow
                  key={item.id}
                  optionId={`related-link-opt-${idx}`}
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

function ResultRow({
  optionId,
  item,
  active,
  onHover,
  onPick,
}: {
  optionId: string;
  item: PickItem;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <li id={optionId} role="option" aria-selected={active}>
      <button
        type="button"
        tabIndex={-1}
        onMouseEnter={onHover}
        onClick={onPick}
        className={[
          'w-full flex items-center gap-2 min-h-11 md:h-9 px-2 rounded-control text-left text-[13px]',
          active ? 'bg-neutral-row-hover' : '',
        ].join(' ')}
      >
        <span className="tppm-mono text-xs text-neutral-text-disabled w-12 shrink-0 truncate">
          {item.hexId || '—'}
        </span>
        <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{item.name}</span>
        {item.isCross && item.projectName && (
          <span className="text-xs text-neutral-text-secondary w-24 text-right shrink-0 truncate">
            {item.projectName}
          </span>
        )}
      </button>
    </li>
  );
}

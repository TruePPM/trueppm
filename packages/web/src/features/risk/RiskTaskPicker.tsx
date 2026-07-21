import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Task } from '@/types';
import { useScheduleTasks } from '@/hooks/useScheduleTasks';
import { formatTaskStatus } from './taskStatusDisplay';

/**
 * Inline task picker for the risk create/edit form (#2156, ADR-0566).
 *
 * Deliberately NOT a portaled dialog like {@link RelatedLinkPicker}: the risk
 * drawer runs its own document-level Tab focus trap that walks `drawerRef`'s
 * DOM subtree, and a portaled picker rendered at `document.body` escapes that
 * subtree and breaks the trap (and stacks a second focus trap on the mobile
 * bottom sheet). Rendering the results list in-flow inside the drawer body keeps
 * a single focus context and scrolls naturally inside the 85vh mobile sheet.
 *
 * The project task list is already loaded via `useScheduleTasks`, so filtering
 * is instant and local — no debounce, no server search.
 */
export interface RiskTaskPickerProps {
  projectId: string;
  /** Currently linked task ids (the form's source of truth). */
  selectedIds: string[];
  /** Emits the full desired id set — the risk serializer replaces the M2M set. */
  onChange: (ids: string[]) => void;
  /** Max links the API allows (RiskSerializer.validate_tasks). */
  max?: number;
}

const MAX_RESULTS = 12;

export function RiskTaskPicker({ projectId, selectedIds, onChange, max = 10 }: RiskTaskPickerProps) {
  const { tasks, isLoading, error } = useScheduleTasks(projectId);
  const [search, setSearch] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tasksById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks ?? []) map.set(t.id, t);
    return map;
  }, [tasks]);

  const atLimit = selectedIds.length >= max;

  // Linkable candidates: leaf work only (exclude summaries and milestones),
  // not already selected, matching the query on name / wbs / short id.
  const results = useMemo<Task[]>(() => {
    if (!tasks) return [];
    const selected = new Set(selectedIds);
    const q = search.trim().toLowerCase();
    return tasks
      .filter((t) => !selected.has(t.id))
      .filter((t) => !t.isSummary && !t.isMilestone)
      .filter(
        (t) =>
          q === '' ||
          t.name.toLowerCase().includes(q) ||
          (t.wbs ?? '').toLowerCase().includes(q) ||
          (t.shortId ?? '').toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS);
  }, [tasks, selectedIds, search]);

  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    [],
  );

  function add(id: string) {
    if (atLimit || selectedIds.includes(id)) return;
    onChange([...selectedIds, id]);
    setSearch('');
    setActiveIdx(0);
  }

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setListOpen(true);
      setActiveIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = results[activeIdx];
      if (target) add(target.id);
    } else if (e.key === 'Escape' && listOpen) {
      // Close only the results list — do not let the risk drawer's Escape
      // handler close the whole drawer.
      e.stopPropagation();
      setListOpen(false);
    } else if (e.key === 'Backspace' && search === '' && selectedIds.length > 0) {
      remove(selectedIds[selectedIds.length - 1]);
    }
  }

  const listboxId = 'risk-task-picker-results';
  const activeId = listOpen && results.length > 0 ? `risk-task-opt-${activeIdx}` : undefined;
  const showList = listOpen && !atLimit && !isLoading;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="risk-task-search" className="text-sm font-medium text-neutral-text-primary">
        Linked tasks
      </label>
      <p id="risk-task-help" className="text-xs text-neutral-text-secondary">
        {atLimit ? (
          <span className="text-semantic-at-risk">Limit reached — remove a task to link another.</span>
        ) : (
          `Attach up to ${max} tasks from this project.`
        )}
      </p>

      {/* Selected chips */}
      {selectedIds.length > 0 && (
        <ul className="flex flex-wrap gap-2 mt-1" aria-label="Linked tasks">
          {selectedIds.map((id) => {
            const t = tasksById.get(id);
            const label = t ? t.name : 'Unavailable task';
            return (
              <li key={id}>
                <span
                  className={[
                    'inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-xs',
                    'bg-neutral-surface-raised border border-neutral-border',
                    t ? 'text-neutral-text-secondary' : 'text-neutral-text-disabled italic',
                  ].join(' ')}
                >
                  <span className="max-w-[180px] truncate">{label}</span>
                  <button
                    type="button"
                    onClick={() => remove(id)}
                    aria-label={`Remove ${label}`}
                    className="w-5 h-5 -mr-1 inline-flex items-center justify-center rounded-control
                      text-neutral-text-secondary hover:text-neutral-text-primary
                      focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Search input */}
      <input
        id="risk-task-search"
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        aria-describedby="risk-task-help"
        autoComplete="off"
        value={search}
        disabled={atLimit || isLoading}
        onFocus={() => setListOpen(true)}
        onBlur={() => {
          // Delay so a mousedown on a result registers before the list unmounts.
          blurTimer.current = setTimeout(() => setListOpen(false), 120);
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          setActiveIdx(0);
          setListOpen(true);
        }}
        onKeyDown={handleKeyDown}
        placeholder={
          isLoading
            ? 'Loading tasks…'
            : atLimit
              ? `Maximum of ${max} tasks linked.`
              : 'Search tasks to link…'
        }
        aria-label="Search tasks to link"
        className="mt-1 w-full h-11 border border-neutral-border rounded-control px-3 bg-neutral-surface
          text-neutral-text-primary text-sm placeholder:text-neutral-text-disabled
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
          disabled:opacity-50"
      />

      {error && (
        <p role="alert" className="text-xs text-semantic-critical">
          Couldn&apos;t load tasks to link. You can still save other changes.
        </p>
      )}

      {/* In-flow results list — pushes form content down rather than overlaying,
          so it never clips inside the mobile bottom sheet's scroll container. */}
      {showList && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Task results"
          className="mt-1 max-h-[200px] overflow-y-auto border border-neutral-border rounded-control bg-neutral-surface"
        >
          {results.length === 0 ? (
            <li className="py-3 px-3 text-[13px] text-neutral-text-secondary">
              No matching tasks. Try a different search.
            </li>
          ) : (
            results.map((t, i) => (
              <li key={t.id} id={`risk-task-opt-${i}`} role="option" aria-selected={i === activeIdx}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIdx(i)}
                  // onMouseDown (not onClick) so the pick fires before the input's
                  // blur tears the list down.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(t.id);
                  }}
                  className={[
                    'w-full flex items-center gap-2 min-h-11 md:h-9 px-3 rounded-control text-left text-[13px]',
                    i === activeIdx ? 'bg-neutral-row-hover' : '',
                  ].join(' ')}
                >
                  <span className="tppm-mono text-xs text-neutral-text-disabled w-12 shrink-0 truncate">
                    {t.shortId || t.wbs || '—'}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-neutral-text-primary">{t.name}</span>
                  <span className="text-xs text-neutral-text-secondary shrink-0">
                    {formatTaskStatus(t.status)}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

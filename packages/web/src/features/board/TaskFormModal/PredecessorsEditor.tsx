import { useMemo, useRef, useState } from 'react';
import type { Task } from '@/types';

/**
 * Working-copy row tracked by the form before any /dependencies/ writes.
 * `dependencyId` is set on rows that already exist on the server (edit
 * mode) and remain `undefined` for newly-added rows on the client. The
 * form's save sequencer compares the working copy against the original
 * predecessors to derive create/delete operations.
 *
 * Per ADR-0052 §8: dep_type is fixed to 'FS' and lag is 0 in this editor.
 * Other types and lag values are edited from the drawer's dependency
 * section.
 */
export interface PredecessorWorkingRow {
  /** Server-assigned dependency edge id. Undefined for newly-added rows. */
  dependencyId?: string;
  predecessorId: string;
  predecessorName: string;
  predecessorWbs: string;
}

export interface PredecessorsEditorProps {
  /** Working list — caller owns and updates via the callbacks below. */
  rows: PredecessorWorkingRow[];
  /** All tasks in the project — used to populate the search picker. */
  allTasks: Task[];
  /** UUID of the task this form is editing — excluded from the picker so a
   *  task cannot be its own predecessor. Pass null in create mode. */
  currentTaskId: string | null;
  /** Caller is authoritative on disabled state (read-only mode). */
  disabled?: boolean;
  onAdd: (task: { id: string; name: string; wbs: string }) => void;
  onRemove: (rowIndex: number) => void;
}

/**
 * Predecessor edges editor — search-and-add picker plus a chip list.
 * Lag and dep_type are not exposed here (default FS / 0); deeper editing
 * lives in the drawer's dependency section per ADR-0052 §8.
 */
export function PredecessorsEditor({
  rows,
  allTasks,
  currentTaskId,
  disabled = false,
  onAdd,
  onRemove,
}: PredecessorsEditorProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredTasks = useMemo(() => {
    const assignedIds = new Set(rows.map((r) => r.predecessorId));
    const q = search.trim().toLowerCase();
    return allTasks
      .filter((t) => t.id !== currentTaskId)
      .filter((t) => !assignedIds.has(t.id))
      .filter((t) => !t.isSummary) // dependencies on summary tasks are server-rejected
      .filter((t) => q === '' || t.name.toLowerCase().includes(q) || t.wbs.includes(q))
      .slice(0, 12);
  }, [allTasks, rows, currentTaskId, search]);

  return (
    <div className="flex flex-col gap-1">
      {rows.length > 0 && (
        <div className="flex flex-col gap-1">
          {rows.map((row, index) => (
            <div
              key={row.predecessorId}
              className="flex items-center gap-2 px-2 py-1.5 rounded border border-neutral-border bg-neutral-surface"
            >
              <span className="tppm-mono text-[11px] text-neutral-text-disabled w-12 shrink-0 truncate">
                {row.predecessorWbs || '—'}
              </span>
              <span className="text-[13px] text-neutral-text-primary flex-1 min-w-0 truncate">
                {row.predecessorName}
              </span>
              <button
                type="button"
                onClick={() => onRemove(index)}
                disabled={disabled}
                aria-label={`Remove predecessor ${row.predecessorName}`}
                className="w-6 h-6 inline-flex items-center justify-center rounded text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-40 shrink-0"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {!pickerOpen ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setPickerOpen(true);
            // Defer focus so the input has mounted.
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="h-8 px-3 self-start rounded border border-dashed border-neutral-border text-[13px] text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none disabled:opacity-40"
        >
          + Link predecessor
        </button>
      ) : (
        <div className="relative border border-neutral-border rounded">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setPickerOpen(false);
                setSearch('');
              }
            }}
            placeholder="Search tasks by name or WBS…"
            aria-label="Search predecessor tasks"
            className="w-full h-8 px-2 text-[13px] text-neutral-text-primary bg-transparent border-none focus-visible:outline-none placeholder:text-neutral-text-disabled"
          />
          {filteredTasks.length > 0 && (
            <ul
              role="listbox"
              aria-label="Tasks matching search"
              className="max-h-48 overflow-y-auto border-t border-neutral-border"
            >
              {filteredTasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onAdd({ id: t.id, name: t.name, wbs: t.wbs });
                      setSearch('');
                      // Keep picker open so users can chain-add multiple.
                      inputRef.current?.focus();
                    }}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-neutral-surface-sunken focus-visible:bg-neutral-surface-sunken focus-visible:outline-none"
                  >
                    <span className="tppm-mono text-[11px] text-neutral-text-disabled w-12 shrink-0">
                      {t.wbs || '—'}
                    </span>
                    <span className="text-neutral-text-primary truncate">{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-neutral-border px-2 py-1.5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                setSearch('');
              }}
              className="text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary px-2 py-0.5 rounded focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:outline-none"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

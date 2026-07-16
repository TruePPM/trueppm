import { useMemo, useRef, useState } from 'react';
import type { ProjectResource } from '@/types';
import { AvatarInitials } from '@/components/AvatarInitials';

/**
 * Working-copy row tracked by the form before any task-resources/ writes.
 * `assignmentId` is set on rows that already exist on the server (edit
 * mode) and remain `undefined` for newly-added rows on the client. The
 * form's save sequencer compares the working copy against the original
 * task assignments to derive create/patch/delete operations (ADR-0052 §7).
 */
export interface AssigneeWorkingRow {
  /** Server-assigned task-resource row id. Undefined for newly-added rows. */
  assignmentId?: string;
  resourceId: string;
  resourceName: string;
  /** Decimal allocation, e.g. 0.6 = 60%. */
  units: number;
}

export interface AssigneesEditorProps {
  /** Working list — caller owns and updates via the callbacks below. */
  rows: AssigneeWorkingRow[];
  /** Project resource pool — used to populate the search picker. */
  pool: ProjectResource[];
  /** Caller is authoritative on disabled state (read-only mode). */
  disabled?: boolean;
  /** Add a new row at the end with default 1.0 units. */
  onAdd: (resource: { id: string; name: string }) => void;
  /** Update units on an existing row. */
  onUpdateUnits: (rowIndex: number, units: number) => void;
  /** Remove a row. */
  onRemove: (rowIndex: number) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Per-assignee unit % editor. Inline list with avatar, name, role, units
 * spinner, remove button — plus a search input that filters the project
 * resource pool by name.
 *
 * David's hero feature (#305 VoC, score 9/10): every PM tool he's used
 * treats allocation as 100% or 0%. This editor makes per-assignee
 * fractional units a first-class part of task creation/editing without
 * crossing into the cross-project allocation surface (Enterprise — out of
 * scope here).
 */
export function AssigneesEditor({
  rows,
  pool,
  disabled = false,
  onAdd,
  onUpdateUnits,
  onRemove,
}: AssigneesEditorProps) {
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredPool = useMemo(() => {
    if (search.trim() === '') return [];
    const assignedIds = new Set(rows.map((r) => r.resourceId));
    const q = search.trim().toLowerCase();
    return pool
      .filter((p) => !assignedIds.has(p.resource.id))
      .filter((p) => p.resource.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [pool, rows, search]);

  // DRF serializes DecimalField as a string ("0.50"), so the row units may
  // arrive as a string at runtime even though the TS type is `number`.
  // Coerce so the running total stays numeric — otherwise reduce concatenates
  // the strings and total.toFixed throws.
  const total = rows.reduce((s, r) => s + Number(r.units), 0);
  const totalClass = total > 1.0001
    ? 'text-semantic-at-risk'
    : 'text-neutral-text-secondary';

  return (
    <div className="border border-neutral-border rounded-card p-1.5 bg-neutral-surface flex flex-col gap-1">
      {rows.map((row, index) => (
        <div
          key={row.resourceId}
          className="flex items-center gap-2 px-1.5 py-1 rounded-control bg-neutral-surface hover:bg-neutral-surface-sunken/60"
        >
          <AvatarInitials initials={initials(row.resourceName)} size="sm" />
          <span className="text-[13px] font-medium text-neutral-text-primary flex-1 min-w-0 truncate">
            {row.resourceName}
          </span>
          <div className="relative shrink-0">
            <input
              type="number"
              min={0}
              max={200}
              step={5}
              disabled={disabled}
              value={Math.round(row.units * 100)}
              onChange={(e) => {
                const pct = Number(e.target.value);
                if (Number.isFinite(pct)) onUpdateUnits(index, pct / 100);
              }}
              aria-label={`Allocation percent for ${row.resourceName}`}
              className="w-16 h-7 pl-2 pr-5 text-[13px] tppm-mono text-neutral-text-primary bg-neutral-surface border border-neutral-border rounded-control focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none disabled:opacity-60"
            />
            <span
              aria-hidden="true"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-neutral-text-disabled pointer-events-none"
            >
              %
            </span>
          </div>
          <button
            type="button"
            onClick={() => onRemove(index)}
            disabled={disabled}
            aria-label={`Remove ${row.resourceName}`}
            className="w-6 h-6 inline-flex items-center justify-center rounded-control text-neutral-text-secondary hover:bg-neutral-surface-raised focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none disabled:opacity-40 shrink-0"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ))}

      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={rows.length === 0 ? 'Search people…' : 'Add another…'}
          aria-label="Search people to assign"
          className="w-full h-7 px-2 text-[13px] text-neutral-text-primary bg-transparent border-none focus-visible:outline-none placeholder:text-neutral-text-disabled disabled:opacity-60"
        />
        {filteredPool.length > 0 && !disabled && (
          // Plain <ul> (implicit role="list"), not role="listbox": the rows are
          // Tab-focusable action buttons, not single-select options. A listbox
          // with no role="option" / aria-activedescendant / arrow-nav
          // mis-announces the control (#838).
          <ul
            aria-label="People matching search"
            className="absolute left-0 right-0 top-full mt-1 z-10 bg-neutral-surface border border-neutral-border rounded-card shadow-none max-h-48 overflow-y-auto"
          >
            {filteredPool.map((pr) => (
              <li key={pr.resource.id}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd({ id: pr.resource.id, name: pr.resource.name });
                    setSearch('');
                    inputRef.current?.focus();
                  }}
                  className="w-full text-left px-2 py-1.5 text-[13px] text-neutral-text-primary hover:bg-neutral-surface-sunken focus:bg-neutral-surface-sunken focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-inset"
                >
                  {pr.resource.name}
                  {pr.roleTitle && (
                    <span className="ml-2 text-xs text-neutral-text-disabled">
                      {pr.roleTitle}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Σ total — David's hero indicator */}
      <div className="flex items-center justify-end pr-1 pt-0.5">
        <span
          className={`tppm-mono text-xs ${totalClass}`}
          aria-live="polite"
          aria-label={`Total allocation ${total.toFixed(2)}`}
        >
          Σ {total.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

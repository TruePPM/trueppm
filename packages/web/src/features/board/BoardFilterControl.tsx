/**
 * Board filter trigger + facet popover (issue 1091, ADR-0199).
 *
 * A quiet toolbar pill that opens a popover of facet groups (Assignee, Priority
 * band, Due window). The pill carries a count badge of the active facet values.
 * State is owned by BoardView (so the `f` shortcut and the URL/localStorage
 * plumbing live in one place); this component is presentational plus its own
 * outside-click / Escape dismissal.
 *
 * a11y: each facet group is a <fieldset>/<legend>; every option is a labeled
 * checkbox; the trigger announces its active count via aria-label. Filtered-out
 * cards are made non-focusable + aria-hidden by BoardCard, so faceting never
 * strands focus on a hidden card.
 */
import { useEffect, useRef, type RefObject } from 'react';
import {
  UNASSIGNED,
  ALL_PRIORITY_BANDS,
  ALL_DUE_WINDOWS,
  PRIORITY_BAND_LABEL,
  DUE_WINDOW_LABEL,
  activeFacetCount,
  isFacetsActive,
  toggleFacetValue,
  type FacetFilters,
} from './boardFacets';
import { labelDotStyle } from '@/lib/labelColors';

/** A label option for the facet (id + display name + palette color key). */
export interface LabelFacetOption {
  id: string;
  name: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Active-filter chip bar — keeps the lens inescapable when the popover is closed
// ---------------------------------------------------------------------------

interface BoardFilterChipsProps {
  filters: FacetFilters;
  assigneeNameById: Map<string, string>;
  /** Label id → display name, for the active-filter chip text (ADR-0400). */
  labelNameById: Map<string, string>;
  matchCount: number;
  onChange: (next: FacetFilters) => void;
  onClearAll: () => void;
}

function Chip({ label, onRemove, removeAria }: { label: string; onRemove: () => void; removeAria: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-chip bg-brand-primary/10 text-brand-primary px-2 py-0.5">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeAria}
        className="leading-none rounded-full hover:bg-brand-primary/20 w-4 h-4 inline-flex items-center justify-center
          focus:ring-2 focus:ring-brand-primary focus:outline-none"
      >
        <span aria-hidden="true">✕</span>
      </button>
    </span>
  );
}

/**
 * The always-visible active-filter bar (issue 1091). Mirrors the My-tasks /
 * Tech-debt filter chips already on the board so a dimmed board never reads as
 * "lost cards". Rendered only when at least one facet value is active.
 */
export function BoardFilterChips({
  filters,
  assigneeNameById,
  labelNameById,
  matchCount,
  onChange,
  onClearAll,
}: BoardFilterChipsProps) {
  if (!isFacetsActive(filters)) return null;

  const assigneeLabel = (id: string) =>
    id === UNASSIGNED ? 'Unassigned' : (assigneeNameById.get(id) ?? 'Unknown');

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs bg-brand-primary/5
        border-b border-brand-primary/20 text-brand-primary overflow-x-auto"
      role="status"
      data-testid="board-filter-chips"
    >
      <span aria-hidden="true" className="font-medium flex-shrink-0">
        Filtering:
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        {filters.assignees.map((id) => (
          <Chip
            key={`a-${id}`}
            label={assigneeLabel(id)}
            removeAria={`Remove filter: ${assigneeLabel(id)}`}
            onRemove={() => onChange(toggleFacetValue(filters, 'assignees', id))}
          />
        ))}
        {filters.priority.map((band) => (
          <Chip
            key={`p-${band}`}
            label={`Priority: ${PRIORITY_BAND_LABEL[band]}`}
            removeAria={`Remove filter: priority ${PRIORITY_BAND_LABEL[band]}`}
            onRemove={() => onChange(toggleFacetValue(filters, 'priority', band))}
          />
        ))}
        {filters.due.map((w) => (
          <Chip
            key={`d-${w}`}
            label={`Due: ${DUE_WINDOW_LABEL[w]}`}
            removeAria={`Remove filter: due ${DUE_WINDOW_LABEL[w]}`}
            onRemove={() => onChange(toggleFacetValue(filters, 'due', w))}
          />
        ))}
        {filters.labels.map((id) => {
          const name = labelNameById.get(id) ?? 'Unknown';
          return (
            <Chip
              key={`l-${id}`}
              label={`Label: ${name}`}
              removeAria={`Remove filter: label ${name}`}
              onRemove={() => onChange(toggleFacetValue(filters, 'labels', id))}
            />
          );
        })}
      </div>
      <span className="text-neutral-text-secondary flex-shrink-0" aria-hidden="true">
        · {matchCount} match{matchCount === 1 ? '' : 'es'}
      </span>
      <button
        type="button"
        onClick={onClearAll}
        data-testid="board-filter-chips-clear"
        className="ml-auto underline hover:no-underline flex-shrink-0
          focus:ring-2 focus:ring-brand-primary focus:outline-none rounded-control"
      >
        Clear all →
      </button>
    </div>
  );
}

interface BoardFilterControlProps {
  filters: FacetFilters;
  assigneeOptions: { resourceId: string; name: string }[];
  /** Label facet options (ADR-0400) — labels present on the board's cards. */
  labelOptions: LabelFacetOption[];
  onChange: (next: FacetFilters) => void;
  onClearAll: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owned by the parent so the `f` shortcut can return focus here on close. */
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function CheckboxRow({
  checked,
  onToggle,
  label,
  testId,
  swatchColor,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  testId?: string;
  /** When set, render a leading palette color dot (label facet rows). */
  swatchColor?: string;
}) {
  return (
    <label
      className="flex items-center gap-2 min-h-[44px] py-1 px-1.5 rounded-control cursor-pointer
        hover:bg-neutral-surface-raised text-sm text-neutral-text-primary
        focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        data-testid={testId}
        className="h-4 w-4 rounded border-neutral-border text-brand-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      />
      {swatchColor !== undefined && (
        <span
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={labelDotStyle(swatchColor)}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{label}</span>
    </label>
  );
}

export function BoardFilterControl({
  filters,
  assigneeOptions,
  labelOptions,
  onChange,
  onClearAll,
  open,
  onOpenChange,
  triggerRef,
}: BoardFilterControlProps) {
  const count = activeFacetCount(filters);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointer-down or Escape; return focus to the trigger on
  // Escape (mirrors the WIP popover pattern in BoardView).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange, triggerRef]);

  // Focus the first control when the popover opens.
  const firstControlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) firstControlRef.current?.focus();
  }, [open]);

  const triggerLabel = count > 0 ? `Filters, ${count} active` : 'Filters';

  return (
    <div className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={triggerLabel}
        title="Filter cards (f)"
        data-testid="board-filter-trigger"
        className={[
          'inline-flex items-center gap-1 rounded-full text-xs px-2.5 py-1 relative',
          'focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none',
          count > 0 || open
            ? 'bg-brand-primary/10 text-brand-primary'
            : 'text-neutral-text-primary hover:bg-neutral-surface-raised',
        ].join(' ')}
      >
        <span aria-hidden="true">⚑</span>
        Filters
        {count > 0 && (
          <span
            aria-hidden="true"
            data-testid="board-filter-count"
            className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1
              rounded-full bg-brand-primary text-white text-xs font-bold tppm-mono leading-none"
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Board filters"
          data-testid="board-filter-panel"
          className="absolute top-full left-0 mt-1 z-30 w-[300px] max-w-[calc(100vw-2rem)]
            rounded-card border border-neutral-border bg-neutral-surface shadow-pop
            p-3 flex flex-col gap-3 max-h-[70vh] overflow-y-auto"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-text-primary">Filters</h2>
            <button
              type="button"
              onClick={onClearAll}
              disabled={count === 0}
              data-testid="board-filter-clear-all"
              className="text-xs text-brand-primary underline hover:no-underline
                disabled:text-neutral-text-disabled disabled:no-underline disabled:cursor-default
                focus:ring-2 focus:ring-brand-primary focus:outline-none rounded-control px-1"
            >
              Clear all
            </button>
          </div>

          {/* Assignee */}
          <fieldset className="flex flex-col gap-0.5 border-0 p-0 m-0">
            <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary mb-1">
              Assignee
            </legend>
            <label
              className="flex items-center gap-2 min-h-[44px] py-1 px-1.5 rounded-control cursor-pointer
                hover:bg-neutral-surface-raised text-sm text-neutral-text-primary
                focus-within:ring-2 focus-within:ring-brand-primary focus-within:ring-offset-1"
            >
              <input
                ref={firstControlRef}
                type="checkbox"
                checked={filters.assignees.includes(UNASSIGNED)}
                onChange={() => onChange(toggleFacetValue(filters, 'assignees', UNASSIGNED))}
                data-testid="facet-assignee-unassigned"
                className="h-4 w-4 rounded border-neutral-border text-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              />
              <span className="truncate italic text-neutral-text-secondary">Unassigned</span>
            </label>
            {assigneeOptions.length > 0 && (
              <div aria-hidden="true" className="h-px bg-neutral-border/60 my-0.5" />
            )}
            {assigneeOptions.map((opt) => (
              <CheckboxRow
                key={opt.resourceId}
                checked={filters.assignees.includes(opt.resourceId)}
                onToggle={() => onChange(toggleFacetValue(filters, 'assignees', opt.resourceId))}
                label={opt.name}
                testId={`facet-assignee-${opt.resourceId}`}
              />
            ))}
            {assigneeOptions.length === 0 && (
              <p className="text-xs text-neutral-text-disabled px-1.5 py-1">No assignees on this board yet.</p>
            )}
          </fieldset>

          {/* Priority band */}
          <fieldset className="flex flex-col gap-0.5 border-0 p-0 m-0">
            <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary mb-1">
              Priority
            </legend>
            <div className="grid grid-cols-2 gap-x-2">
              {ALL_PRIORITY_BANDS.map((band) => (
                <CheckboxRow
                  key={band}
                  checked={filters.priority.includes(band)}
                  onToggle={() => onChange(toggleFacetValue(filters, 'priority', band))}
                  label={PRIORITY_BAND_LABEL[band]}
                  testId={`facet-priority-${band}`}
                />
              ))}
            </div>
          </fieldset>

          {/* Due window */}
          <fieldset className="flex flex-col gap-0.5 border-0 p-0 m-0">
            <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary mb-1">
              Due
            </legend>
            <div className="grid grid-cols-2 gap-x-2">
              {ALL_DUE_WINDOWS.map((w) => (
                <CheckboxRow
                  key={w}
                  checked={filters.due.includes(w)}
                  onToggle={() => onChange(toggleFacetValue(filters, 'due', w))}
                  label={DUE_WINDOW_LABEL[w]}
                  testId={`facet-due-${w}`}
                />
              ))}
            </div>
          </fieldset>

          {/* Label (ADR-0400) — hidden when the board has no labeled cards, so the
              facet never shows an empty group. */}
          {labelOptions.length > 0 && (
            <fieldset className="flex flex-col gap-0.5 border-0 p-0 m-0">
              <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-text-secondary mb-1">
                Label
              </legend>
              {labelOptions.map((opt) => (
                <CheckboxRow
                  key={opt.id}
                  checked={filters.labels.includes(opt.id)}
                  onToggle={() => onChange(toggleFacetValue(filters, 'labels', opt.id))}
                  label={opt.name}
                  swatchColor={opt.color}
                  testId={`facet-label-${opt.id}`}
                />
              ))}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}

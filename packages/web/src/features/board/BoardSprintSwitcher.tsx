/**
 * Board sprint-view switcher (#429, ADR-0119).
 *
 * A dropdown in the board toolbar that scopes the phase columns to a single
 * sprint, or back to the full project ("All tasks"). The selection is owned by
 * BoardView (persisted in the `?sprint=` URL param); this component is a
 * controlled presenter.
 *
 * The list offers ACTIVE, PLANNED, and COMPLETED sprints — viewing a closed
 * sprint's board is a legitimate retrospective read (this is why it diverges
 * from the ADR-0059 *assignment* selector, which excludes COMPLETED). CANCELLED
 * sprints are omitted.
 */
import { useEffect, useRef, useState } from 'react';
import type { ApiSprint, SprintState } from '@/types';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface BoardSprintSwitcherProps {
  sprints: ApiSprint[];
  selectedSprintId: string | null;
  onSelectSprint: (id: string | null) => void;
}

const STATE_CHIP: Partial<Record<SprintState, { label: string; cls: string }>> = {
  ACTIVE: { label: 'Active', cls: 'bg-semantic-on-track-bg text-semantic-on-track' },
  PLANNED: { label: 'Planned', cls: 'bg-brand-primary/10 text-brand-primary' },
  COMPLETED: { label: 'Done', cls: 'bg-neutral-surface-sunken text-neutral-text-secondary' },
};

// Active first, then planned, then completed — the order a team scans in.
const STATE_ORDER: SprintState[] = ['ACTIVE', 'PLANNED', 'COMPLETED'];

function dateRange(s: ApiSprint): string {
  const fmt = (iso: string) =>
    new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(s.start_date)} – ${fmt(s.finish_date)}`;
}

// How many sprints the "Recent" group shows before the rest collapse behind
// the "Show all sprints" disclosure (#1141). The currently-selected sprint is
// always pinned into Recent even when it falls outside this window.
const RECENT_LIMIT = 3;

export function BoardSprintSwitcher({
  sprints,
  selectedSprintId,
  onSelectSprint,
}: BoardSprintSwitcherProps) {
  const itl = useIterationLabel();
  const [open, setOpen] = useState(false);
  // Disclosure: when true the full sprint list is expanded inline (#1141).
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Collapse the "show all" disclosure each time the menu closes so it reopens
  // in the pruned state.
  useEffect(() => {
    if (!open) setShowAll(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: globalThis.MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectable = sprints
    .filter((s) => s.state !== 'CANCELLED')
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        b.start_date.localeCompare(a.start_date),
    );
  const selected = selectedSprintId ? sprints.find((s) => s.id === selectedSprintId) : null;
  const buttonLabel = selected ? selected.name : 'Project';

  // Pruning (#1141): "Recent" = the first RECENT_LIMIT of the existing sort,
  // with the currently-selected sprint always pinned in even if it falls
  // outside that window (so the active scope never hides behind the disclosure).
  // The remainder collapses behind a "Show all sprints (N)" disclosure.
  const recentBase = selectable.slice(0, RECENT_LIMIT);
  const selectedInRecent = selected ? recentBase.some((s) => s.id === selected.id) : true;
  const recent = selected && !selectedInRecent ? [...recentBase, selected] : recentBase;
  const hidden = selectable.filter((s) => !recent.some((r) => r.id === s.id));
  const visibleSprints = showAll ? [...recent, ...hidden] : recent;

  function choose(id: string | null) {
    onSelectSprint(id);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={selected ? `${itl.singular} view: ${selected.name}` : 'Board scope: Project'}
        className={[
          'inline-flex h-7 items-center gap-1 rounded-control border px-2 text-xs font-medium',
          'focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1',
          selected
            ? 'border-brand-primary/40 bg-brand-primary/5 text-brand-primary'
            : 'border-neutral-border bg-neutral-surface text-neutral-text-primary hover:bg-neutral-surface-raised',
        ].join(' ')}
      >
        <span className="max-w-[10rem] truncate">{buttonLabel}</span>
        <span aria-hidden="true" className="text-neutral-text-secondary">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Board scope"
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-card
            border border-neutral-border bg-neutral-surface py-1 shadow-pop"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!selectedSprintId}
            onClick={() => choose(null)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-sm
              hover:bg-neutral-surface-raised focus:outline-none focus:bg-neutral-surface-raised
              focus:ring-2 focus:ring-inset focus:ring-brand-primary"
          >
            <span className="font-medium text-neutral-text-primary">All tasks (project)</span>
            {!selectedSprintId && <span aria-hidden="true">✓</span>}
          </button>

          {visibleSprints.length > 0 && <div className="my-1 border-t border-neutral-border" />}

          {visibleSprints.length > 0 && (
            <div
              role="presentation"
              className="px-3 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide
                text-neutral-text-secondary"
            >
              {showAll ? 'All sprints' : 'Recent'}
            </div>
          )}

          {visibleSprints.map((s) => {
            const chip = STATE_CHIP[s.state];
            const isSel = s.id === selectedSprintId;
            return (
              <button
                key={s.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSel}
                onClick={() => choose(s.id)}
                className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-sm
                  hover:bg-neutral-surface-raised focus:outline-none focus:bg-neutral-surface-raised
                  focus:ring-2 focus:ring-inset focus:ring-brand-primary"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-neutral-text-primary">{s.name}</span>
                    {chip && (
                      <span
                        className={`shrink-0 rounded-chip px-1 py-0.5 text-xs font-semibold uppercase tracking-wide ${chip.cls}`}
                      >
                        {chip.label}
                      </span>
                    )}
                  </span>
                  <span className="tppm-mono text-xs text-neutral-text-secondary">
                    {dateRange(s)}
                  </span>
                </span>
                {isSel && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}

          {/* Disclosure (#1141): expand the remaining sprints inline, or
              collapse back to Recent. Suppressed when nothing is hidden. */}
          {hidden.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="flex w-full items-center px-3 py-2 text-left text-xs font-medium
                text-brand-primary hover:bg-neutral-surface-raised
                focus:outline-none focus:bg-neutral-surface-raised
                focus:ring-2 focus:ring-inset focus:ring-brand-primary"
            >
              {showAll ? 'Show fewer' : `Show all sprints (${hidden.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Move to…" — the drag's twin for anyone not holding a pointer (#2954).
 *
 * This exists because the drag added a capability the keyboard did not have.
 * `⌥→`/`⌥←` step one level against the row immediately above; drag can move a
 * row under *any* phase in the plan. Shipping that as pointer-only would put a
 * capability behind a gesture a keyboard or switch user cannot make (WCAG
 * 2.1.1), and on touch it is the path that needs no drag at all — which is why
 * the design put it in the row action sheet rather than treating it as an
 * accessibility fallback bolted on afterwards.
 *
 * Same refusals as the drag, applied by *omission* rather than by disabling: a
 * milestone and the row's own subtree are simply not in the list. A disabled row
 * saying "a gate cannot hold work" would be honest during a drag — the pointer
 * is already over it and the user needs to know why nothing happened — but in a
 * chooser it is a list of things you may pick, and an unpickable entry is noise
 * (rule 302's "absent, not disabled", applied one level down).
 */

import { useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { WBS_INDENT } from './scheduleConstants';
import { moveDestinations, type OutlineDragRow, type OutlineMovePlan } from './outlineDrag';

export interface MoveToDialogProps {
  /** The row being moved. */
  taskId: string;
  taskName: string;
  /** Every task in the plan — not just the visible ones: a collapsed phase is a valid home. */
  rows: OutlineDragRow[];
  onCancel: () => void;
  onConfirm: (plan: OutlineMovePlan) => void;
}

export function MoveToDialog({
  taskId,
  taskName,
  rows,
  onCancel,
  onConfirm,
}: MoveToDialogProps) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, onCancel);
  const destinations = useMemo(() => moveDestinations(rows, taskId), [rows, taskId]);
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);

  const chosen = destinations.find((d) =>
    selectedId === undefined ? false : d.id === selectedId,
  );

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-to-title"
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none motion-safe:animate-scrim-fade"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-md flex-col rounded-lg border border-neutral-border bg-neutral-surface p-5 shadow-pop motion-safe:animate-modal-scale-in"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 id="move-to-title" className="mb-1 text-base font-semibold text-neutral-text-primary">
          Move “{taskName || 'Untitled'}”
        </h2>
        <p className="mb-3 text-xs text-neutral-text-secondary">
          Pick its new home. Anything under it moves with it, and reordering does not change any
          dates.
        </p>

        <ul
          // A single-select list, not a listbox of buttons: each row is one
          // choice, and the radio semantics are what tell a screen reader that
          // picking one un-picks the rest.
          role="radiogroup"
          aria-label="New parent"
          className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-border"
        >
          {destinations.map((destination) => {
            const isSelected = selectedId !== undefined && destination.id === selectedId;
            return (
              <li key={destination.id ?? '__root__'}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelectedId(destination.id)}
                  className={[
                    'flex w-full items-center gap-2 py-2 pr-2 text-left text-xs',
                    'min-h-[44px] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary',
                    isSelected
                      ? 'bg-brand-primary/10 text-neutral-text-primary'
                      : 'text-neutral-text-secondary hover:bg-neutral-surface-sunken',
                  ].join(' ')}
                  style={{ paddingLeft: 8 + destination.level * WBS_INDENT }}
                >
                  <span className="truncate">{destination.name}</span>
                  {destination.isCurrentParent && (
                    <span className="shrink-0 text-neutral-text-secondary">· current</span>
                  )}
                  {destination.becomesPhase && !destination.isCurrentParent && (
                    <span className="shrink-0 text-brand-primary">· becomes a phase</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!chosen || chosen.isCurrentParent}
            onClick={() => {
              if (!chosen || chosen.isCurrentParent) return;
              onConfirm({
                taskId,
                newParentId: chosen.id,
                // Append at the end of the destination, which is where the
                // reparent endpoint puts it anyway — a picker states a home,
                // not a position, so claiming one would be a second decision
                // the user was never asked to make.
                beforeSiblingId: null,
                destinationName: chosen.id === null ? null : chosen.name,
                becomesPhase: chosen.becomesPhase,
              });
            }}
          >
            Move
          </Button>
        </div>
      </div>
    </div>
  );
}

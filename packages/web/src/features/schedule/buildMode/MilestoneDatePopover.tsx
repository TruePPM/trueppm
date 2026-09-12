import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useProjectId } from '@/hooks/useProjectId';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { useSprintsByState } from '@/hooks/useSprints';

export interface MilestoneParent {
  name: string;
  finish?: string;
}

interface Props {
  open: boolean;
  /** Parent summary tasks, closest ancestor first. */
  parents: MilestoneParent[];
  onSelect: (isoDate: string) => void;
  onClose: () => void;
  /**
   * Positioning from the caller's `useAnchoredPopover` call (web rule 260) —
   * the caller owns the trigger (the Start cell), so it owns the hook. `null`
   * while closed/unmeasured; the panel does not portal until this is set.
   */
  style: CSSProperties | null;
  /** Attach to the portaled panel root — required for the outside-dismiss check below. */
  panelRef: RefObject<HTMLDivElement | null>;
}

/**
 * 220px quick-pick popover for milestone start dates (#345).
 *
 * Chips (in order):
 *  1. "End of [phase]" for each parent summary with a finish date (up to 3)
 *  2. "End of current sprint" when a sprint is active
 *  3. "Pick custom…" — opens a native date input inline
 *
 * Portaled to `document.body` and positioned `fixed` via the caller's
 * `useAnchoredPopover` call (#3664, web rule 260) — the Start cell it opens
 * from renders inside `TaskListPanel`'s `overflow-x-hidden overflow-y-auto`
 * virtualized scroll wrapper, so an in-flow `absolute` 220px panel could clip
 * against either edge (the same class of bug #3663 fixed for the session-trail
 * popover).
 */
export function MilestoneDatePopover({ open, parents, onSelect, onClose, style, panelRef }: Props) {
  const projectId = useProjectId() ?? null;
  const itl = useIterationLabel(projectId);
  const { active: activeSprint } = useSprintsByState(projectId);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
    // `panelRef` is now a prop (the caller's useAnchoredPopover ref), not a
    // local useRef, so eslint can no longer assume its identity is stable —
    // it is, in practice, but listing it costs nothing and keeps the rule honest.
  }, [open, onClose, panelRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, onClose]);

  if (!open || !style) return null;

  const phaseChips = parents.filter((p) => !!p.finish).slice(0, 3);

  const handleCustomSubmit = () => {
    if (customDate) {
      onSelect(customDate);
      onClose();
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Pick milestone date"
      style={style}
      className="z-50 rounded-card border border-chrome-border
        bg-chrome-surface-raised p-2 space-y-1 overflow-y-auto"
    >
      {phaseChips.map((p) => (
        <button
          key={p.name}
          type="button"
          className="w-full text-left text-xs px-2 py-1 rounded-control
            hover:bg-brand-primary/10 text-chrome-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          onClick={() => {
            onSelect(p.finish!);
            onClose();
          }}
        >
          End of {p.name}
        </button>
      ))}

      {activeSprint && (
        <button
          type="button"
          className="w-full text-left text-xs px-2 py-1 rounded-control
            hover:bg-brand-primary/10 text-chrome-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          onClick={() => {
            onSelect(activeSprint.finish_date);
            onClose();
          }}
        >
          End of {itl.lower} ({activeSprint.name})
        </button>
      )}

      {!showCustom ? (
        <button
          type="button"
          className="w-full text-left text-xs px-2 py-1 rounded-control text-neutral-text-secondary
            hover:bg-brand-primary/10
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          onClick={() => setShowCustom(true)}
        >
          Pick custom…
        </button>
      ) : (
        <div className="flex items-center gap-1 px-1">
          <input
            type="date"
            value={customDate}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(e) => setCustomDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setShowCustom(false);
              }
            }}
            className="flex-1 min-w-0 text-xs rounded-control border border-neutral-border px-1 py-0.5
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
          <button
            type="button"
            onClick={handleCustomSubmit}
            disabled={!customDate}
            className="text-xs px-1.5 py-0.5 rounded-control bg-sage-500 text-navy-900 dark:bg-sage-400 dark:text-navy-900 disabled:opacity-40
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1"
          >
            OK
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}

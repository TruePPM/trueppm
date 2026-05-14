import { useRef, useEffect, useState } from 'react';
import { useProjectId } from '@/hooks/useProjectId';
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
}

/**
 * 220px quick-pick popover for milestone start dates (#345).
 *
 * Chips (in order):
 *  1. "End of [phase]" for each parent summary with a finish date (up to 3)
 *  2. "End of current sprint" when a sprint is active
 *  3. "Pick custom…" — opens a native date input inline
 *
 * Positioned by the caller (use a relative wrapper; this is absolute).
 */
export function MilestoneDatePopover({ open, parents, onSelect, onClose }: Props) {
  const projectId = useProjectId() ?? null;
  const { active: activeSprint } = useSprintsByState(projectId);
  const [showCustom, setShowCustom] = useState(false);
  const [customDate, setCustomDate] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

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
  }, [open, onClose]);

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

  if (!open) return null;

  const phaseChips = parents.filter((p) => !!p.finish).slice(0, 3);

  const handleCustomSubmit = () => {
    if (customDate) {
      onSelect(customDate);
      onClose();
    }
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Pick milestone date"
      className="absolute top-full left-0 z-50 w-[220px] mt-0.5 rounded border border-chrome-border
        bg-chrome-surface-raised p-2 space-y-1"
    >
      {phaseChips.map((p) => (
        <button
          key={p.name}
          type="button"
          className="w-full text-left text-xs px-2 py-1 rounded
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
          className="w-full text-left text-xs px-2 py-1 rounded
            hover:bg-brand-primary/10 text-chrome-text-primary
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
            focus-visible:ring-offset-1"
          onClick={() => {
            onSelect(activeSprint.finish_date);
            onClose();
          }}
        >
          End of sprint ({activeSprint.name})
        </button>
      )}

      {!showCustom ? (
        <button
          type="button"
          className="w-full text-left text-xs px-2 py-1 rounded text-neutral-text-secondary
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
            className="flex-1 min-w-0 text-xs rounded border border-neutral-border px-1 py-0.5
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
          <button
            type="button"
            onClick={handleCustomSubmit}
            disabled={!customDate}
            className="text-xs px-1.5 py-0.5 rounded bg-brand-primary text-white disabled:opacity-40
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1"
          >
            OK
          </button>
        </div>
      )}
    </div>
  );
}

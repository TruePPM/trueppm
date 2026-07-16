import { WarningIcon } from '@/components/Icons';
import { useState } from 'react';
import { ScopeChangeDrawer } from './ScopeChangeDrawer';

interface Props {
  /** The ACTIVE sprint whose scope changed (rollup.scope_change_sprint_id). */
  sprintId: string;
  /**
   * Optional point delta. When present the chip reads
   * "Scope changed (+N / −M pts)"; when absent (the many-row Gantt/Overview
   * surfaces, where a per-row fetch would be N requests) it reads
   * "Scope changed" and the exact delta appears in the drawer on open.
   */
  summary?: { points_added: number; points_removed: number };
  /** Smaller padding for dense rows (Gantt list cell). */
  compact?: boolean;
  /** Icon-only (⚠) — for width-constrained cells like the Gantt milestone cell,
   *  where the full label would overflow. The label moves to the accessible name. */
  iconOnly?: boolean;
}

/**
 * Persistent, clickable scope-change chip (#550) — the replacement for the
 * tooltip-only ⓘ that previously hid the signal behind a hover. Sarah scans the
 * Gantt at 7am without hovering, so the signal must be visible in the scan pass;
 * Jordan/Morgan need the delta detail, which opens in the audit drawer one click
 * away. Rendered wherever `rollup.sprint_scope_changed` is true and a
 * `scope_change_sprint_id` is known.
 */
export function ScopeChangedChip({
  sprintId,
  summary,
  compact = false,
  iconOnly = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const label =
    summary && (summary.points_added > 0 || summary.points_removed > 0)
      ? `Scope changed (+${summary.points_added} / −${summary.points_removed} pts)`
      : 'Scope changed';

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          // Don't let the click bubble to a row/card selection handler.
          e.stopPropagation();
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={iconOnly ? `${label} — view audit` : undefined}
        title={iconOnly ? label : undefined}
        className={`inline-flex items-center gap-1 rounded-full border border-semantic-at-risk/40 bg-semantic-at-risk-bg
          text-semantic-at-risk font-medium whitespace-nowrap
          hover:border-semantic-at-risk focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1
          ${iconOnly ? 'px-1 py-0 text-xs' : compact ? 'px-1.5 py-0 text-xs' : 'px-2 py-0.5 text-xs'}`}
      >
        <WarningIcon className="inline-block h-3 w-3 align-[-0.125em]" aria-hidden="true" />
        {!iconOnly && label}
      </button>
      {open && <ScopeChangeDrawer sprintId={sprintId} onClose={() => setOpen(false)} />}
    </>
  );
}

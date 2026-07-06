/**
 * Dedicated secondary "Export" toolbar button that opens the schedule-export
 * options dialog (issue 1438, ADR-0233). Standalone + labelled at `lg`; at `md`
 * the entry folds into the toolbar's `···` Project-actions menu (ScheduleView),
 * and export is hidden below `md` (a deck-style export is a desk task).
 *
 * Disabled — with the rule-122 dimmed recipe (never opacity-50) — when the
 * schedule is empty; a `title` explains why and carries the ⌘⇧E shortcut hint.
 */
interface ScheduleExportButtonProps {
  disabled: boolean;
  onOpen: () => void;
}

export function ScheduleExportButton({ disabled, onOpen }: ScheduleExportButtonProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      aria-haspopup="dialog"
      aria-label="Export schedule as PDF"
      title={disabled ? 'No activities to export' : 'Export schedule as PDF · ⌘⇧E'}
      className={[
        'inline-flex h-7 flex-shrink-0 items-center gap-1 rounded border border-neutral-border px-3',
        'text-xs font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
        'disabled:cursor-not-allowed disabled:border-neutral-border/55 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary',
      ].join(' ')}
    >
      <span aria-hidden="true">⬇</span>
      <span>Export</span>
      <span aria-hidden="true" className="text-neutral-text-secondary">
        ▾
      </span>
    </button>
  );
}

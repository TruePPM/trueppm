import type { ScheduleAuthorMode } from '@/hooks/useScheduleAuthorMode';

export interface AuthorModePillProps {
  mode: ScheduleAuthorMode;
  onToggle: () => void;
}

/**
 * Toolbar pill signaling the Alt+A Author/Read toggle (#2727, ADR-0776 §5).
 * "Read" mode forces the Schedule's readOnly gate on client-side, whatever
 * the user's server role — a personal "look, don't touch" mode. Mirrors
 * `BuildModePill`'s always-visible discovery affordance: an invisible mode
 * flip is worse than the discoverability gap #2682 already had to fix for
 * the row properties button.
 */
export function AuthorModePill({ mode, onToggle }: AuthorModePillProps) {
  const isRead = mode === 'read';
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="author-mode-pill"
      aria-label={
        isRead
          ? 'Read mode active — edits are blocked. Press Alt+A or click to switch to Author mode.'
          : 'Author mode active — edits are allowed. Press Alt+A or click to switch to Read mode.'
      }
      // shrink-0 + whitespace-nowrap keep the pill a fixed size in the
      // flex-nowrap toolbar (web-rule 113), matching BuildModePill.
      className={`hidden md:inline-flex shrink-0 whitespace-nowrap h-7 px-2 items-center gap-1.5 rounded-control
        border text-xs font-medium uppercase tracking-widest
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
        focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface
        ${
          isRead
            ? 'border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary hover:bg-neutral-row-hover'
            : 'border-brand-primary/30 bg-brand-primary/8 text-brand-primary hover:bg-brand-primary/12'
        }`}
    >
      <span aria-hidden="true">{isRead ? '👁' : '✎'}</span>
      {isRead ? 'Read' : 'Author'}
    </button>
  );
}

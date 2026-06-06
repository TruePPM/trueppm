import { NavLink } from 'react-router';

interface Props {
  collapsed: boolean;
  isDrawer: boolean;
  /** Optional callback fired when the user navigates from a drawer (closes it). */
  onNavigated?: () => void;
}

/**
 * Collapsed-rail Programs entry (ADR-0070).
 *
 * In the expanded sidebar and the mobile drawer, programs are reached through
 * the searchable {@link ProjectScopePicker} (#959). When the desktop sidebar is
 * collapsed to its 60px icon rail there is no room for the picker, so this
 * renders a single icon link to the /programs route as the compact entry point.
 */
export function ProgramsSection({ collapsed, isDrawer, onNavigated }: Props) {
  // The scope picker owns the expanded/drawer surfaces; this component is only
  // mounted for the collapsed desktop rail. Render nothing otherwise.
  if (!collapsed || isDrawer) return null;

  return (
    <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2">
      <NavLink
        to="/programs"
        aria-label="Programs"
        onClick={() => onNavigated?.()}
        className={({ isActive }) =>
          [
            'relative flex h-11 w-11 items-center justify-center rounded transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
            isActive
              ? 'bg-brand-primary/10 text-chrome-text-primary'
              : 'text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
          ].join(' ')
        }
      >
        <svg width="16" height="16" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <path d="M2 2h4v4H2V2zm6 0h4v4H8V2zM2 8h4v4H2V8zm6 0h4v4H8V8z" />
        </svg>
      </NavLink>
    </div>
  );
}

import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { usePrograms } from '@/hooks/usePrograms';
import { NewProgramModal } from '@/features/programs/NewProgramModal';

interface Props {
  collapsed: boolean;
  isDrawer: boolean;
  /** Optional callback fired when the user navigates from a drawer (closes it). */
  onNavigated?: () => void;
}

/**
 * Sidebar section listing the user's programs (ADR-0070).
 *
 * Sits between the "Me" block and the "PROJECTS" section. Mirrors the
 * PROJECTS section visual treatment (uppercase header, + button) so the
 * sidebar reads as one coherent vertical stack of section + list, not as
 * an ad-hoc addition.
 *
 * When the user has no programs at all the entire section collapses to a
 * single "+ New program" affordance so the sidebar doesn't display an empty
 * heading line. The /programs route remains reachable via direct URL — the
 * section simply hides until a program exists.
 */
export function ProgramsSection({ collapsed, isDrawer, onNavigated }: Props) {
  const { data: programs, isLoading } = usePrograms();
  const { programId: currentProgramId } = useParams<{ programId: string }>();
  const [showNewProgram, setShowNewProgram] = useState(false);
  const navigate = useNavigate();

  const hasPrograms = !isLoading && programs && programs.length > 0;

  if (collapsed && !isDrawer) {
    // Icon-only mode — render a single anchor to /programs as a compact entry
    // point. The full list is reachable from the expanded sidebar or the
    // /programs route directly.
    return (
      <>
        <div className="shrink-0 border-t border-chrome-border/8 px-2 py-2">
          <NavLink
            to="/programs"
            aria-label="Programs"
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
        {showNewProgram && (
          <NewProgramModal
            onClose={() => setShowNewProgram(false)}
            onCreated={(programId) => {
              setShowNewProgram(false);
              onNavigated?.();
              void navigate(`/programs/${programId}/projects`);
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="shrink-0 border-b border-chrome-border/8 px-2 py-2">
        <div className="flex items-center justify-between px-1">
          <h2
            className="text-xs font-semibold uppercase tracking-widest text-chrome-text-secondary"
            aria-label="Programs"
          >
            PROGRAMS
          </h2>
          {/* 44x44 touch target with 12x12 icon (rule 5). */}
          <button
            type="button"
            onClick={() => setShowNewProgram(true)}
            aria-label="New program"
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded
              text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary
              focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path
                d="M6 1v10M1 6h10"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {hasPrograms && (
          <ul aria-label="Programs" className="mt-1 space-y-0.5">
            {programs.map((p) => (
              <li key={p.id}>
                <NavLink
                  to={`/programs/${p.id}`}
                  onClick={() => onNavigated?.()}
                  aria-current={currentProgramId === p.id ? 'page' : undefined}
                  className={({ isActive }) =>
                    [
                      'flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 focus-visible:ring-offset-chrome-surface',
                      isActive
                        ? 'border-l-2 border-brand-primary bg-brand-primary/10 font-medium text-chrome-text-primary'
                        : 'border-l-2 border-transparent text-chrome-text-secondary hover:bg-neutral-text-primary/5 hover:text-chrome-text-primary',
                    ].join(' ')
                  }
                >
                  <span className="truncate">{p.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showNewProgram && (
        <NewProgramModal
          onClose={() => setShowNewProgram(false)}
          onCreated={(programId) => {
            setShowNewProgram(false);
            onNavigated?.();
            void navigate(`/programs/${programId}/projects`);
          }}
        />
      )}
    </>
  );
}

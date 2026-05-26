import { useState } from 'react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { useProgram } from '@/hooks/useProgram';
import { DeleteProgramDialog } from './DeleteProgramDialog';

const PROGRAM_TABS = [
  { path: 'overview', label: 'Overview' },
  { path: 'backlog', label: 'Backlog' },
  { path: 'projects', label: 'Projects' },
  { path: 'members', label: 'Members' },
] as const;

/**
 * /programs/:programId — program shell with secondary tab nav (ADR-0070).
 *
 * Mirrors :class:`ProjectSettingsPage` exactly — same NavLink + Outlet pattern
 * and the same tab styling. The Overview tab is the default landing target (set
 * by the router via index Navigate) and renders the program rollup (#713); the
 * Backlog tab is functional in the URL but renders a stub until #501 lands.
 *
 * Header is the only thing this shell adds over the bare tab strip — it shows
 * the program name + an action menu (Edit · Delete) gated by role.
 */
export function ProgramShell() {
  const params = useParams<{ programId: string }>();
  const programId = params.programId;
  const { data: program, isLoading, error } = useProgram(programId);
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  if (!programId) return null;

  const canManage = program ? (program.my_role ?? -1) >= 3 : false; // ADMIN+
  const canDelete = program ? program.my_role === 4 : false; // OWNER only

  return (
    <div className="flex h-full flex-col bg-neutral-surface">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-neutral-border px-6 py-4">
        <div className="min-w-0 flex-1">
          {isLoading && (
            <div
              aria-hidden="true"
              className="h-5 w-48 animate-pulse rounded bg-neutral-surface-raised"
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-semantic-critical">
              Failed to load program.
            </p>
          )}
          {program && (
            <>
              <h1 className="truncate text-lg font-semibold text-neutral-text-primary">
                {program.name}
              </h1>
              {program.description && (
                <p className="mt-1 truncate text-xs text-neutral-text-secondary">
                  {program.description}
                </p>
              )}
              <p className="tppm-mono mt-1 text-xs text-neutral-text-secondary">
                {program.methodology}
                {program.my_role_label && <> · {program.my_role_label}</>}
              </p>
            </>
          )}
        </div>

        {program && (canManage || canDelete) && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="Program actions"
              className="flex h-11 w-11 items-center justify-center rounded text-neutral-text-secondary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span aria-hidden="true" className="text-xl leading-none">⋯</span>
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label="Program actions"
                className="absolute right-0 top-12 z-10 min-w-[12rem] rounded border border-neutral-border bg-neutral-surface py-1"
              >
                {canDelete && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setShowDelete(true);
                    }}
                    className="block w-full px-4 py-2 text-left text-sm text-semantic-critical
                      hover:bg-neutral-surface-raised
                      focus-visible:outline-none focus-visible:bg-neutral-surface-raised"
                  >
                    Delete program…
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* Tabs */}
      <nav
        aria-label="Program sections"
        className="flex items-center gap-1 overflow-x-auto border-b border-neutral-border px-4 pt-4"
      >
        {PROGRAM_TABS.map((tab) => (
          <NavLink
            key={tab.path}
            to={`/programs/${programId}/${tab.path}`}
            replace
            className={({ isActive }) =>
              [
                '-mb-px px-3 py-1.5 text-sm font-medium border-b-2 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
                isActive
                  ? 'border-brand-primary text-brand-primary'
                  : 'border-transparent text-neutral-text-secondary hover:text-neutral-text-primary',
              ].join(' ')
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      {/* Sub-page content */}
      <div className="flex-1 overflow-y-auto">
        <Outlet />
      </div>

      {showDelete && program && (
        <DeleteProgramDialog
          program={program}
          onClose={() => setShowDelete(false)}
          onDeleted={() => {
            setShowDelete(false);
            void navigate('/programs');
          }}
        />
      )}
    </div>
  );
}

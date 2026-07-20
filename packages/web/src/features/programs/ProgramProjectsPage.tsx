import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useProgram } from '@/hooks/useProgram';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useAssignProjectToProgram } from '@/hooks/useProgramMutations';
import { NewProjectModal } from '@/features/shell/NewProjectModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { AddProjectToProgramModal } from './AddProjectToProgramModal';
import { RemoveFromProgramConfirmDialog } from './RemoveFromProgramConfirmDialog';
import { QueryErrorState } from '@/components/QueryErrorState';
import { ROLE_ADMIN } from '@/lib/roles';
import { fmtUtcShort } from '@/lib/formatUtcDate';

/**
 * /programs/:programId/projects — projects belonging to the program (ADR-0070).
 *
 * The Projects tab is the default landing surface for the shell (ProgramShell
 * sets up an index redirect). It's the most concrete signal of "what is this
 * program?" while Backlog is stubbed.
 */
export function ProgramProjectsPage() {
  const params = useParams<{ programId: string }>();
  const programId = params.programId;
  const navigate = useNavigate();
  const { data: program } = useProgram(programId);
  const { data: projects, isLoading, error, refetch } = useProgramProjects(programId);
  const removeProjectFromProgram = useAssignProjectToProgram();

  // Optional `?sort=` from a program-overview KPI drill-through (issue #2155):
  // land with the offending projects first. Unknown/absent → server order
  // (start_date, name). Null counts sort last (treated as -1).
  const [searchParams] = useSearchParams();
  const sort = searchParams.get('sort');
  const sortedProjects = useMemo(() => {
    if (!projects || (sort !== 'at-risk' && sort !== 'overdue')) return projects;
    const key = sort === 'at-risk' ? 'atRiskCount' : 'overdueCount';
    // Stable descending sort — ties keep the server's start_date/name order.
    return [...projects].sort((a, b) => (b[key] ?? -1) - (a[key] ?? -1));
  }, [projects, sort]);

  const [showAddExistingModal, setShowAddExistingModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The project queued for the remove-from-program confirm (null = dialog closed).
  // Kept as {id,name} rather than just the id so the confirm copy can name the
  // project even after the list re-renders.
  const [pendingRemoval, setPendingRemoval] = useState<{ id: string; name: string } | null>(null);

  if (!programId) return null;

  // my_role is a Role ordinal (VIEWER=0 … OWNER=400), not a 0–4 index — a bare
  // `>= 3` exposed admin add/remove affordances to Members/Schedulers. Gate on
  // the ROLE_ADMIN ordinal (300) to match the sibling settings page.
  const isAdmin = program ? (program.my_role ?? -1) >= ROLE_ADMIN : false;

  // The unassign PATCH is only fired after the confirm dialog is accepted
  // (#2176). Removing a project drops it from the program's shared backlog,
  // rollup, and combined schedule — a consequence the user must acknowledge
  // first (delete-safety rule 266 / #2029/#2054).
  async function handleConfirmRemove(): Promise<void> {
    if (!pendingRemoval) return;
    setRemoveError(null);
    try {
      await removeProjectFromProgram.mutateAsync({ projectId: pendingRemoval.id, programId: null });
      setPendingRemoval(null);
    } catch (err) {
      setPendingRemoval(null);
      setRemoveError(
        err instanceof Error && err.message ? err.message : 'Failed to remove project.',
      );
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-text-primary">
            Projects
            {projects && (
              <span className="tppm-mono ml-2 text-xs font-normal text-neutral-text-secondary">
                {projects.length}
              </span>
            )}
          </h2>
          {/* The program's single headline target finish date (issue 560). Read-only
              here; ADMIN+ sets it on Program → Settings → General. */}
          {program?.target_date && (
            <p className="tppm-mono mt-0.5 text-xs text-neutral-text-secondary">
              Target {fmtUtcShort(program.target_date)}
            </p>
          )}
        </div>
        {isAdmin && (
          <div
            role="toolbar"
            aria-label="Program projects actions"
            className="flex items-center gap-2"
          >
            <button
              type="button"
              onClick={() => setShowAddExistingModal(true)}
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Add existing
            </button>
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => setShowNewProjectModal(true)}
              className="h-9 rounded-control bg-brand-primary px-3 text-xs font-medium text-neutral-text-inverse
                hover:bg-brand-primary/90
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              New project
            </button>
          </div>
        )}
      </div>

      {/* Onboarding hint — second of three placements (ADR-0070 §Risks). */}
      <p className="mb-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-3 text-xs text-neutral-text-secondary">
        <span aria-hidden="true">ⓘ </span>
        These projects belong to the program. Their member lists are managed separately on each
        project.
      </p>

      {removeError && (
        <p role="alert" className="mb-3 text-xs text-semantic-critical">
          {removeError}
        </p>
      )}

      {isLoading && (
        <div aria-label="Loading projects" className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              aria-hidden="true"
              className="h-14 motion-safe:animate-pulse rounded-card border border-neutral-border bg-neutral-surface-raised"
            />
          ))}
        </div>
      )}

      {error && (
        <QueryErrorState
          variant="inline"
          message="Couldn't load this program's projects."
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !error && projects && projects.length === 0 && (
        <div className="rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
          <p className="text-sm text-neutral-text-secondary">
            No projects in this program yet. Add an existing project, import one from MS Project, or
            create a new one and assign it here.
          </p>
          {isAdmin && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddExistingModal(true)}
                className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-4 text-xs font-medium text-neutral-text-primary
                  hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Add existing
              </button>
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                className="h-9 rounded-control border border-neutral-border bg-neutral-surface px-4 text-xs font-medium text-neutral-text-primary
                  hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowNewProjectModal(true)}
                className="h-9 rounded-control bg-brand-primary px-4 text-xs font-medium text-neutral-text-inverse
                  hover:bg-brand-primary/90
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                New project
              </button>
            </div>
          )}
        </div>
      )}

      {!isLoading && !error && sortedProjects && sortedProjects.length > 0 && (
        <ul
          aria-label="Projects in this program"
          className="divide-y divide-neutral-border rounded-card border border-neutral-border bg-neutral-surface"
        >
          {sortedProjects.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-neutral-surface-raised"
            >
              <Link
                to={`/projects/${p.id}/overview`}
                className="flex-1 truncate text-sm font-medium text-neutral-text-primary
                  hover:text-brand-primary
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                {p.name}
              </Link>
              <span className="tppm-mono shrink-0 text-xs text-neutral-text-secondary">
                {p.methodology}
              </span>
              {/* Standup-style rollup chips (issue 560) — only when the count is
                  non-zero. Color is paired with the word (rule 7/120); the
                  count stays mono (rule 8c). Outlined, AA-dark text variants
                  (rule 39/145). Informational — the row name carries the link. */}
              {(p.overdueCount ?? 0) > 0 && (
                <span
                  className="tppm-mono shrink-0 rounded-chip border border-semantic-critical/40 px-1.5 py-0.5 text-xs text-semantic-critical"
                  aria-label={`${p.overdueCount} overdue task${p.overdueCount === 1 ? '' : 's'}`}
                >
                  {p.overdueCount} overdue
                </span>
              )}
              {(p.atRiskCount ?? 0) > 0 && (
                <span
                  className="tppm-mono shrink-0 rounded-chip border border-semantic-at-risk/40 px-1.5 py-0.5 text-xs text-semantic-at-risk"
                  aria-label={`${p.atRiskCount} at-risk task${p.atRiskCount === 1 ? '' : 's'}`}
                >
                  {p.atRiskCount} at risk
                </span>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setPendingRemoval({ id: p.id, name: p.name })}
                  disabled={removeProjectFromProgram.isPending}
                  aria-label={`Remove ${p.name} from this program`}
                  className="h-8 rounded-control border border-neutral-border px-2 text-xs text-neutral-text-secondary
                    hover:bg-neutral-surface disabled:opacity-50
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {pendingRemoval && (
        <RemoveFromProgramConfirmDialog
          projectName={pendingRemoval.name}
          programName={program?.name ?? ''}
          isPending={removeProjectFromProgram.isPending}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => void handleConfirmRemove()}
        />
      )}

      {showAddExistingModal && (
        <AddProjectToProgramModal
          programId={programId}
          programName={program?.name ?? ''}
          onClose={() => setShowAddExistingModal(false)}
        />
      )}

      {showNewProjectModal && (
        <NewProjectModal
          programId={programId}
          programName={program?.name}
          onClose={() => setShowNewProjectModal(false)}
          onCreated={(newProjectId) => {
            setShowNewProjectModal(false);
            void navigate(`/projects/${newProjectId}/overview`);
          }}
        />
      )}

      {/* Import-a-project entry (#797) — the new project lands already assigned
          to this program; gated by program Admin both client- and server-side.
          Mirrors the Program Settings → Projects sibling page. */}
      {showImportModal && (
        <ImportProjectModal
          programId={programId}
          programName={program?.name}
          onClose={() => setShowImportModal(false)}
          onCreated={(newProjectId) => {
            setShowImportModal(false);
            void navigate(`/projects/${newProjectId}/overview`);
          }}
        />
      )}
    </div>
  );
}

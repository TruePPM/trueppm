import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useProgram } from '@/hooks/useProgram';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useAssignProjectToProgram } from '@/hooks/useProgramMutations';
import { NewProjectModal } from '@/features/shell/NewProjectModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { AddProjectToProgramModal } from './AddProjectToProgramModal';
import { ROLE_ADMIN } from '@/lib/roles';

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
  const { data: projects, isLoading, error } = useProgramProjects(programId);
  const removeProjectFromProgram = useAssignProjectToProgram();

  const [showAddExistingModal, setShowAddExistingModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  if (!programId) return null;

  // my_role is a Role ordinal (VIEWER=0 … OWNER=400), not a 0–4 index — a bare
  // `>= 3` exposed admin add/remove affordances to Members/Schedulers. Gate on
  // the ROLE_ADMIN ordinal (300) to match the sibling settings page.
  const isAdmin = program ? (program.my_role ?? -1) >= ROLE_ADMIN : false;

  async function handleRemove(projectId: string): Promise<void> {
    setRemoveError(null);
    try {
      await removeProjectFromProgram.mutateAsync({ projectId, programId: null });
    } catch (err) {
      setRemoveError(
        err instanceof Error && err.message ? err.message : 'Failed to remove project.',
      );
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-text-primary">
          Projects
          {projects && (
            <span className="tppm-mono ml-2 text-xs font-normal text-neutral-text-secondary">
              {projects.length}
            </span>
          )}
        </h2>
        {isAdmin && (
          <div
            role="toolbar"
            aria-label="Program projects actions"
            className="flex items-center gap-2"
          >
            <button
              type="button"
              onClick={() => setShowAddExistingModal(true)}
              className="h-9 rounded border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Add existing
            </button>
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              className="h-9 rounded border border-neutral-border bg-neutral-surface px-3 text-xs font-medium text-neutral-text-primary
                hover:bg-neutral-surface-raised
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Import
            </button>
            <button
              type="button"
              onClick={() => setShowNewProjectModal(true)}
              className="h-9 rounded bg-brand-primary px-3 text-xs font-medium text-white
                hover:bg-brand-primary/90
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              New project
            </button>
          </div>
        )}
      </div>

      {/* Onboarding hint — second of three placements (ADR-0070 §Risks). */}
      <p className="mb-4 rounded border border-neutral-border bg-neutral-surface-raised p-3 text-xs text-neutral-text-secondary">
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
              className="h-14 animate-pulse rounded border border-neutral-border bg-neutral-surface-raised"
            />
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-semantic-critical">
          Failed to load projects.
        </p>
      )}

      {!isLoading && !error && projects && projects.length === 0 && (
        <div className="rounded border border-neutral-border bg-neutral-surface-raised p-6 text-center">
          <p className="text-sm text-neutral-text-secondary">
            No projects in this program yet. Add an existing project, import one from MS Project, or
            create a new one and assign it here.
          </p>
          {isAdmin && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddExistingModal(true)}
                className="h-9 rounded border border-neutral-border bg-neutral-surface px-4 text-xs font-medium text-neutral-text-primary
                  hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Add existing
              </button>
              <button
                type="button"
                onClick={() => setShowImportModal(true)}
                className="h-9 rounded border border-neutral-border bg-neutral-surface px-4 text-xs font-medium text-neutral-text-primary
                  hover:bg-neutral-surface-raised
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowNewProjectModal(true)}
                className="h-9 rounded bg-brand-primary px-4 text-xs font-medium text-white
                  hover:bg-brand-primary/90
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                New project
              </button>
            </div>
          )}
        </div>
      )}

      {!isLoading && !error && projects && projects.length > 0 && (
        <ul
          aria-label="Projects in this program"
          className="divide-y divide-neutral-border rounded border border-neutral-border bg-neutral-surface"
        >
          {projects.map((p) => (
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
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => void handleRemove(p.id)}
                  disabled={removeProjectFromProgram.isPending}
                  aria-label={`Remove ${p.name} from this program`}
                  className="h-8 rounded border border-neutral-border px-2 text-xs text-neutral-text-secondary
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

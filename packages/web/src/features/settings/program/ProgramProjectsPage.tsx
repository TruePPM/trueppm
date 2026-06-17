import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { AddProjectToProgramModal } from '@/features/programs/AddProjectToProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { ROLE_ADMIN } from '@/lib/roles';

/** Program > Projects settings page — lists projects assigned to this program. */
export function ProgramProjectsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: projects, isLoading, error } = useProgramProjects(programId);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const navigate = useNavigate();

  if (!programId) return null;

  // Admin/Owner can manage program membership (ADR-0072 role ordinals).
  const isAdmin = (program?.my_role ?? -1) >= ROLE_ADMIN;
  const projectCount = projects?.length ?? 0;

  return (
    <div>
      <SettingsPageTitle
        title="Projects"
        count={!isLoading && !error ? `${projectCount} projects` : undefined}
        subtitle="Projects assigned to this program. Each project inherits the program methodology unless overridden."
        action={
          isAdmin ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowImport(true)}
                className="px-3 py-1.5 rounded border border-neutral-border text-neutral-text-secondary text-[13px] font-medium hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 rounded bg-brand-primary text-white text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                + Add project
              </button>
            </div>
          ) : undefined
        }
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {isLoading && (
          <div aria-label="Loading projects" className="space-y-2 mt-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className="h-12 animate-pulse rounded border border-neutral-border bg-neutral-surface-raised"
              />
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-semantic-critical">
            Failed to load projects.
          </p>
        )}

        {!isLoading && !error && projects && projects.length === 0 && (
          <div className="mt-4 rounded border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-sm text-neutral-text-secondary">
              No projects in this program yet.
              {isAdmin ? ' Use + Add project to assign one.' : ''}
            </p>
          </div>
        )}

        {!isLoading && !error && projects && projects.length > 0 && (
          <>
            <div
              className="grid items-center px-4 py-2 bg-neutral-surface-sunken border border-neutral-border rounded-t-lg text-[11px] font-semibold tracking-[.08em] uppercase text-neutral-text-secondary mt-4"
              style={{ gridTemplateColumns: '1fr 140px' }}
            >
              <span>Project</span>
              <span>Methodology</span>
            </div>

            <div className="bg-neutral-surface-raised border-x border-b border-neutral-border rounded-b-lg overflow-hidden">
              {projects.map((p, i) => (
                <div
                  key={p.id}
                  className={['grid items-center px-4 py-3 text-[13px]', i < projects.length - 1 ? 'border-b border-neutral-border/55' : ''].join(' ')}
                  style={{ gridTemplateColumns: '1fr 140px' }}
                >
                  <span className="font-medium text-neutral-text-primary truncate">{p.name}</span>
                  <span className="tppm-mono text-[12px] text-neutral-text-secondary">{p.methodology}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showAddModal && (
        <AddProjectToProgramModal
          programId={programId}
          programName={program?.name ?? ''}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* Import-a-project entry (#797) — the new project lands already assigned
          to this program, gated by program Admin both client- and server-side. */}
      {showImport && (
        <ImportProjectModal
          programId={programId}
          programName={program?.name}
          onClose={() => setShowImport(false)}
          onCreated={(projectId) => {
            setShowImport(false);
            void navigate(`/projects/${projectId}/overview`);
          }}
        />
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { useProgramProjects } from '@/hooks/useProgramProjects';
import { useBulkProjectFields } from '@/hooks/useBulkProjectFields';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { BulkFieldsMatrix, type FieldDescriptor } from '../components/BulkFieldsMatrix';
import { AddProjectToProgramModal } from '@/features/programs/AddProjectToProgramModal';
import { ImportProjectModal } from '@/components/import/ImportProjectModal';
import { ROLE_ADMIN } from '@/lib/roles';
import type { Project } from '@/types';

/** Program > Projects settings page — lists projects assigned to this program. */
export function ProgramProjectsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: projects, isLoading, error } = useProgramProjects(programId);
  const { data: ws } = useWorkspaceSettings();
  const bulkFields = useBulkProjectFields(programId);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const navigate = useNavigate();

  // Admin/Owner can manage program membership (ADR-0072 role ordinals).
  const isAdmin = (program?.my_role ?? -1) >= ROLE_ADMIN;

  // The two inherited fields the bulk-project-fields endpoint accepts. Methodology is
  // NOT a null-sentinel field (web-rule 196): it has no "reset to inherit" and is
  // dropped from the picker (display-only) under a workspace `inherit` lock.
  const methodologyLocked = ws?.methodologyOverridePolicy === 'inherit';
  const fields = useMemo<FieldDescriptor<Project>[]>(
    () => [
      {
        key: 'methodology',
        label: 'Methodology',
        kind: 'enum',
        options: [
          { value: 'AGILE', label: 'Agile' },
          { value: 'WATERFALL', label: 'Waterfall' },
          { value: 'HYBRID', label: 'Hybrid' },
        ],
        read: (p) => ({
          effective: p.effectiveMethodology ?? p.methodology,
          overridden: p.inheritedMethodology != null && p.methodology !== p.inheritedMethodology,
        }),
        resettable: false,
        locked: methodologyLocked,
      },
      {
        key: 'iteration_label',
        label: 'Iteration label',
        kind: 'string',
        maxLength: 32,
        read: (p) => ({
          effective: p.effectiveIterationLabel ?? null,
          overridden: p.iterationLabel != null,
        }),
        resettable: true,
      },
    ],
    [methodologyLocked],
  );

  if (!programId) return null;

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
                className="px-3 py-1.5 rounded-control border border-neutral-border text-neutral-text-secondary text-[13px] font-medium hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 rounded-control bg-brand-primary text-neutral-text-inverse text-[13px] font-medium hover:bg-brand-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
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
                className="h-12 motion-safe:animate-pulse rounded-card border border-neutral-border bg-neutral-surface-raised"
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
          <div className="mt-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-sm text-neutral-text-secondary">
              No projects in this program yet.
              {isAdmin ? ' Use + Add project to assign one.' : ''}
            </p>
          </div>
        )}

        {!isLoading && !error && projects && projects.length > 0 && (
          <div className="mt-4">
            <BulkFieldsMatrix
              rows={projects}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              rowNoun="Project"
              fields={fields}
              canEdit={isAdmin}
              apply={(ids, field, value) => bulkFields.mutateAsync({ ids, field, value })}
              isApplying={bulkFields.isPending}
              entityNoun="projects"
            />
          </div>
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

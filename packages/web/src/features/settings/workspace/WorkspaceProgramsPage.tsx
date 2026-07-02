import { useMemo } from 'react';
import { SettingsPageTitle } from '../SettingsShell';
import { usePrograms } from '@/hooks/usePrograms';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useBulkProgramFields } from '@/hooks/useBulkProgramFields';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { BulkFieldsMatrix, type FieldDescriptor } from '../components/BulkFieldsMatrix';
import type { Program } from '@/api/types';

// WorkspaceRole.ADMIN ordinal — the server gates POST /programs/bulk-fields/ at
// IsWorkspaceAdmin (>= ADMIN). This is a render-gate only; the server is authoritative.
const WORKSPACE_ADMIN_ROLE = 300;

/**
 * Workspace → Programs settings section (issue 1283, ADR-0161). The second mount of the
 * entity-agnostic {@link BulkFieldsMatrix}: a workspace admin selects programs and sets
 * one inherited/policy field across them in a single atomic call. Lives inline as a
 * `<SettingsSection id="programs">` on the consolidated workspace settings page (web-rule
 * 195) — it is an action surface, not a deferred dirty-save form.
 */
export function WorkspaceProgramsPage() {
  const { data: programs, isLoading, error } = usePrograms();
  const { data: ws } = useWorkspaceSettings();
  const { user } = useCurrentUser();
  const bulkFields = useBulkProgramFields();

  const isAdmin = (user?.workspace_role ?? -1) >= WORKSPACE_ADMIN_ROLE;

  // Methodology is NOT a null-sentinel field (web-rule 196): no "reset to inherit", and it
  // is dropped from the picker (display-only) under a workspace `inherit` lock. The two risk
  // fields are direct, non-inheritable program columns — always set, never resettable.
  const methodologyLocked = ws?.methodologyOverridePolicy === 'inherit';
  const fields = useMemo<FieldDescriptor<Program>[]>(
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
          effective: p.effective_methodology,
          overridden: p.methodology !== p.inherited_methodology,
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
          effective: p.iteration_label ?? p.inherited_iteration_label,
          overridden: p.iteration_label != null,
        }),
        resettable: true,
      },
      {
        key: 'risk_slip_propagation',
        label: 'Slip propagation',
        kind: 'enum',
        options: [
          { value: 'none', label: 'No action' },
          { value: 'warn', label: 'Warn only' },
          { value: 'block', label: 'Block & escalate' },
        ],
        read: (p) => ({ effective: p.risk_slip_propagation, overridden: false }),
        resettable: false,
      },
      {
        key: 'risk_escalation_days',
        label: 'Escalation days',
        kind: 'int',
        min: 1,
        max: 30,
        read: (p) => ({ effective: p.risk_escalation_days, overridden: false }),
        resettable: false,
      },
    ],
    [methodologyLocked],
  );

  const programCount = programs?.length ?? 0;

  return (
    <div>
      <SettingsPageTitle
        title="Programs"
        count={!isLoading && !error ? `${programCount} programs` : undefined}
        subtitle="Set the delivery methodology, iteration label, and cross-project risk policy across programs in one step. Each program inherits the workspace methodology unless overridden."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {isLoading && (
          <div aria-label="Loading programs" className="space-y-2 mt-4">
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
            Failed to load programs.
          </p>
        )}

        {!isLoading && !error && programs && programs.length === 0 && (
          <div className="mt-4 rounded-card border border-neutral-border bg-neutral-surface-raised p-6 text-center">
            <p className="text-sm text-neutral-text-secondary">No programs in this workspace yet.</p>
          </div>
        )}

        {!isLoading && !error && programs && programs.length > 0 && (
          <div className="mt-4">
            <BulkFieldsMatrix
              rows={programs}
              rowKey={(p) => p.id}
              rowLabel={(p) => p.name}
              rowNoun="Program"
              fields={fields}
              canEdit={isAdmin}
              apply={(ids, field, value) => bulkFields.mutateAsync({ ids, field, value })}
              isApplying={bulkFields.isPending}
              entityNoun="programs"
            />
          </div>
        )}
      </div>
    </div>
  );
}

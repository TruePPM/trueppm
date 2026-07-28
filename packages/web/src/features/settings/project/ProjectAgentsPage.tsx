import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';

/**
 * Project > Agents settings section (ADR-0678, issue 2482).
 *
 * The team's own consent switch over AI/MCP agent reads of this project's data.
 * `mcp_enabled` is null = no opinion (inherit), false = closed to agent reads.
 *
 * Two things make this control different from the other inheritable settings on
 * these pages, and both are deliberate:
 *
 *  1. **The cascade is restrictive-only.** Any scope may deny; no scope may grant
 *     over another's denial. So "Inherit (On)" genuinely means "nobody above us has
 *     objected", and turning this project off can never be undone from the program
 *     or workspace. That is the property that makes it consent rather than a
 *     suggestion — see the ADR.
 *  2. **The operator's instance-wide switch is shown as a separate fact**, never
 *     folded into this toggle. `effective_mcp_enabled` from the server deliberately
 *     excludes it, so this control always reflects the team's own decision — a
 *     toggle reading "off" for a reason the team cannot act on would be worse than
 *     no toggle.
 *
 * Writes are Admin+ server-side (the field is outside the serializer's
 * Scheduler-writable allowlist); the render gate here just spares a doomed save.
 */
export function ProjectAgentsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const { role } = useCurrentUserRole(projectId);

  // null = no opinion / inherit the program or workspace value (ADR-0678).
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);

  const seededProjectIdRef = useRef<string | null>(null);
  const [initialMcpEnabled, setInitialMcpEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    setMcpEnabled(project.mcp_enabled ?? null);
    setInitialMcpEnabled(project.mcp_enabled ?? null);
  }, [project]);

  const values = useMemo(() => ({ mcp_enabled: mcpEnabled }), [mcpEnabled]);
  const initialValues = useMemo(
    () => ({ mcp_enabled: initialMcpEnabled }),
    [initialMcpEnabled],
  );

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync({ mcp_enabled: mcpEnabled });
    setInitialMcpEnabled(mcpEnabled);
  }, [updateProject, mcpEnabled]);

  const handleReset = useCallback(() => {
    setMcpEnabled(initialMcpEnabled);
  }, [initialMcpEnabled]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project,
  });

  const canEdit = role !== null && role >= ROLE_ADMIN;

  // Resolved team-scope answer (workspace AND program AND project). Excludes the
  // operator's instance switch by design — see the component docstring.
  const effectiveEnabled = project?.effective_mcp_enabled ?? true;

  return (
    <div>
      <SettingsPageTitle
        title="Agents"
        subtitle="Whether AI agents connected over MCP may read this project's data. Inherits the program or workspace setting unless you override it here."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="Agent read access"
          hint="Allow AI agents using an MCP token to read this project's tasks, schedule, and sprints. Turning this off blocks those reads — it does not affect people."
          help={
            <FieldHelp
              label="Agent read access"
              body="Whether an AI agent connected over MCP may read this project's data. Turning it off blocks the read outright and records a refusal in the agent activity log — it is a block, not just an after-the-fact record. It never affects people: your team, and anyone signed in through the web or mobile app, are unaffected. Turning it off here cannot be reversed by a program or workspace administrator; only this project can re-enable it."
              docHref="administration/mcp-server/#team-level-opt-out"
            />
          }
        >
          <InheritableToggleField
            value={mcpEnabled}
            onChange={setMcpEnabled}
            inherited={project?.inherited_mcp_enabled ?? true}
            inheritFromLabel="the program or workspace default"
            scopeNoun="project"
            onLabel="Allowed"
            offLabel="Blocked"
            ariaLabel="Agent read access"
            canEdit={canEdit}
            overrideHint="Blocking here cannot be overridden from the program or workspace."
          />
        </FieldRow>

        {!effectiveEnabled && (
          <p
            className="mt-4 text-[13px] text-neutral-text-secondary"
            data-testid="agent-access-blocked-note"
          >
            Agent reads of this project are blocked. MCP tools return a refusal for this
            project&apos;s data, and each refusal is recorded in the project&apos;s agent
            activity log.
          </p>
        )}
      </div>
    </div>
  );
}

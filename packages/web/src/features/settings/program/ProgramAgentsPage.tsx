import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { ROLE_ADMIN } from '@/lib/roles';
import { useProgramId } from '@/hooks/useProgramId';

/**
 * Program > Agents settings section (ADR-0678, issues 2700 / 2716).
 *
 * One scope up from {@link ProjectAgentsPage}: `mcp_enabled` null = no opinion
 * (inherit the workspace value), false = closed to agent reads for this program
 * and every project under it. The cascade is restrictive-only, so:
 *
 *  - "Allowed" here never overrides a workspace that is Blocked — when the
 *    inherited value is Off the page says so plainly instead of letting the
 *    switch imply it could re-enable agent reads.
 *  - A program-level Block cannot be undone from the workspace.
 *
 * The resolved values (`inherited_mcp_enabled`, `effective_mcp_enabled`) come
 * from the server; the precedence is never recomputed client-side (ADR-0108).
 * Writes are program Admin+ and the program must be open (IsProgramNotClosed).
 */
export function ProgramAgentsPage() {
  const programId = useProgramId();
  const { data: program } = useProgram(programId);
  const updateProgram = useUpdateProgram();

  // null = no opinion / inherit the workspace value (ADR-0678).
  const [mcpEnabled, setMcpEnabled] = useState<boolean | null>(null);
  const seededProgramIdRef = useRef<string | null>(null);
  const [initialMcpEnabled, setInitialMcpEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!program || seededProgramIdRef.current === program.id) return;
    seededProgramIdRef.current = program.id;
    setMcpEnabled(program.mcp_enabled ?? null);
    setInitialMcpEnabled(program.mcp_enabled ?? null);
  }, [program]);

  const values = useMemo(() => ({ mcp_enabled: mcpEnabled }), [mcpEnabled]);
  const initialValues = useMemo(() => ({ mcp_enabled: initialMcpEnabled }), [initialMcpEnabled]);

  const handleSave = useCallback(async () => {
    if (!programId) return;
    await updateProgram.mutateAsync({ programId, patch: { mcp_enabled: mcpEnabled } });
    setInitialMcpEnabled(mcpEnabled);
  }, [updateProgram, programId, mcpEnabled]);

  const handleReset = useCallback(() => setMcpEnabled(initialMcpEnabled), [initialMcpEnabled]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!program,
  });

  // Gate pessimistically (read-only until proven Admin) and fold in `!is_closed`
  // (#2549): the write goes through ProgramViewSet.update, which refuses a closed
  // program, so an Admin there would otherwise see a live toggle that 403s.
  const isAdmin = program?.my_role != null && program.my_role >= ROLE_ADMIN;
  const canEdit = isAdmin && !program?.is_closed;

  const inherited = program?.inherited_mcp_enabled ?? true;
  const effectiveEnabled = program?.effective_mcp_enabled ?? true;
  // The workspace has blocked agents and this program has not itself said so: an
  // "Allowed" override here would read as a grant it cannot make.
  const blockedAbove = !inherited && mcpEnabled !== false;

  return (
    <div>
      <SettingsPageTitle
        title="Agents"
        subtitle="Whether AI agents connected over MCP may read this program's data and its projects'. Inherits the workspace setting unless you override it here."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="Agent read access"
          hint="Allow AI agents using an MCP token to read this program and its projects. Turning this off blocks those reads — it does not affect people."
          help={
            <FieldHelp
              label="Agent read access"
              body="Whether an AI agent connected over MCP may read this program's data. Turning it off blocks the read outright for the program and every project in it, and records a refusal in the agent activity log. It never affects people. Turning it off here cannot be reversed by the workspace; and choosing Allowed here cannot re-enable agent reads that the workspace has blocked."
              docHref="administration/mcp-server/#team-level-opt-out"
            />
          }
        >
          <InheritableToggleField
            value={mcpEnabled}
            onChange={setMcpEnabled}
            inherited={inherited}
            inheritFromLabel="the workspace default"
            scopeNoun="program"
            onLabel="Allowed"
            offLabel="Blocked"
            ariaLabel="Agent read access"
            canEdit={canEdit}
            overrideHint="Blocking here cannot be overridden from the workspace."
          />
        </FieldRow>

        {blockedAbove && (
          <p
            className="mt-4 text-[13px] text-neutral-text-secondary"
            data-testid="agent-access-blocked-above-note"
          >
            Agent reads are blocked at the workspace level, so they stay blocked for this program
            and its projects whatever you choose here
            {mcpEnabled === true
              ? ' — Allowed here has no effect while the workspace blocks agents'
              : ''}
            . Only a workspace administrator can lift it.
          </p>
        )}
        {!effectiveEnabled && mcpEnabled === true && (
          <p
            className="mt-2 text-[13px] font-medium text-neutral-text-primary"
            data-testid="agent-access-effective"
          >
            Effective: Blocked
          </p>
        )}
        {!effectiveEnabled && !blockedAbove && (
          <p
            className="mt-4 text-[13px] text-neutral-text-secondary"
            data-testid="agent-access-blocked-note"
          >
            Agent reads of this program and its projects are blocked. MCP tools return a refusal for
            their data.
          </p>
        )}
      </div>
    </div>
  );
}

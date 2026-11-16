import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { QueryErrorState } from '@/components/QueryErrorState';
import { Toggle } from '../components/Toggle';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';

/**
 * Workspace > Agents settings section (ADR-0678, issues 2700 / 2716).
 *
 * The workspace is the non-null ROOT of the agent-read consent cascade, so there
 * is no Inherit state here: `mcp_enabled` is a plain two-state switch (default
 * Allowed). Turning it off closes agent reads for every program and project in
 * the workspace, and — because the cascade is restrictive-only — no program or
 * project can re-enable them. Turning it on grants nothing over a program's or
 * project's own denial. The page says both, so the AND is legible rather than
 * surprising. The operator's instance-wide switch is a separate fact and is not
 * folded into this toggle.
 *
 * Writes are workspace Admin+ server-side; this section already sits behind the
 * workspace-admin settings gate.
 */
export function WorkspaceAgentsPage() {
  const { data: ws, isLoading, isError, error, refetch } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();

  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [initialMcpEnabled, setInitialMcpEnabled] = useState(true);

  // Follow the server whenever the form is clean, so a refetch that carries another
  // admin's change is not hidden; never overwrite a dirty, unsaved toggle. The latest
  // local values live in a ref so this effect re-runs only when the server data changes
  // (re-running after our own save would reseed from the not-yet-refetched value).
  const localRef = useRef({ mcpEnabled, initialMcpEnabled });
  useEffect(() => {
    localRef.current = { mcpEnabled, initialMcpEnabled };
  });
  useEffect(() => {
    if (!ws) return;
    const { mcpEnabled: cur, initialMcpEnabled: init } = localRef.current;
    if (cur !== init) return;
    setMcpEnabled(ws.mcpEnabled);
    setInitialMcpEnabled(ws.mcpEnabled);
  }, [ws]);

  const values = useMemo(() => ({ mcp_enabled: mcpEnabled }), [mcpEnabled]);
  const initialValues = useMemo(() => ({ mcp_enabled: initialMcpEnabled }), [initialMcpEnabled]);

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({ mcpEnabled });
    setInitialMcpEnabled(mcpEnabled);
  }, [updateSettings, mcpEnabled]);

  const onReset = useCallback(() => setMcpEnabled(initialMcpEnabled), [initialMcpEnabled]);

  useDirtyForm({ values, initialValues, onSave, onReset, apiReady: !!ws });

  // A failed GET must read as broken, not as a stuck skeleton (rule 246, #3542).
  if (isError) {
    return (
      <div>
        <SettingsPageTitle title="Agents" />
        <div className="px-6 py-8">
          <QueryErrorState
            variant="inline"
            message="Couldn't load agent settings."
            error={error}
            onRetry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8">
        <div className="h-16 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Agents"
        subtitle="Whether AI agents connected over MCP may read this workspace's data. Programs and projects can block agent reads for themselves, but cannot re-enable them if you block them here."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="Agent read access"
          hint="Allow AI agents using an MCP token to read tasks, schedules, and sprints in this workspace. Turning this off blocks those reads everywhere — it does not affect people."
          help={
            <FieldHelp
              label="Agent read access"
              body="Whether an AI agent connected over MCP may read this workspace's data. Turning it off blocks the read outright for every program and project, and records a refusal in the agent activity log. It never affects people. Turning it on does not override a program or project that has blocked agents for itself — any scope may block, and none may re-enable what another has blocked."
              docHref="administration/mcp-server/#team-level-opt-out"
            />
          }
        >
          <Toggle
            on={mcpEnabled}
            onChange={setMcpEnabled}
            onLabel="Allowed"
            offLabel="Blocked"
            ariaLabel="Agent read access"
          />
        </FieldRow>

        <p
          className="mt-4 text-[13px] text-neutral-text-secondary"
          data-testid="agent-access-workspace-note"
        >
          {mcpEnabled
            ? 'Agent reads are allowed at the workspace level. Each program and project can still block agent reads for itself.'
            : 'Agent reads are blocked for every program and project in this workspace. Programs and projects cannot re-enable them.'}
        </p>
      </div>
    </div>
  );
}

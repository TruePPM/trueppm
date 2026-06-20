import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { Toggle } from '../components/Toggle';
import { AttachmentTypesChecklist } from '../components/AttachmentTypesChecklist';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useWorkspaceSettings } from '../hooks/useWorkspaceSettings';
import { useUpdateWorkspaceSettings } from '../hooks/useUpdateWorkspaceSettings';
import { ATTACHMENT_TYPE_CATALOG, DENIED_ATTACHMENT_TYPES } from '@/lib/attachmentTypes';

/**
 * Workspace > Attachments settings section (ADR-0153, issue 976).
 *
 * The workspace is the non-null ROOT of the Workspace → Program → Project
 * attachment-policy chain, so the controls are plain (no inherit affordance):
 * `attachments_enabled` is a bare switch and `allowed_attachment_types` is a bare
 * checklist. Programs and projects inherit these unless they override. The
 * empty-allowlist note warns when uploads are on but no type is allowed — a
 * state in which no file could be uploaded anywhere that inherits this policy.
 */
export function WorkspaceAttachmentsPage() {
  const { data: ws, isLoading } = useWorkspaceSettings();
  const updateSettings = useUpdateWorkspaceSettings();

  const [attachmentsEnabled, setAttachmentsEnabled] = useState(true);
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);

  const [initial, setInitial] = useState<{ enabled: boolean; types: string[] }>({
    enabled: true,
    types: [],
  });

  // Seed once the query resolves (or re-resolves after a save).
  useEffect(() => {
    if (!ws) return;
    const snap = { enabled: ws.attachmentsEnabled, types: ws.allowedAttachmentTypes };
    setAttachmentsEnabled(snap.enabled);
    setAllowedTypes(snap.types);
    setInitial(snap);
  }, [ws]);

  const values = useMemo(
    () => ({ enabled: attachmentsEnabled, types: allowedTypes }),
    [attachmentsEnabled, allowedTypes],
  );

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({
      attachmentsEnabled,
      allowedAttachmentTypes: allowedTypes,
    });
    setInitial({ enabled: attachmentsEnabled, types: allowedTypes });
  }, [updateSettings, attachmentsEnabled, allowedTypes]);

  const onReset = useCallback(() => {
    setAttachmentsEnabled(initial.enabled);
    setAllowedTypes(initial.types);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: !!ws });

  const showEmptyAllowlistWarning = attachmentsEnabled && allowedTypes.length === 0;

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-16 rounded bg-neutral-surface-raised animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="Attachments"
        subtitle="Whether task file uploads are allowed and which file types, across the workspace. Programs and projects inherit this unless they override it. External links are always allowed."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="File attachments"
          hint="Allow uploading files to tasks. Turning this off keeps existing files but hides the upload controls."
        >
          <Toggle
            on={attachmentsEnabled}
            onChange={setAttachmentsEnabled}
            onLabel="On"
            offLabel="Off"
            ariaLabel="Allow file attachments"
          />
        </FieldRow>

        <FieldRow
          label="Allowed file types"
          hint="The file types contributors may upload. A few are permanently disallowed for security."
        >
          <div className="flex flex-col gap-3">
            <AttachmentTypesChecklist
              value={allowedTypes}
              onChange={setAllowedTypes}
              groups={ATTACHMENT_TYPE_CATALOG}
              deniedTypes={DENIED_ATTACHMENT_TYPES}
            />
            {showEmptyAllowlistWarning && (
              <p
                role="note"
                className="text-[12px] text-semantic-at-risk bg-semantic-at-risk-bg border border-semantic-at-risk/30 rounded px-3 py-2"
              >
                No types allowed — attachments are on, but no file can be uploaded.
              </p>
            )}
          </div>
        </FieldRow>
      </div>
    </div>
  );
}

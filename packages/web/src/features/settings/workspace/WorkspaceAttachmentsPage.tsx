import { useCallback, useEffect, useMemo, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { Toggle } from '../components/Toggle';
import { EnterpriseBadge } from '../components/EnterpriseBadge';
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
  const [policy, setPolicy] = useState<'inherit' | 'suggest' | 'enforce'>('suggest');

  const [initial, setInitial] = useState<{
    enabled: boolean;
    types: string[];
    policy: 'inherit' | 'suggest' | 'enforce';
  }>({
    enabled: true,
    types: [],
    policy: 'suggest',
  });

  // Seed once the query resolves (or re-resolves after a save).
  useEffect(() => {
    if (!ws) return;
    const snap = {
      enabled: ws.attachmentsEnabled,
      types: ws.allowedAttachmentTypes,
      policy: ws.attachmentsOverridePolicy,
    };
    setAttachmentsEnabled(snap.enabled);
    setAllowedTypes(snap.types);
    setPolicy(snap.policy);
    setInitial(snap);
  }, [ws]);

  const values = useMemo(
    () => ({ enabled: attachmentsEnabled, types: allowedTypes, policy }),
    [attachmentsEnabled, allowedTypes, policy],
  );

  const onSave = useCallback(async () => {
    await updateSettings.mutateAsync({
      attachmentsEnabled,
      allowedAttachmentTypes: allowedTypes,
      attachmentsOverridePolicy: policy,
    });
    setInitial({ enabled: attachmentsEnabled, types: allowedTypes, policy });
  }, [updateSettings, attachmentsEnabled, allowedTypes, policy]);

  const onReset = useCallback(() => {
    setAttachmentsEnabled(initial.enabled);
    setAllowedTypes(initial.types);
    setPolicy(initial.policy);
  }, [initial]);

  useDirtyForm({ values, initialValues: initial, onSave, onReset, apiReady: !!ws });

  const showEmptyAllowlistWarning = attachmentsEnabled && allowedTypes.length === 0;

  if (isLoading || !ws) {
    return (
      <div className="px-6 py-8 space-y-3">
        {[1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-card bg-neutral-surface-raised motion-safe:animate-pulse"
          />
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
          help={
            <FieldHelp
              label="File attachments"
              body="Whether contributors may upload files to tasks across the workspace. Turning it off keeps existing files but hides the upload controls everywhere. External links are always allowed. Programs and projects inherit this unless they override it."
              docHref="administration/attachment-policy/"
            />
          }
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
          help={
            <FieldHelp
              label="Allowed file types"
              body="The file types contributors may upload. A short list of executable and script types is permanently blocked for security and can't be enabled. Programs and projects inherit this allowlist unless they narrow it."
              docHref="administration/attachment-policy/"
            />
          }
        >
          <div className="flex flex-col gap-3">
            <AttachmentTypesChecklist
              value={allowedTypes}
              onChange={setAllowedTypes}
              groups={ATTACHMENT_TYPE_CATALOG}
              deniedTypes={DENIED_ATTACHMENT_TYPES}
              ariaLabel="Allowed file types"
            />
            {showEmptyAllowlistWarning && (
              <p
                role="note"
                className="text-[12px] text-semantic-at-risk bg-semantic-at-risk-bg border border-semantic-at-risk/30 rounded-card px-3 py-2"
              >
                No types allowed — attachments are on, but no file can be uploaded.
              </p>
            )}
          </div>
        </FieldRow>

        <FieldRow
          label="Programs &amp; projects"
          hint="Whether programs and projects may override this attachment policy."
          help={
            <FieldHelp
              label="Attachment overrides"
              body="Whether programs and projects may narrow or widen this attachment policy, or must follow the workspace setting. Enforcing it workspace-wide requires TruePPM Enterprise."
              docHref="administration/attachment-policy/"
            />
          }
        >
          {/* Cascade policy (ADR-0153, #976 / #2014). Mirrors the sibling
              TermOverridePolicy controls (methodology, forecast history): OSS
              exposes "may override" (suggest) vs the Enterprise ENFORCE lock.
              INHERIT and SUGGEST are honored identically in OSS, so a stored
              `inherit` reads as "may override" and heals to `suggest` on save. */}
          <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0">
            <legend className="sr-only">Attachment override policy</legend>
            <label className="flex items-center gap-2 text-[13px] text-neutral-text-primary cursor-pointer">
              <input
                type="radio"
                name="attachments-policy"
                checked={policy !== 'enforce'}
                onChange={() => setPolicy('suggest')}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              />{' '}
              May narrow or widen these types
            </label>
            {/* ENFORCE pins the workspace policy so lower scopes cannot override —
                an Enterprise capability (ADR-0153). Disabled on the OSS surface;
                the EnterpriseBadge (community-only) is the reachable upsell link.
                OSS stores the value but never enforces the lock downstream. */}
            <span className="inline-flex items-center gap-1.5">
              <label className="flex items-center gap-2 text-[13px] text-neutral-text-disabled cursor-not-allowed">
                <input
                  type="radio"
                  name="attachments-policy"
                  checked={policy === 'enforce'}
                  disabled
                  readOnly
                  // A disabled radio conveys only "unavailable" to a screen reader;
                  // the visual EnterpriseBadge doesn't reach non-visual users, so the
                  // reason is spelled out via an sr-only span (web-rule 265 / #2001).
                  aria-describedby="attachments-enforce-enterprise-hint"
                  className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
                />{' '}
                Enforce attachments workspace-wide
              </label>
              <EnterpriseBadge />
              <span id="attachments-enforce-enterprise-hint" className="sr-only">
                Enforcing attachments workspace-wide requires TruePPM Enterprise.
              </span>
            </span>
          </fieldset>
        </FieldRow>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { FieldHelp } from '@/components/FieldHelp';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { InheritableMultiSelectField } from '../components/InheritableMultiSelectField';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProjectId } from '@/hooks/useProjectId';
import { useProject } from '@/hooks/useProject';
import { useUpdateProject } from '@/hooks/useProjectMutations';
import { useCurrentUserRole } from '@/hooks/useCurrentUserRole';
import { ROLE_ADMIN } from '@/lib/roles';
import { ATTACHMENT_TYPE_CATALOG, DENIED_ATTACHMENT_TYPES } from '@/lib/attachmentTypes';

/**
 * Project > Attachments settings section (ADR-0153, issue 976).
 *
 * Both controls inherit the program/workspace value unless this project
 * overrides. `attachments_enabled` is null = inherit; `allowed_attachment_types`
 * is tri-state (null = inherit, [] = explicit empty, [...] = explicit set). The
 * empty-allowlist note warns when uploads are on but the resolved set is empty —
 * a state where no file could ever be uploaded.
 *
 * State commits through the same single PATCH as the rest of the project's
 * settings via `useDirtyForm`; the server is authoritative (writes are Admin+,
 * the denylist is rejected) — the Admin render-gate just spares a doomed save.
 */
export function ProjectAttachmentsPage() {
  const projectId = useProjectId();
  const { data: project } = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const { role } = useCurrentUserRole(projectId);

  // null = inherit the program/workspace value (ADR-0153).
  const [attachmentsEnabled, setAttachmentsEnabled] = useState<boolean | null>(null);
  // tri-state: null = inherit, [] = explicit empty, [...] = explicit set.
  const [allowedTypes, setAllowedTypes] = useState<string[] | null>(null);

  const seededProjectIdRef = useRef<string | null>(null);
  const [initialEnabled, setInitialEnabled] = useState<boolean | null>(null);
  const [initialTypes, setInitialTypes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!project || seededProjectIdRef.current === project.id) return;
    seededProjectIdRef.current = project.id;
    setAttachmentsEnabled(project.attachments_enabled ?? null);
    setAllowedTypes(project.allowed_attachment_types ?? null);
    setInitialEnabled(project.attachments_enabled ?? null);
    setInitialTypes(project.allowed_attachment_types ?? null);
  }, [project]);

  const values = useMemo(
    () => ({ attachments_enabled: attachmentsEnabled, allowed_attachment_types: allowedTypes }),
    [attachmentsEnabled, allowedTypes],
  );
  const initialValues = useMemo(
    () => ({ attachments_enabled: initialEnabled, allowed_attachment_types: initialTypes }),
    [initialEnabled, initialTypes],
  );

  const handleSave = useCallback(async () => {
    await updateProject.mutateAsync({
      attachments_enabled: attachmentsEnabled,
      allowed_attachment_types: allowedTypes,
    });
    setInitialEnabled(attachmentsEnabled);
    setInitialTypes(allowedTypes);
  }, [updateProject, attachmentsEnabled, allowedTypes]);

  const handleReset = useCallback(() => {
    setAttachmentsEnabled(initialEnabled);
    setAllowedTypes(initialTypes);
  }, [initialEnabled, initialTypes]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!project,
  });

  // Admin+ may edit; reads are open. Gate pessimistically while the role loads
  // (mirrors ProjectGeneralPage's sharing/forecast gate, ADR-0133).
  const canEdit = role !== null && role >= ROLE_ADMIN;

  // The empty-allowlist warning keys off the RESOLVED effective policy, so it
  // fires whether the empty set is the project's own override or inherited.
  const effectiveEnabled = project?.effective_attachments_enabled ?? true;
  const effectiveTypes = project?.effective_allowed_attachment_types ?? [];
  const showEmptyAllowlistWarning = effectiveEnabled && effectiveTypes.length === 0;

  return (
    <div>
      <SettingsPageTitle
        title="Attachments"
        subtitle="Whether task file uploads are allowed and which file types. Inherits the program or workspace policy unless you override it here. External links are always allowed."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        {/* This page has no StubFieldset (the Inheritable* controls render their own
            read-only view below Admin), so the ⓘ stays clickable for every role —
            it is not gated on canEdit the way the StubFieldset-wrapped pages are. */}
        <FieldRow
          label="File attachments"
          hint="Allow uploading files to tasks in this project. Turning this off keeps existing files but hides the upload controls."
          help={
            <FieldHelp
              label="File attachments"
              body="Whether contributors can upload files to tasks in this project. Turning it off keeps existing files but hides the upload controls, and external links are always allowed either way. Inherits the program or workspace policy unless you override it here."
              docHref="administration/attachment-policy/#the-two-attachment-settings"
            />
          }
        >
          <InheritableToggleField
            value={attachmentsEnabled}
            onChange={setAttachmentsEnabled}
            inherited={project?.inherited_attachments_enabled ?? true}
            inheritFromLabel="the program or workspace default"
            scopeNoun="project"
            onLabel="On"
            offLabel="Off"
            ariaLabel="Allow file attachments"
            canEdit={canEdit}
          />
        </FieldRow>

        <FieldRow
          label="Allowed file types"
          hint="The file types contributors may upload. A few are permanently disallowed for security."
          help={
            <FieldHelp
              label="Allowed file types"
              body="The set of file types contributors may attach to tasks. Leave it inheriting to follow the program or workspace allowlist, or override it to a narrower set here. A few executable and script types are permanently blocked for security and can never be added. If the resolved list is empty while attachments are on, no file can be uploaded."
              docHref="administration/attachment-policy/#permanently-blocked-types-security-denylist"
            />
          }
        >
          <div className="flex flex-col gap-3">
            <InheritableMultiSelectField
              value={allowedTypes}
              onChange={setAllowedTypes}
              inherited={project?.inherited_allowed_attachment_types ?? []}
              inheritFromLabel="the program or workspace default"
              ariaLabel="Allowed attachment file types"
              scopeNoun="project"
              canEdit={canEdit}
              groups={ATTACHMENT_TYPE_CATALOG}
              deniedTypes={DENIED_ATTACHMENT_TYPES}
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
      </div>
    </div>
  );
}

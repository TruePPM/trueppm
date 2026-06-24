import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle, FieldRow } from '../SettingsShell';
import { InheritableToggleField } from '../components/InheritableToggleField';
import { InheritableMultiSelectField } from '../components/InheritableMultiSelectField';
import { useDirtyForm } from '../hooks/useDirtyForm';
import { useProgram } from '@/hooks/useProgram';
import { useUpdateProgram } from '@/hooks/useProgramMutations';
import { ROLE_ADMIN } from '@/lib/roles';
import { ATTACHMENT_TYPE_CATALOG, DENIED_ATTACHMENT_TYPES } from '@/lib/attachmentTypes';

/**
 * Program > Attachments settings section (ADR-0153, issue 976).
 *
 * Mirrors {@link ProjectAttachmentsPage} one scope up: both controls inherit the
 * workspace value unless this program overrides. The override cascades to the
 * program's projects (which may in turn override again). Writes are Admin+ on the
 * program; the server is authoritative.
 */
export function ProgramAttachmentsPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const updateProgram = useUpdateProgram();

  // null = inherit the workspace value (ADR-0153).
  const [attachmentsEnabled, setAttachmentsEnabled] = useState<boolean | null>(null);
  // tri-state: null = inherit, [] = explicit empty, [...] = explicit set.
  const [allowedTypes, setAllowedTypes] = useState<string[] | null>(null);

  const seededProgramIdRef = useRef<string | null>(null);
  const [initialEnabled, setInitialEnabled] = useState<boolean | null>(null);
  const [initialTypes, setInitialTypes] = useState<string[] | null>(null);

  useEffect(() => {
    if (!program || seededProgramIdRef.current === program.id) return;
    seededProgramIdRef.current = program.id;
    setAttachmentsEnabled(program.attachments_enabled ?? null);
    setAllowedTypes(program.allowed_attachment_types ?? null);
    setInitialEnabled(program.attachments_enabled ?? null);
    setInitialTypes(program.allowed_attachment_types ?? null);
  }, [program]);

  const values = useMemo(
    () => ({ attachments_enabled: attachmentsEnabled, allowed_attachment_types: allowedTypes }),
    [attachmentsEnabled, allowedTypes],
  );
  const initialValues = useMemo(
    () => ({ attachments_enabled: initialEnabled, allowed_attachment_types: initialTypes }),
    [initialEnabled, initialTypes],
  );

  const handleSave = useCallback(async () => {
    if (!programId) return;
    await updateProgram.mutateAsync({
      programId,
      patch: {
        attachments_enabled: attachmentsEnabled,
        allowed_attachment_types: allowedTypes,
      },
    });
    setInitialEnabled(attachmentsEnabled);
    setInitialTypes(allowedTypes);
  }, [updateProgram, programId, attachmentsEnabled, allowedTypes]);

  const handleReset = useCallback(() => {
    setAttachmentsEnabled(initialEnabled);
    setAllowedTypes(initialTypes);
  }, [initialEnabled, initialTypes]);

  useDirtyForm({
    values,
    initialValues,
    onSave: handleSave,
    onReset: handleReset,
    apiReady: !!program,
  });

  // Admin+ on the program may edit. `my_role` is null until the program loads,
  // so gate pessimistically (read-only until proven Admin).
  const canEdit = program?.my_role != null && program.my_role >= ROLE_ADMIN;

  const effectiveEnabled = program?.effective_attachments_enabled ?? true;
  const effectiveTypes = program?.effective_allowed_attachment_types ?? [];
  const showEmptyAllowlistWarning = effectiveEnabled && effectiveTypes.length === 0;

  return (
    <div>
      <SettingsPageTitle
        title="Attachments"
        subtitle="Whether task file uploads are allowed and which file types, for this program's projects. Inherits the workspace policy unless you override it here. External links are always allowed."
      />

      <div className="px-6 pb-8 max-w-[720px]">
        <FieldRow
          label="File attachments"
          hint="Allow uploading files to tasks across this program. Projects can override this. Turning it off keeps existing files but hides the upload controls."
        >
          <InheritableToggleField
            value={attachmentsEnabled}
            onChange={setAttachmentsEnabled}
            inherited={program?.inherited_attachments_enabled ?? true}
            inheritFromLabel="the workspace default"
            scopeNoun="program"
            onLabel="On"
            offLabel="Off"
            ariaLabel="Allow file attachments"
            canEdit={canEdit}
          />
        </FieldRow>

        <FieldRow
          label="Allowed file types"
          hint="The file types contributors may upload. A few are permanently disallowed for security."
        >
          <div className="flex flex-col gap-3">
            <InheritableMultiSelectField
              value={allowedTypes}
              onChange={setAllowedTypes}
              inherited={program?.inherited_allowed_attachment_types ?? []}
              inheritFromLabel="the workspace default"
              ariaLabel="Allowed attachment file types"
              scopeNoun="program"
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

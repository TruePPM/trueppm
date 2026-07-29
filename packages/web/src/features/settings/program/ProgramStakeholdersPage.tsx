import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN } from '@/lib/roles';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import {
  useProgramExternalStakeholders,
  useProgramExternalStakeholderMutations,
  type ExternalStakeholder,
} from '../hooks/useProgramExternalStakeholders';
import {
  StakeholderEditRow,
  STAKEHOLDER_GRID as GRID,
  type StakeholderDraft,
  type StakeholderFieldErrors,
} from './StakeholderEditRow';

interface RowProps {
  stakeholder: ExternalStakeholder;
  canManage: boolean;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  isBusy: boolean;
  /** This row's edit form just closed — pull focus back to the button that opened it. */
  restoreFocus: boolean;
  onFocusRestored: () => void;
}

function StakeholderRow({
  stakeholder,
  canManage,
  onRemove,
  onEdit,
  isBusy,
  restoreFocus,
  onFocusRestored,
}: RowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);

  // Save/Cancel unmounted the form the user was in, dropping focus to <body>
  // (rules 224/288). The trigger only exists again now, so the restore has to
  // happen here rather than in the close handler.
  useEffect(() => {
    if (!restoreFocus) return;
    editRef.current?.focus();
    onFocusRestored();
  }, [restoreFocus, onFocusRestored]);

  return (
    <div
      className="grid items-center px-4 py-2.5 text-[13px] border-b border-neutral-border/55 last:border-b-0"
      style={{ gridTemplateColumns: GRID }}
    >
      <span className="font-medium text-neutral-text-primary truncate">{stakeholder.name}</span>
      <span className="text-xs text-neutral-text-secondary truncate">{stakeholder.email}</span>
      <span className="text-xs text-neutral-text-secondary truncate">
        {stakeholder.note || <span className="text-neutral-text-disabled">—</span>}
      </span>
      <span className="text-xs text-neutral-text-secondary truncate">
        {stakeholder.created_by ?? '—'}
      </span>
      <div className="flex justify-end gap-1">
        {canManage && !confirmRemove && (
          <button
            type="button"
            ref={editRef}
            onClick={() => onEdit(stakeholder.id)}
            disabled={isBusy}
            aria-label={`Edit ${stakeholder.name}`}
            className="min-h-[28px] px-2 rounded-control text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-sunken hover:text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
          >
            Edit
          </button>
        )}
        {canManage && !confirmRemove && (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={isBusy}
            aria-label={`Remove ${stakeholder.name}`}
            className="min-h-[28px] px-2 rounded-control text-xs font-medium text-semantic-critical hover:bg-semantic-critical/5 focus:outline-none focus:ring-2 focus:ring-semantic-critical focus:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
          >
            Remove
          </button>
        )}
        {confirmRemove && (
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onRemove(stakeholder.id);
                setConfirmRemove(false);
              }}
              disabled={isBusy}
              className="h-7 px-2 rounded-control border border-semantic-critical text-xs font-semibold text-semantic-critical hover:bg-semantic-critical/5 focus:outline-none focus:ring-2 focus:ring-semantic-critical focus:ring-offset-1 disabled:cursor-not-allowed"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              className="h-7 px-2 rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
            >
              Cancel
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Program Settings → External stakeholders (#1658, ADR-0264).
 *
 * A registry of non-account people (client sponsors, vendor contacts, external
 * reviewers) who are included in the `@program-stakeholders` mention fan-out
 * alongside the program's Viewer-role members. Admin+ manages the list; the API
 * enforces the same rule server-side (this is UX, not security).
 *
 * Rows are editable in place (#2530): one row at a time swaps its read cells for
 * the shared {@link StakeholderEditRow}, the same component the add row renders,
 * so correcting a typo no longer means remove-and-re-add — which would discard
 * the verified state #1675 will attach to the row.
 *
 * Email delivery to these addresses is not wired yet — the subtitle uses future
 * tense deliberately (delivery ships in #1675). Do not claim it emails today.
 */
export function ProgramStakeholdersPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: stakeholders = [], isLoading, isError } = useProgramExternalStakeholders(programId);
  const { create, update, remove } = useProgramExternalStakeholderMutations(programId ?? '');

  // Only one row edits at a time — a single mutation object carries one error
  // envelope, so two concurrent edit rows could not tell whose 400 it was.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Remounting the add row is how it clears: the draft lives inside the shared
  // component, so a successful create discards it by giving the row a new key.
  const [addRowKey, setAddRowKey] = useState(0);
  // Set when an edit row closes, so the row that reappears can put focus back on
  // the Edit button the user pressed (the form that held focus has unmounted).
  const [restoreFocusId, setRestoreFocusId] = useState<string | null>(null);

  if (!programId) return null;

  const canManage = program?.my_role != null && program.my_role >= ROLE_ADMIN;
  const isBusy = create.isPending || update.isPending || remove.isPending;

  // Surface the server's rejection inline: a field error (duplicate email) where
  // there is one, and the `detail` line otherwise — a closed program's 403 and a
  // 5xx must not leave the row looking like nothing happened.
  const fieldErrorsOf = (err: unknown): StakeholderFieldErrors | null => {
    if (err == null) return null;
    const data = (err as { response?: { data?: StakeholderFieldErrors } }).response?.data;
    if (data && (data.email || data.name || typeof data.detail === 'string')) return data;
    return { detail: 'Could not save — please try again.' };
  };

  function handleCreate(draft: StakeholderDraft) {
    create.mutate(
      { name: draft.name, email: draft.email, note: draft.note || undefined },
      { onSuccess: () => setAddRowKey((k) => k + 1) },
    );
  }

  function handleUpdate(id: string, draft: StakeholderDraft) {
    update.mutate(
      { id, name: draft.name, email: draft.email, note: draft.note },
      { onSuccess: () => closeEdit(id) },
    );
  }

  function startEdit(id: string) {
    // Drop a previous row's 400 so it can't be read as this row's error.
    update.reset();
    setRestoreFocusId(null);
    setEditingId(id);
  }

  function closeEdit(id: string) {
    setEditingId(null);
    setRestoreFocusId(id);
  }

  // Stable identity so the row's restore effect isn't re-run by a new closure.
  const clearRestoreFocus = () => setRestoreFocusId(null);

  return (
    <div>
      <SettingsPageTitle
        title="External stakeholders"
        count={stakeholders.length > 0 ? `${stakeholders.length}` : undefined}
        subtitle="People without a TruePPM account — client sponsors, vendors, reviewers — included in @program-stakeholders mentions. Email notifications to them will be added in a future release."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        <div
          className="grid items-center px-4 py-2 bg-neutral-surface-sunken border border-neutral-border rounded-t-card text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary mt-4"
          style={{ gridTemplateColumns: GRID }}
        >
          <span>Name</span>
          <span>Email</span>
          <span>Note</span>
          <span>Added by</span>
          <span />
        </div>

        <div className="bg-neutral-surface-raised border-x border-b border-neutral-border rounded-b-card overflow-hidden">
          {isLoading && (
            <LoadingSkeleton label="Loading external stakeholders" rows={3} className="px-4 py-6" />
          )}
          {isError && (
            <div role="alert" className="px-4 py-6 text-xs text-semantic-critical">
              Failed to load external stakeholders — please refresh.
            </div>
          )}
          {!isLoading && !isError && stakeholders.length === 0 && (
            <div role="status" className="px-4 py-6 text-xs text-neutral-text-secondary">
              No external stakeholders yet.
              {canManage && ' Add one below.'}
            </div>
          )}
          {!isLoading &&
            !isError &&
            stakeholders.map((s) =>
              editingId === s.id && canManage ? (
                <div
                  key={s.id}
                  className="px-4 py-2.5 bg-neutral-surface-sunken border-b border-neutral-border/55 last:border-b-0"
                >
                  <StakeholderEditRow
                    mode="edit"
                    initial={{ name: s.name, email: s.email, note: s.note ?? '' }}
                    idPrefix={`stakeholder-${s.id}`}
                    formLabel={`Edit ${s.name}`}
                    submitLabel="Save"
                    isPending={update.isPending}
                    fieldErrors={fieldErrorsOf(update.error)}
                    seatFocus
                    onSubmit={(draft) => handleUpdate(s.id, draft)}
                    onCancel={() => closeEdit(s.id)}
                  />
                </div>
              ) : (
                <StakeholderRow
                  key={s.id}
                  stakeholder={s}
                  canManage={canManage}
                  onRemove={(id) => remove.mutate(id)}
                  onEdit={startEdit}
                  isBusy={isBusy}
                  restoreFocus={restoreFocusId === s.id}
                  onFocusRestored={clearRestoreFocus}
                />
              ),
            )}

          {canManage && !isLoading && !isError && (
            <StakeholderEditRow
              key={addRowKey}
              mode="add"
              idPrefix="new-stakeholder"
              formLabel="Add external stakeholder"
              submitLabel="Add"
              isPending={create.isPending}
              fieldErrors={fieldErrorsOf(create.error)}
              className="px-4 py-2.5 border-t border-neutral-border/55"
              onSubmit={handleCreate}
              onCancel={() => create.reset()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

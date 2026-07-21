import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useProgram } from '@/hooks/useProgram';
import {
  useCloseProgram,
  useDeleteProgram,
  useReopenProgram,
  useSplitProgram,
  useTransferSponsorship,
} from '@/hooks/useProgramMutations';
import { SettingsPageTitle } from '../SettingsShell';
import { TransferOwnershipDialog } from '../components/TransferOwnershipDialog';
import { SplitProgramDialog } from '../components/SplitProgramDialog';

interface LifecycleCardProps {
  title: string;
  tone: 'neutral' | 'warning';
  description: string;
  actionLabel: string;
  notes: string[];
  disabled?: boolean;
  /** When the card is a not-yet-wired placeholder, the reason shown on hover
   *  (and as the accessible title) — should link the tracking issue, e.g. "… — tracked in #967". */
  disabledReason?: string;
  onClick?: () => void;
  busy?: boolean;
  error?: string | null;
}

function LifecycleCard({
  title,
  tone,
  description,
  actionLabel,
  notes,
  disabled,
  disabledReason,
  onClick,
  busy,
  error,
}: LifecycleCardProps) {
  return (
    <div
      className={[
        'rounded-card border p-4',
        // Warning tone uses the adaptive semantic-warning tokens (amber wash +
        // AA border) rather than the static bg-brand-accent-light (#FFF3CD),
        // which stays cream in dark mode while the neutral text tokens invert to
        // light ink — washing the card out to unreadable (issue 1619, rule 86).
        tone === 'warning'
          ? 'border-semantic-warning/70 bg-semantic-warning-bg'
          : 'border-neutral-border bg-neutral-surface-raised',
      ].join(' ')}
    >
      <h2 className="text-[13px] font-semibold text-neutral-text-primary mb-1">{title}</h2>
      <p className="text-[12px] text-neutral-text-secondary mb-2 leading-relaxed">{description}</p>
      <ul className="list-disc pl-4 mb-3 space-y-0.5">
        {notes.map((n) => (
          <li key={n} className="text-[11px] text-neutral-text-secondary">
            {n}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy || !onClick}
        title={disabled && !busy ? disabledReason : undefined}
        className={[
          'px-3 py-1.5 rounded-control border border-neutral-border text-[12px] font-medium',
          'text-neutral-text-primary hover:bg-neutral-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1',
          'disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:border-neutral-border/55 disabled:cursor-not-allowed',
        ].join(' ')}
      >
        {busy ? 'Working…' : actionLabel}
      </button>
      {error ? (
        <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Program > Archive / Transfer / Close settings page. */
export function ProgramArchivePage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const navigate = useNavigate();

  // The typed-confirmation phrase — prefer ``code`` (short identifier shared
  // with task-ID prefixes) and fall back to ``name`` for programs created
  // before #523 added the code field.
  const confirmTarget = (program?.code || program?.name || '').trim();

  const [confirmText, setConfirmText] = useState('');
  const confirmed = confirmTarget !== '' && confirmText === confirmTarget;

  const close = useCloseProgram();
  const reopen = useReopenProgram();
  const remove = useDeleteProgram();
  const transfer = useTransferSponsorship();
  const split = useSplitProgram();

  const [transferOpen, setTransferOpen] = useState(false);
  const transferError = transfer.error instanceof Error ? transfer.error.message : null;

  const [splitOpen, setSplitOpen] = useState(false);
  const splitError = split.error instanceof Error ? split.error.message : null;

  const isClosed = Boolean(program?.is_closed);
  const closeActionLabel = isClosed ? 'Reopen program…' : 'Close program…';

  const closeError =
    (isClosed ? reopen.error : close.error) instanceof Error
      ? (isClosed ? reopen.error : close.error)!.message
      : null;
  const deleteError = remove.error instanceof Error ? remove.error.message : null;

  const onToggleClose = () => {
    if (!programId) return;
    if (isClosed) {
      reopen.mutate(programId);
    } else {
      close.mutate(programId);
    }
  };

  const onDelete = () => {
    if (!programId) return;
    remove.mutate(programId, {
      onSuccess: () => {
        void navigate('/', { replace: true });
      },
    });
  };

  return (
    <div>
      <SettingsPageTitle
        title="Archive / Close"
        subtitle="Lifecycle actions for this program. All actions are logged and can be reviewed in the workspace audit log."
      />

      <div className="px-6 pb-8 max-w-[720px] space-y-3.5">
        <LifecycleCard
          title={isClosed ? 'Reopen program' : 'Close program'}
          tone="neutral"
          description={
            isClosed
              ? 'Restore writes to the program shell (members, settings, ceremonies). Child projects are unaffected.'
              : 'Marks the program shell read-only (members, settings, ceremonies). Child projects remain active.'
          }
          actionLabel={closeActionLabel}
          notes={
            isClosed
              ? ['Reversible — returns the program to its previous state.']
              : [
                  'Baselines, audit log, time entries, and attachments are retained.',
                  'Reversible by any Owner.',
                ]
          }
          onClick={onToggleClose}
          busy={close.isPending || reopen.isPending}
          error={closeError}
        />

        <LifecycleCard
          title="Transfer sponsorship"
          tone="warning"
          description="Assign a new sponsor and optionally a new program manager. The current sponsor is demoted to Admin."
          actionLabel="Transfer sponsorship…"
          notes={[
            'New sponsor must already be a program member.',
            'You are demoted to Admin when the transfer completes.',
          ]}
          onClick={() => setTransferOpen(true)}
          busy={transfer.isPending}
          error={transferError}
        />

        <LifecycleCard
          title="Split into sub-programs"
          tone="neutral"
          description="Divide this program into two or more independent programs. Projects are redistributed by phase or by project list."
          actionLabel="Split program…"
          notes={[
            'Original program is closed (read-only) after split.',
            'All project links, dependencies, and baselines are preserved.',
          ]}
          onClick={() => setSplitOpen(true)}
          busy={split.isPending}
          error={splitError}
        />

        {/* Delete — critical zone */}
        <div className="rounded-card border border-semantic-critical bg-semantic-critical-bg p-4">
          <h2 className="text-[13px] font-bold text-semantic-critical mb-1">
            Delete program — permanent
          </h2>
          <p className="text-[12px] text-neutral-text-secondary mb-3 leading-relaxed">
            Removes this program record. Member projects are{' '}
            <strong className="text-neutral-text-primary">not</strong> deleted — they revert to
            unaffiliated projects. Program-level baselines, rollup KPIs, and audit entries are
            deleted.
          </p>
          <div className="rounded-card border border-neutral-border bg-neutral-surface px-3 py-2.5 mb-3">
            <div className="text-[12px] text-neutral-text-secondary mb-2">
              To confirm, type the program {program?.code ? 'code' : 'name'}:
            </div>
            <div className="flex items-center gap-2">
              <code className="px-2 py-0.5 rounded-chip bg-neutral-surface-sunken border border-neutral-border tppm-mono text-[12px] text-neutral-text-primary">
                {confirmTarget || '…'}
              </code>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={confirmTarget ? `Type ${confirmTarget} to confirm` : 'Loading…'}
                aria-label="Confirm delete by typing the program code or name"
                disabled={!confirmTarget}
                className={[
                  'w-[240px] h-8 px-2.5 rounded-control border tppm-mono text-[12px] text-neutral-text-primary bg-neutral-surface-raised',
                  'placeholder:text-neutral-text-secondary',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical',
                  confirmText && !confirmed ? 'border-semantic-critical' : 'border-neutral-border',
                ].join(' ')}
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!confirmed || remove.isPending}
            onClick={onDelete}
            className={[
              'px-4 py-2 rounded-control text-[13px] font-semibold text-white bg-semantic-critical transition-opacity',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1',
              confirmed && !remove.isPending
                ? 'opacity-100 hover:opacity-90'
                : 'opacity-40 cursor-not-allowed',
            ].join(' ')}
          >
            {remove.isPending ? 'Deleting…' : 'Delete program permanently'}
          </button>
          {deleteError ? (
            <p className="mt-2 text-[11px] text-semantic-critical" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      </div>

      {transferOpen && programId ? (
        <TransferOwnershipDialog
          scope="program"
          scopeId={programId}
          title="Transfer sponsorship"
          description="The selected member becomes the program Owner (sponsor). You are demoted to Admin. Optionally rotate the program manager too. The new sponsor must already be a program member."
          ownerPickerLabel="new sponsor"
          leadPickerLabel="new program manager"
          error={transferError}
          busy={transfer.isPending}
          onCancel={() => setTransferOpen(false)}
          onConfirm={({ newOwnerId, newLeadId }) => {
            transfer.mutate(
              {
                programId,
                new_owner_user_id: newOwnerId,
                new_lead_user_id: newLeadId,
              },
              { onSuccess: () => setTransferOpen(false) },
            );
          }}
        />
      ) : null}

      {splitOpen && programId ? (
        <SplitProgramDialog
          programId={programId}
          programName={program?.name ?? 'program'}
          error={splitError}
          busy={split.isPending}
          onCancel={() => setSplitOpen(false)}
          onConfirm={(splits) => {
            split.mutate(
              { programId, splits },
              {
                onSuccess: (result) => {
                  setSplitOpen(false);
                  // The parent program is now a closed read-only shell — land the
                  // user on the first new sub-program (their work moved there), or
                  // home if the split produced none (all-empty edge case).
                  const firstSub = result.sub_programs[0];
                  void navigate(firstSub ? `/programs/${firstSub.id}` : '/', { replace: true });
                },
              },
            );
          }}
        />
      ) : null}
    </div>
  );
}

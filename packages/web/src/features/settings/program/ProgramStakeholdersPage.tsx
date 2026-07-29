import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { SettingsPageTitle } from '../SettingsShell';
import { Button } from '@/components/Button';
import { useProgram } from '@/hooks/useProgram';
import { ROLE_ADMIN } from '@/lib/roles';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import {
  useProgramExternalStakeholders,
  useProgramExternalStakeholderMutations,
  type ExternalStakeholder,
} from '../hooks/useProgramExternalStakeholders';
import { useProgramMentionReach } from '../hooks/useProgramMentionReach';
import { StakeholderEmptyState, StakeholderReachSummary } from './StakeholderReachSummary';

const GRID = '1.4fr 1.6fr 1.6fr 130px 96px';

interface RowProps {
  stakeholder: ExternalStakeholder;
  canManage: boolean;
  onRemove: (id: string) => void;
  isBusy: boolean;
}

function StakeholderRow({ stakeholder, canManage, onRemove, isBusy }: RowProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);

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
      <div className="flex justify-end">
        {canManage && !confirmRemove && (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={isBusy}
            aria-label={`Remove ${stakeholder.name}`}
            className="min-h-[28px] px-2 rounded-control text-xs font-medium text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:bg-neutral-surface-sunken disabled:text-neutral-text-secondary disabled:cursor-not-allowed"
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
              className="h-7 px-2 rounded-control border border-semantic-critical text-xs font-semibold text-semantic-critical hover:bg-semantic-critical/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-semantic-critical focus-visible:ring-offset-1 disabled:cursor-not-allowed"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              className="h-7 px-2 rounded-control border border-neutral-border text-xs font-medium text-neutral-text-secondary hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
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
 * reviewers) resolved as a *separate* target of the `@program-stakeholders`
 * fan-out — never unioned into it, so an internal mention cannot silently email a
 * client (#1675). Admin+ manages the list; the API enforces the same rule
 * server-side (this is UX, not security).
 *
 * Email delivery to these addresses is not wired yet — copy on this page uses
 * future tense deliberately (delivery ships in #1675). Do not claim it emails
 * today. `StakeholderReachSummary` owns the delivery truth; keep the subtitle to
 * what the registry *is*, so the deferral is stated once (#2529).
 */
export function ProgramStakeholdersPage() {
  const { programId } = useParams<{ programId: string }>();
  const { data: program } = useProgram(programId);
  const { data: stakeholders = [], isLoading, isError } = useProgramExternalStakeholders(programId);
  const { create, remove } = useProgramExternalStakeholderMutations(programId ?? '');
  const canManage = program?.my_role != null && program.my_role >= ROLE_ADMIN;
  // Server-computed (ADR-0697): the Viewer arm cannot be derived in the browser —
  // /programs/{id}/members/ returns ProgramMembership, which per ADR-0070 does not
  // propagate to project access, while the alias resolves the ProjectMembership
  // union at an exact Viewer role. Admin+ only, so a non-Admin never fires it.
  const { data: reach, isPending: isReachPending } = useProgramMentionReach(
    programId,
    canManage,
  );

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newNote, setNewNote] = useState('');

  if (!programId) return null;

  const isBusy = create.isPending || remove.isPending;

  // Surface the server's field error (duplicate email) inline.
  const createError = create.error as {
    response?: { data?: { email?: string[]; name?: string[] } };
  } | null;
  const emailErrorMessage = createError?.response?.data?.email?.[0];
  const nameErrorMessage = createError?.response?.data?.name?.[0];

  function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newName.trim() || !newEmail.trim()) return;
    create.mutate(
      { name: newName.trim(), email: newEmail.trim(), note: newNote.trim() || undefined },
      {
        onSuccess: () => {
          setNewName('');
          setNewEmail('');
          setNewNote('');
        },
      },
    );
  }

  return (
    <div>
      <SettingsPageTitle
        title="External stakeholders"
        count={stakeholders.length > 0 ? `${stakeholders.length}` : undefined}
        subtitle="People without a TruePPM account — client sponsors, vendors, reviewers — kept as a separate recipient list for @program-stakeholders mentions."
      />

      <div className="px-6 pb-8 max-w-[920px]">
        {/* Held until BOTH reads settle so the strip mounts in one commit — the
            settings shell renders every section in one scroll, so a two-step
            injection would shove every section below this one down twice.
            `isPending` stays true forever when the query is disabled, hence the
            `!canManage` short-circuit. */}
        {!isLoading && !isError && (!canManage || !isReachPending) && (
          <StakeholderReachSummary
            externalCount={stakeholders.length}
            viewerMemberCount={reach?.viewer_member_count}
            viewerCountRestricted={!canManage}
          />
        )}
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
            <LoadingSkeleton
              label="Loading external stakeholders"
              rows={3}
              className="px-4 py-6"
            />
          )}
          {isError && (
            <div role="alert" className="px-4 py-6 text-xs text-semantic-critical">
              Failed to load external stakeholders — please refresh.
            </div>
          )}
          {!isLoading && !isError && stakeholders.length === 0 && (
            <div role="status" className="px-4 py-6 text-xs text-neutral-text-secondary">
              <StakeholderEmptyState
                viewerMemberCount={reach?.viewer_member_count}
                canManage={canManage}
              />
            </div>
          )}
          {!isLoading &&
            !isError &&
            stakeholders.map((s) => (
              <StakeholderRow
                key={s.id}
                stakeholder={s}
                canManage={canManage}
                onRemove={(id) => remove.mutate(id)}
                isBusy={isBusy}
              />
            ))}
        </div>

        {canManage && (
          <form
            onSubmit={handleCreate}
            aria-label="Add external stakeholder"
            className="mt-4 space-y-2"
          >
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex-1">
                <label htmlFor="new-stakeholder-name" className="sr-only">
                  Name
                </label>
                <input
                  id="new-stakeholder-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name"
                  aria-invalid={nameErrorMessage ? true : undefined}
                  className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="new-stakeholder-email" className="sr-only">
                  Email
                </label>
                <input
                  id="new-stakeholder-email"
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="email@example.com"
                  aria-invalid={emailErrorMessage ? true : undefined}
                  className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="new-stakeholder-note" className="sr-only">
                  Note (optional)
                </label>
                <input
                  id="new-stakeholder-note"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Note (optional)"
                  className="h-8 w-full rounded border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                />
              </div>
              <Button
                type="submit"
                disabled={!newName.trim() || !newEmail.trim() || create.isPending}
              >
                Add
              </Button>
            </div>
            {(emailErrorMessage || nameErrorMessage) && (
              <p role="alert" className="text-xs text-semantic-critical">
                {emailErrorMessage ?? nameErrorMessage}
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

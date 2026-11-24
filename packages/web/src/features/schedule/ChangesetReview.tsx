import { useState } from 'react';
import { Button } from '@/components/Button';
import { toast } from '@/components/Toast';
import {
  refusalCode,
  useAnswerChangesetReason,
  useBaselineDecision,
  useChangeset,
  type ApiChangesetEntry,
  type RebaselineReasonCode,
} from '@/hooks/useChangeset';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';

const REASON_CODES: { value: RebaselineReasonCode; label: string }[] = [
  { value: 'approved_scope_change', label: 'Approved scope change' },
  { value: 'sponsor_moved_commitment', label: 'Sponsor moved the commitment' },
  { value: 'external_delay', label: 'External delay' },
  { value: 'estimate_correction', label: 'Estimate correction' },
  { value: 'team_change', label: 'Team change' },
  { value: 'calendar_change', label: 'Calendar change' },
];

const KIND_LABEL: Record<ApiChangesetEntry['kind'], string> = {
  add: 'Added',
  move: 'Moved',
  delete: 'Deleted',
};

interface ChangesetReviewProps {
  projectId: string;
  /** Caller's project role ordinal; null while loading. */
  currentRole: number | null;
}

/**
 * The changeset since the active baseline, and the two exits (ADR-1477, #3150).
 *
 * Members never see it (Pass 5 Q3.2): their structural edits still join the
 * changeset, and the plan owner answers them. Schedulers answer reasons. Only
 * Admin and Owner take a new baseline or keep this one, and the two exits are
 * identical cards with identical buttons and no default: Enter submits nothing,
 * because there is no form. Re-baselining is blocked while any change needs a
 * reason; keeping the baseline never is.
 */
export function ChangesetReview({ projectId, currentRole }: ChangesetReviewProps) {
  const canAnswer = currentRole != null && currentRole >= ROLE_SCHEDULER;
  const canDecide = currentRole != null && currentRole >= ROLE_ADMIN;
  const { data, refetch } = useChangeset(projectId, canAnswer);
  const decide = useBaselineDecision(projectId);
  const [reasonCode, setReasonCode] = useState<RebaselineReasonCode | ''>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  if (!canAnswer || !data || data.open_count === 0) return null;

  const blocked = data.unreasoned_count > 0;
  const takeReady = !blocked && reasonCode !== '' && reason.trim() !== '';

  const submit = (kind: 'taken' | 'kept') => {
    decide.mutate(
      kind === 'taken'
        ? {
            kind,
            expected_open_count: data.open_count,
            reason_code: reasonCode || undefined,
            reason: reason.trim(),
          }
        : { kind, expected_open_count: data.open_count, note: note.trim() },
      {
        onSuccess: () => {
          toast.success(
            kind === 'taken' ? 'New baseline taken.' : 'Baseline kept. Variance stands.',
          );
        },
        onError: (err) => {
          if (refusalCode(err) === 'changeset_changed') {
            toast.error('The changes moved since you opened this. Review the updated list.');
            void refetch();
          } else {
            toast.error("Couldn't record the decision. Try again.");
          }
        },
      },
    );
  };

  return (
    <section
      aria-labelledby="changeset-review-title"
      className="mt-6 border-t border-neutral-border pt-4"
    >
      <h3 id="changeset-review-title" className="text-sm font-semibold text-neutral-text-primary">
        {data.open_count} {data.open_count === 1 ? 'change' : 'changes'} since{' '}
        {data.active_baseline_name ?? 'the baseline'}
      </h3>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        Finish {data.finish_baseline ?? 'not recorded'} →{' '}
        {data.finish_current ?? 'not computed yet'}
        {data.net_delta_days != null &&
          ` (${data.net_delta_days >= 0 ? '+' : ''}${data.net_delta_days} days)`}
        {blocked && ` · ${data.unreasoned_count} need a reason`}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {data.entries.map((entry) => (
          <ChangesetEntryRow key={entry.id} projectId={projectId} entry={entry} />
        ))}
      </ul>

      <p className="mt-4 text-xs text-neutral-text-secondary">
        Re-baselining is not the only honest answer. Re-baseline when the plan itself was re-agreed,
        not to make a red number go green.
      </p>

      {canDecide && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-neutral-border p-3">
            <h4 className="text-sm font-semibold">Take a new baseline</h4>
            <label className="mt-2 block text-xs" htmlFor="rebaseline-code">
              Reason code
            </label>
            <select
              id="rebaseline-code"
              className="mt-1 w-full rounded border border-neutral-border p-1 text-sm"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as RebaselineReasonCode | '')}
            >
              <option value="">Choose…</option>
              {REASON_CODES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="mt-2 block text-xs" htmlFor="rebaseline-reason">
              Why was the plan re-agreed?
            </label>
            <textarea
              id="rebaseline-reason"
              maxLength={500}
              className="mt-1 w-full rounded border border-neutral-border p-1 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {blocked && (
              <p id="rebaseline-blocked" className="mt-1 text-xs text-neutral-text-secondary">
                {data.unreasoned_count} changes need a reason before this plan can be re-baselined.
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={!takeReady || decide.isPending}
              aria-describedby={blocked ? 'rebaseline-blocked' : undefined}
              onClick={() => submit('taken')}
            >
              Take new baseline
            </Button>
          </div>
          <div className="rounded-md border border-neutral-border p-3">
            <h4 className="text-sm font-semibold">
              Keep {data.active_baseline_name ?? 'this baseline'}
            </h4>
            <label className="mt-2 block text-xs" htmlFor="keep-note">
              Note (optional)
            </label>
            <textarea
              id="keep-note"
              maxLength={500}
              className="mt-1 w-full rounded border border-neutral-border p-1 text-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={decide.isPending}
              onClick={() => submit('kept')}
            >
              Keep baseline · let variance stand
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function ChangesetEntryRow({ projectId, entry }: { projectId: string; entry: ApiChangesetEntry }) {
  const answer = useAnswerChangesetReason(projectId);
  const [draft, setDraft] = useState('');
  const inputId = `reason-${entry.id}`;
  return (
    <li className="rounded-md border border-neutral-border p-2 text-sm">
      <div className="flex flex-wrap gap-x-2">
        <span className="font-medium">{KIND_LABEL[entry.kind]}</span>
        <span>{entry.task_names.join(', ') || `${entry.task_ids.length} tasks`}</span>
        <span className="text-xs text-neutral-text-secondary">
          {entry.author_name ?? 'Someone'} · finish {entry.finish_before ?? '—'} →{' '}
          {entry.finish_after ?? 'impact not computed yet'}
        </span>
      </div>
      {entry.reason_state === 'reasoned' ? (
        <p className="mt-1 text-xs">{entry.reason}</p>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <label htmlFor={inputId} className="text-xs text-neutral-text-secondary">
            ◌ Needs a reason
          </label>
          <input
            id={inputId}
            maxLength={500}
            className="min-w-0 flex-1 rounded border border-neutral-border p-1 text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={draft.trim() === '' || answer.isPending}
            onClick={() => answer.mutate({ entryId: entry.id, reason: draft.trim() })}
          >
            Save reason
          </Button>
        </div>
      )}
    </li>
  );
}

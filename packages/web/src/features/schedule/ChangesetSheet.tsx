import { useEffect, useState, type ReactNode } from 'react';
import { closeChangesetGroup } from '@/lib/changesetHints';
import { Button } from '@/components/Button';
import { toast } from '@/components/Toast';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  refusalCode,
  useAnswerChangesetReason,
  useBaselineDecision,
  useChangeset,
  type ApiChangeset,
  type ApiChangesetEntry,
  type BaselineDecisionBody,
  type RebaselineReasonCode,
} from '@/hooks/useChangeset';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { ROLE_ADMIN, ROLE_SCHEDULER } from '@/lib/roles';

/** #4813's six codes, labeled as Pass 5 frame 3C draws them. */
export const REASON_CODES: { value: RebaselineReasonCode; label: string }[] = [
  { value: 'approved_scope_change', label: 'Approved scope change' },
  { value: 'sponsor_moved_commitment', label: 'Sponsor moved the commitment' },
  { value: 'external_delay', label: 'External or vendor delay' },
  { value: 'estimate_correction', label: 'Estimate correction' },
  { value: 'team_change', label: 'Team or resource change' },
  { value: 'calendar_change', label: 'Calendar change' },
];

const KIND_LABEL: Record<ApiChangesetEntry['kind'], string> = {
  add: 'added work',
  move: 'restructured',
  delete: 'removed work',
};

/** Phone Keep v1 is one tap plus a 10 s Undo (Pass 5 4A pin 3; Q4.1 open). */
export const KEEP_UNDO_MS = 10_000;

/** "Baseline v1" → "v1", for the compact exits. Falls back to the full name. */
export function shortBaselineName(name: string | null | undefined): string {
  if (!name) return 'this baseline';
  return name.replace(/^Baseline\s+/i, '');
}

/** One entry's finish impact, in the sheet's words. Never guesses (ADR-1477 §4). */
export function finishImpact(entry: ApiChangesetEntry): string {
  if (entry.finish_after == null) return 'impact not computed yet';
  if (entry.finish_before === entry.finish_after) return 'no date change';
  return `${entry.finish_before ?? '—'} → ${entry.finish_after}`;
}

interface Draft {
  reasonCode: RebaselineReasonCode | '';
  reason: string;
  note: string;
}

const EMPTY_DRAFT: Draft = { reasonCode: '', reason: '', note: '' };

// The typed reason survives a reload and an offline spell on this device
// (Pass 5 4A-c: "your reason is kept on this device"). Storage can throw or come
// back empty in a private window; the sheet works without it.
function draftKey(projectId: string) {
  return `trueppm:changeset-decision-draft:${projectId}`;
}

function readDraft(projectId: string): Draft {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId));
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      reasonCode: REASON_CODES.some((c) => c.value === parsed.reasonCode)
        ? (parsed.reasonCode as RebaselineReasonCode)
        : '',
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(projectId: string, draft: Draft | null) {
  try {
    if (draft === null) window.localStorage.removeItem(draftKey(projectId));
    else window.localStorage.setItem(draftKey(projectId), JSON.stringify(draft));
  } catch {
    /* storage unavailable — the draft lives only in memory */
  }
}

export interface ChangesetSheetProps {
  projectId: string;
  /** Caller's project role ordinal; null while loading. */
  currentRole: number | null;
  /** Esc, ✕ and the scrim all close without deciding; the changeset stays open. */
  onClose: () => void;
}

/**
 * The changeset review sheet with its two coequal exits (ADR-1477 §5, Pass 5
 * frames 3C and 4A-b/c).
 *
 * Why the shape is what it is:
 * - Unreasoned entries come first so the blocker is the first thing read (D11).
 *   The server already orders them that way; the client re-sorts stably so a
 *   cached response can't reorder them.
 * - Neither exit is the default. There is no `<form>`, so Enter submits nothing,
 *   and the two buttons share one variant and one class string.
 * - Take v2 waits for every reason; Keep v1 is never blocked. The server refuses
 *   an unreasoned Take with `409 changeset_unreasoned` as well, so the disabled
 *   button is a courtesy, not the control.
 * - `expected_open_count` is the count the sheet rendered. If the set moved
 *   underneath (another tab, a phone), the server answers `409 changeset_changed`
 *   and the sheet refetches instead of deciding over changes nobody reviewed.
 * - Offline, both exits disable with "Reconnect to decide"; the typed reason is
 *   kept in local storage.
 * - Schedulers answer reasons and see no exits; Members never open the sheet
 *   (the ADR's ADMIN floor for deciding, Pass 5 Q3.2 as superseded).
 */
export function ChangesetSheet({ projectId, currentRole, onClose }: ChangesetSheetProps) {
  const isPhone = useBreakpoint() === 'sm';
  const canAnswer = currentRole != null && currentRole >= ROLE_SCHEDULER;
  const { data } = useChangeset(projectId, canAnswer);
  // Hoisted here so its pending flag can re-seat the trap (web rule 362): the
  // exits disable while a decision is in flight.
  const decide = useBaselineDecision(projectId);
  const trapRef = useFocusTrap<HTMLDivElement>(!isPhone, onClose, decide.isPending);

  const title = data
    ? `${data.open_count} ${data.open_count === 1 ? 'change' : 'changes'} since ${
        data.active_baseline_name ?? 'the baseline'
      }`
    : 'Changes since the baseline';

  const body = data ? (
    <ChangesetSheetBody
      projectId={projectId}
      data={data}
      currentRole={currentRole}
      isPhone={isPhone}
      onClose={onClose}
      decide={decide}
    />
  ) : (
    <p className="p-4 text-sm text-neutral-text-secondary">Loading changes…</p>
  );

  const header = (
    <div className="flex items-start gap-2 border-b border-neutral-border p-4">
      <div className="min-w-0 flex-1">
        <h2 id="changeset-sheet-title" className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          {shortBaselineName(data?.active_baseline_name)} is kept forever, whatever you choose.
          Decide what variance is measured against from now on.
        </p>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close without deciding"
        className="h-11 w-11 shrink-0 rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
      >
        ✕
      </button>
    </div>
  );

  if (isPhone) {
    return (
      <BottomSheet isOpen onClose={onClose} titleId="changeset-sheet-title" size="full">
        <div className="flex h-full flex-col" data-testid="changeset-sheet">
          {header}
          {body}
        </div>
      </BottomSheet>
    );
  }

  return (
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="changeset-sheet-title"
      tabIndex={-1}
      data-testid="changeset-sheet"
      // Above the baseline manager (z-50), which can open this sheet.
      className="fixed inset-0 z-[60] flex items-center justify-center bg-neutral-overlay p-4 focus:outline-none"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-neutral-border bg-neutral-surface shadow-pop">
        {header}
        {body}
      </div>
    </div>
  );
}

interface BodyProps {
  projectId: string;
  data: ApiChangeset;
  currentRole: number | null;
  isPhone: boolean;
  onClose: () => void;
  decide: ReturnType<typeof useBaselineDecision>;
}

function ChangesetSheetBody({ projectId, data, currentRole, isPhone, onClose, decide }: BodyProps) {
  const canDecide = currentRole != null && currentRole >= ROLE_ADMIN;
  const online = useOnlineStatus();
  // Opening Review closes the open group (ADR-1477 §3): an edit made after the
  // reviewer has seen the list is a new entry, never absorbed into one they saw.
  useEffect(() => {
    closeChangesetGroup();
  }, []);
  const [draft, setDraftState] = useState<Draft>(() => readDraft(projectId));
  // Phone only: "Take v2…" opens the reason step (4A-c).
  const [phoneStep, setPhoneStep] = useState<'list' | 'take'>('list');

  useEffect(() => {
    writeDraft(projectId, draft);
  }, [projectId, draft]);

  const setDraft = (patch: Partial<Draft>) => setDraftState((d) => ({ ...d, ...patch }));

  const entries = [...data.entries].sort(
    (a, b) => Number(a.reason !== null) - Number(b.reason !== null),
  );
  const blocked = data.unreasoned_count > 0;
  const takeReady = !blocked && draft.reasonCode !== '' && draft.reason.trim() !== '';
  const v = shortBaselineName(data.active_baseline_name);

  // `mutateAsync`, not `mutate` with per-call callbacks: the phone's deferred
  // Keep posts after the sheet has unmounted, and TanStack drops a per-call
  // callback whose component is gone, which would swallow a refusal silently.
  const post = (kind: 'taken' | 'kept') => {
    const body: BaselineDecisionBody =
      kind === 'taken'
        ? {
            kind,
            expected_open_count: data.open_count,
            reason_code: draft.reasonCode || undefined,
            reason: draft.reason.trim(),
          }
        : { kind, expected_open_count: data.open_count, note: draft.note.trim() };
    decide.mutateAsync(body).then(
      () => {
        writeDraft(projectId, null);
        toast.success(
          kind === 'taken'
            ? 'New baseline taken.'
            : `${data.active_baseline_name ?? 'Baseline'} kept. Variance stands.`,
        );
        onClose();
      },
      (err: unknown) => {
        const code = refusalCode(err);
        if (code === 'changeset_changed' || code === 'changeset_unreasoned') {
          toast.error('The changes moved since you opened this. Review the updated list.');
        } else {
          toast.error("Couldn't record the decision. Try again.");
        }
      },
    );
  };

  const keepOnPhone = () => {
    // One tap, then a 10 s Undo (Pass 5 4A pin 3). The decision row is
    // append-only, so "undo" can only mean "not sent yet": the POST waits for
    // the window to pass.
    let undone = false;
    onClose();
    toast.action(
      `Keeping ${v}…`,
      {
        label: 'Undo',
        ariaLabel: `Undo keeping ${v}`,
        onClick: () => {
          undone = true;
        },
      },
      { durationMs: KEEP_UNDO_MS },
    );
    window.setTimeout(() => {
      if (!undone) post('kept');
    }, KEEP_UNDO_MS);
  };

  const offlineNote = !online && (
    <p role="status" className="text-xs text-neutral-text-secondary">
      Reconnect to decide. Your reason is kept on this device.
    </p>
  );
  const exitDisabled = !online || decide.isPending;
  const blockedNote = blocked && (
    <p id="rebaseline-blocked" className="mt-1 text-xs text-neutral-text-secondary">
      {data.unreasoned_count} {data.unreasoned_count === 1 ? 'change needs' : 'changes need'} a
      reason before this plan can be re-baselined. The server enforces this too.
    </p>
  );

  const takeFields = (
    <>
      <label className="mt-2 block text-xs" htmlFor="rebaseline-code">
        Reason · required
      </label>
      <select
        id="rebaseline-code"
        className="mt-1 w-full rounded border border-neutral-border bg-neutral-surface p-2 text-sm"
        value={draft.reasonCode}
        onChange={(e) => setDraft({ reasonCode: e.target.value as RebaselineReasonCode | '' })}
      >
        <option value="">Choose…</option>
        {REASON_CODES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
      <label className="mt-2 block text-xs" htmlFor="rebaseline-reason">
        Why re-baseline · required · 500 characters
      </label>
      <textarea
        id="rebaseline-reason"
        maxLength={500}
        className="mt-1 w-full rounded border border-neutral-border bg-neutral-surface p-2 text-sm"
        value={draft.reason}
        onChange={(e) => setDraft({ reason: e.target.value })}
      />
      {blockedNote}
    </>
  );

  if (isPhone && phoneStep === 'take') {
    return (
      <>
        <div className="flex-1 overflow-y-auto p-4">
          <button
            type="button"
            className="mb-2 min-h-11 text-sm text-brand-primary"
            onClick={() => setPhoneStep('list')}
          >
            ‹ Back to the changes
          </button>
          <h3 className="text-sm font-semibold">Take baseline {nextVersionLabel(v)}</h3>
          <p className="mt-1 text-xs text-neutral-text-secondary">
            It becomes what variance is measured against, so it starts at 0 wd. {v} and these
            reasons stay in the change-control trail.
          </p>
          {takeFields}
          {offlineNote}
        </div>
        <PhoneFooter>
          <Button
            variant="secondary"
            disabled={!takeReady || exitDisabled}
            aria-describedby={blocked ? 'rebaseline-blocked' : undefined}
            onClick={() => post('taken')}
          >
            {online ? `Take baseline ${nextVersionLabel(v)}` : 'Reconnect to decide'}
          </Button>
          <Button variant="secondary" disabled={exitDisabled} onClick={keepOnPhone}>
            {online ? `Keep ${v} instead` : 'Reconnect to decide'}
          </Button>
        </PhoneFooter>
      </>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-4">
        <ul className="flex flex-col gap-2" aria-label="Open changes">
          {entries.map((entry) => (
            <ChangesetEntryRow key={entry.id} projectId={projectId} entry={entry} />
          ))}
        </ul>

        <section aria-label="Net effect" className="mt-4 rounded-md bg-neutral-surface-sunken p-3">
          <p className="text-sm">
            <span className="font-medium">Net effect · finish</span>{' '}
            {data.finish_baseline ?? 'not recorded'} →{' '}
            {data.finish_current ?? 'impact not computed yet'}
            {data.net_delta_days != null &&
              ` · ${data.net_delta_days >= 0 ? '+' : ''}${data.net_delta_days} wd vs ${v}`}
          </p>
        </section>

        <p className="mt-4 text-xs text-neutral-text-secondary">
          <strong>Re-baselining is not the only honest answer.</strong> If this slip is the news,
          keep {v} and let the variance stand. That is what it is for. Re-baseline when the plan
          itself was re-agreed, not to make a number go green.
        </p>

        {canDecide && !isPhone && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-md border border-neutral-border p-3">
              <h3 className="text-sm font-semibold">Take baseline {nextVersionLabel(v)}</h3>
              <p className="mt-1 text-xs text-neutral-text-secondary">
                It becomes what variance is measured against, so it starts at 0 wd. {v} and these
                reasons stay in the change-control trail.
              </p>
              {takeFields}
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={!takeReady || exitDisabled}
                aria-describedby={blocked ? 'rebaseline-blocked' : undefined}
                onClick={() => post('taken')}
              >
                {online ? `Take baseline ${nextVersionLabel(v)}` : 'Reconnect to decide'}
              </Button>
            </div>
            <div className="rounded-md border border-neutral-border p-3">
              <h3 className="text-sm font-semibold">Keep {v} · let variance stand</h3>
              <p className="mt-1 text-xs text-neutral-text-secondary">
                Variance keeps reading what this plan is carrying. The changes stay open, and
                unreasoned ones stay marked. Nobody is re-notified.
              </p>
              <label className="mt-2 block text-xs" htmlFor="keep-note">
                Note for the trail · optional
              </label>
              <textarea
                id="keep-note"
                maxLength={500}
                className="mt-1 w-full rounded border border-neutral-border bg-neutral-surface p-2 text-sm"
                value={draft.note}
                onChange={(e) => setDraft({ note: e.target.value })}
              />
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={exitDisabled}
                onClick={() => post('kept')}
              >
                {online ? `Keep ${v} · let variance stand` : 'Reconnect to decide'}
              </Button>
            </div>
          </div>
        )}
        {!isPhone && (
          <p className="mt-3 text-xs text-neutral-text-secondary">
            Esc or ✕ closes without deciding, and the changeset stays open.
          </p>
        )}
        {offlineNote}
      </div>
      {canDecide && isPhone && (
        <PhoneFooter>
          <Button
            variant="secondary"
            disabled={blocked || exitDisabled}
            aria-describedby={blocked ? 'rebaseline-blocked-phone' : undefined}
            onClick={() => setPhoneStep('take')}
          >
            {online ? `Take ${nextVersionLabel(v)}…` : 'Reconnect to decide'}
          </Button>
          <Button variant="secondary" disabled={exitDisabled} onClick={keepOnPhone}>
            {online ? `Keep ${v}` : 'Reconnect to decide'}
          </Button>
          {blocked && (
            <p id="rebaseline-blocked-phone" className="col-span-2 text-xs">
              {data.unreasoned_count}{' '}
              {data.unreasoned_count === 1 ? 'change needs' : 'changes need'} a reason first.
            </p>
          )}
        </PhoneFooter>
      )}
    </>
  );
}

/** "v1" → "v2"; anything else → "the new baseline". */
function nextVersionLabel(short: string): string {
  const m = /^v(\d+)$/i.exec(short);
  return m ? `v${Number(m[1]) + 1}` : 'a new baseline';
}

/** Sticky footer with two equal-width buttons (Pass 5 4A-b, 4A-c). */
function PhoneFooter({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="changeset-sheet-footer"
      className="sticky bottom-0 grid grid-cols-2 gap-2 border-t border-neutral-border bg-neutral-surface p-3 [&>button]:min-h-11"
    >
      {children}
    </div>
  );
}

function ChangesetEntryRow({ projectId, entry }: { projectId: string; entry: ApiChangesetEntry }) {
  const answer = useAnswerChangesetReason(projectId);
  const [draft, setDraft] = useState('');
  const inputId = `reason-${entry.id}`;
  const who = entry.author_name ?? 'Someone';
  const when = new Date(entry.last_act_at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <li className="rounded-md border border-neutral-border p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-text-secondary">
          {KIND_LABEL[entry.kind]}
        </span>
        <span className="font-medium">
          {entry.task_names.join(', ') || `${entry.task_ids.length} tasks`}
        </span>
        <span className="ml-auto text-xs">{finishImpact(entry)}</span>
      </div>
      <p className="mt-1 text-xs text-neutral-text-secondary">
        {who} · {when}
        {entry.reason === null && ' · no reason given yet'}
      </p>
      {entry.reason !== null ? (
        <p className="mt-1 text-sm">“{entry.reason}”</p>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor={inputId} className="shrink-0 text-xs font-medium">
            ◌ Needs a reason
          </label>
          <input
            id={inputId}
            maxLength={500}
            className="min-w-0 flex-1 rounded border border-neutral-border bg-neutral-surface p-2 text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={draft.trim() === '' || answer.isPending}
            onClick={() =>
              answer.mutate(
                { entryId: entry.id, reason: draft.trim() },
                {
                  onError: (err) => {
                    if (refusalCode(err) === 'reason_already_set') {
                      toast.info('Someone already gave this change a reason.');
                    } else {
                      toast.error("Couldn't save the reason. Try again.");
                    }
                  },
                },
              )
            }
          >
            Save
          </Button>
        </div>
      )}
    </li>
  );
}

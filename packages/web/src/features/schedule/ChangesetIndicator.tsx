import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/Button';
import { toast } from '@/components/Toast';
import {
  refusalCode,
  useAnswerChangesetReason,
  useChangeset,
  type ApiChangeset,
  type ApiChangesetEntry,
} from '@/hooks/useChangeset';
import { ROLE_SCHEDULER } from '@/lib/roles';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { formatChord } from '@/lib/platform';
import { ChangesetSheet, shortBaselineName } from './ChangesetSheet';

/**
 * Review is demoted to a secondary button after Keep v1 until the next
 * structural edit (Pass 5 Q3.1, ADR-1477 §5: `entries_since_kept`).
 */
export function isReviewDemoted(data: ApiChangeset): boolean {
  return data.last_kept_at != null && data.entries_since_kept === 0;
}

interface ChangesetIndicatorProps {
  projectId: string;
  /** Caller's project role ordinal; null while loading. */
  currentRole: number | null;
  /** Told when the sheet opens or closes, so a host modal can yield its focus trap. */
  onSheetOpenChange?: (open: boolean) => void;
}

/**
 * The context header's open-changeset indicator (Pass 5 frame 3B pin 1, 3D):
 * `◷ N changes open · M need a reason` plus `⚑ Review N changes` as the primary
 * action, or, once v1 is kept and nothing new has landed, the secondary
 * `◷ N changes · v1 kept`. Both open the same sheet.
 *
 * Shown to Scheduler, Admin and Owner only. A Member's structural edit still
 * joins the changeset; the plan owner answers it (Pass 5 3B).
 */
export function ChangesetIndicator({
  projectId,
  currentRole,
  onSheetOpenChange,
}: ChangesetIndicatorProps) {
  const canAnswer = currentRole != null && currentRole >= ROLE_SCHEDULER;
  const { data } = useChangeset(projectId, canAnswer);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const setSheet = (next: boolean) => {
    setOpen(next);
    onSheetOpenChange?.(next);
    if (!next) triggerRef.current?.focus();
  };

  if (!canAnswer || !data || data.open_count === 0) return null;

  const n = data.open_count;
  const changes = `${n} ${n === 1 ? 'change' : 'changes'}`;
  const demoted = isReviewDemoted(data);

  return (
    <>
      {demoted ? (
        <Button
          ref={triggerRef}
          variant="secondary"
          size="sm"
          onClick={() => setSheet(true)}
          data-testid="changeset-review-trigger"
        >
          <span aria-hidden="true">◷</span> {changes} ·{' '}
          {shortBaselineName(data.active_baseline_name)} kept
        </Button>
      ) : (
        <span className="inline-flex items-center gap-2">
          <span className="text-xs text-neutral-text-secondary" data-testid="changeset-counts">
            <span aria-hidden="true">◷</span> {changes} open
            {data.unreasoned_count > 0 &&
              ` · ${data.unreasoned_count} ${data.unreasoned_count === 1 ? 'needs' : 'need'} a reason`}
          </span>
          <Button
            ref={triggerRef}
            variant="primary"
            size="sm"
            onClick={() => setSheet(true)}
            data-testid="changeset-review-trigger"
          >
            <span aria-hidden="true">⚑</span> Review {changes}
          </Button>
        </span>
      )}
      {open && (
        <ChangesetSheet
          projectId={projectId}
          currentRole={currentRole}
          onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

/** The system's own words for what an entry did. A person writes the why. */
export function describeEntry(entry: ApiChangesetEntry): string {
  const count = Math.max(entry.task_ids.length, entry.task_names.length);
  const verb = { add: 'added', move: 'moved', delete: 'deleted' }[entry.kind];
  const what =
    count === 1 && entry.task_names[0]
      ? `${entry.task_names[0]} ${verb}`
      : `${count} tasks ${verb} in this session`;
  const finish =
    entry.finish_after != null && entry.finish_after !== entry.finish_before
      ? ` · finish ${entry.finish_before ?? '—'} → ${entry.finish_after}`
      : '';
  return what + finish;
}

/**
 * Row 3's non-modal reason line (Pass 5 frame 3B pin 2, #3150 D10).
 *
 * It states what happened and offers a `Why?` field, and it never waits on the
 * edit: the drop already applied. It never takes focus by itself, because a
 * line that grabbed focus after a pointer drop would turn D10's "asked after"
 * into a modal in all but name. The keyboard reaches it with ⌥W (or one Tab).
 * Esc or ✕ dismisses it without answering; the entry stays marked and the
 * header count still says so. A newer unreasoned entry brings it back.
 */
export function ChangesetReasonLine({
  projectId,
  currentRole,
}: {
  projectId: string;
  currentRole: number | null;
}) {
  const canAnswer = currentRole != null && currentRole >= ROLE_SCHEDULER;
  const { data } = useChangeset(projectId, canAnswer);
  const answer = useAnswerChangesetReason(projectId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [answeredOnce, setAnsweredOnce] = useState(false);

  // Newest unreasoned entry: the one the person most likely just made.
  const target =
    data?.entries
      .filter((e) => e.reason === null)
      .sort((a, b) => b.last_act_at.localeCompare(a.last_act_at))[0] ?? null;

  useEffect(() => {
    if (!canAnswer) return;
    const onKey = (e: KeyboardEvent) => {
      // `code`, not `key`: on macOS ⌥W types "∑".
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyW') {
        if (!inputRef.current) return;
        e.preventDefault();
        inputRef.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAnswer]);

  if (!canAnswer || !data) return null;

  if (!target) {
    return answeredOnce ? (
      <p role="status" aria-live="polite" className="text-xs text-neutral-text-secondary">
        ✓ reasons up to date
      </p>
    ) : null;
  }
  if (dismissedId === target.id) return null;

  const others = data.unreasoned_count - 1;
  const save = () => {
    const reason = draft.trim();
    if (!reason) return;
    answer.mutate(
      { entryId: target.id, reason },
      {
        onSuccess: () => {
          setDraft('');
          setAnsweredOnce(true);
        },
        onError: (err) => {
          toast.error(
            refusalCode(err) === 'reason_already_set'
              ? 'Someone already gave this change a reason.'
              : "Couldn't save the reason. Try again.",
          );
        },
      },
    );
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs"
      data-testid="changeset-reason-line"
    >
      <p role="status" aria-live="polite" className="min-w-0 truncate">
        {describeEntry(target)}
        {others > 0 && ` · ${others} more ${others === 1 ? 'needs' : 'need'} a reason`}
      </p>
      <label htmlFor="changeset-reason-line-input" className="sr-only">
        Why? Reason for: {describeEntry(target)}
      </label>
      <input
        ref={inputRef}
        id="changeset-reason-line-input"
        placeholder="Why?"
        maxLength={500}
        aria-keyshortcuts="Alt+W"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDismissedId(target.id);
          }
        }}
        className="h-8 w-56 min-w-0 rounded border border-neutral-border bg-neutral-surface px-2 text-xs"
      />
      <kbd className="text-neutral-text-secondary" aria-hidden="true">
        {formatChord('alt+w')}
      </kbd>
      <button
        type="button"
        aria-label="Dismiss; the change stays marked"
        onClick={() => setDismissedId(target.id)}
        className="h-8 w-8 rounded-control text-neutral-text-secondary hover:bg-neutral-surface-sunken focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Where the changeset surfaces on the schedule: the header row on desktop
 * (3B), the Plan card on a phone (Pass 5 4A-a). One mount point, so the
 * schedule never renders both.
 */
export function ChangesetStrip({
  projectId,
  currentRole,
}: {
  projectId: string;
  currentRole: number | null;
}) {
  const isPhone = useBreakpoint() === 'sm';
  if (isPhone) return <ChangesetPhoneCard projectId={projectId} currentRole={currentRole} />;
  return (
    <div className="flex min-w-0 items-center justify-end gap-3 px-3 empty:hidden">
      <ChangesetReasonLine projectId={projectId} currentRole={currentRole} />
      <ChangesetIndicator projectId={projectId} currentRole={currentRole} />
    </div>
  );
}

/**
 * The phone's open-changeset card at the top of Plan (Pass 5 4A-a, pin 1),
 * and the desktop-only note beneath it (pin 2).
 *
 * The card sits in the content, not the chrome, so the phone keeps its rows:
 * the count, since when (the first open change), the finish against the
 * baseline with "as of", and one action, Review. The note says plainly that
 * add, move and delete are desktop-only, what the phone can still do, and
 * hands off two ways (Q4.2 follows the drawn default, both): Copy link, and
 * Email it to me, which opens a draft addressed to the signed-in user's own
 * address and no one else's. It is a `mailto:`, so nothing is sent from the
 * server and no other address can be supplied.
 */
export function ChangesetPhoneCard({
  projectId,
  currentRole,
}: {
  projectId: string;
  currentRole: number | null;
}) {
  const canAnswer = currentRole != null && currentRole >= ROLE_SCHEDULER;
  const { data } = useChangeset(projectId, canAnswer);
  const { user } = useCurrentUser();
  const { formatInstantTime, formatInstantDate } = useUserDateFormat();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!canAnswer || !data || data.open_count === 0) return null;

  const n = data.open_count;
  const changes = `${n} ${n === 1 ? 'change' : 'changes'}`;
  const v = shortBaselineName(data.active_baseline_name);
  const first = data.entries.reduce<string | null>(
    (min, e) => (min === null || e.opened_at < min ? e.opened_at : min),
    null,
  );
  const delta = data.net_delta_days;
  const at = data._provenance?.computed_at;
  const asOf = typeof at === 'string' && at ? formatInstantTime(at) : null;
  const link = window.location.href;

  const copyLink = () => {
    // `navigator.clipboard` is absent outside a secure context; say so rather
    // than throwing from the click handler.
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip === undefined) {
      toast.error("Couldn't copy the link.");
      return;
    }
    clip
      .writeText(link)
      .then(() => toast.success('Link copied.'))
      .catch(() => toast.error("Couldn't copy the link."));
  };

  return (
    <div className="flex flex-col gap-2 px-3 pt-3" data-testid="changeset-phone-card">
      <section
        aria-label="Open changeset"
        className="rounded-md border border-neutral-border bg-neutral-surface p-3 text-sm"
      >
        <p className="font-medium">
          <span aria-hidden="true">◷</span> {changes} open since {v}
          {first && ` · ${formatInstantDate(first)}`}
        </p>
        <p className="mt-1 text-xs text-neutral-text-secondary">
          Finish {fmtUtcShort(data.finish_baseline)} → {fmtUtcShort(data.finish_current)}
          {delta != null && delta !== 0 && (
            <>
              {` · ${delta > 0 ? '+' : ''}${delta} `}
              <abbr title="working days">wd</abbr>
              {` vs ${v}`}
            </>
          )}
          {asOf && ` · as of ${asOf}`}
        </p>
        <Button
          ref={triggerRef}
          variant="primary"
          size="sm"
          className="mt-2 min-h-11 w-full"
          onClick={() => setOpen(true)}
          data-testid="changeset-review-trigger"
        >
          Review {changes}
        </Button>
      </section>
      <div
        role="note"
        aria-label="Desktop-only edits"
        className="rounded-md bg-neutral-surface-sunken p-3 text-xs"
      >
        <p className="font-semibold">Adding, moving or deleting tasks is on desktop</p>
        <p className="mt-1">
          A structural edit applies there straight away and asks why afterwards. On the phone you
          can update status, % complete and dates, review this changeset, and give a missing reason.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2 [&>*]:min-h-11">
          <Button variant="secondary" size="sm" onClick={copyLink}>
            Copy link
          </Button>
          {user?.email ? (
            <a
              className="inline-flex items-center justify-center rounded-control border border-neutral-border bg-neutral-surface text-sm font-medium focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
              href={`mailto:${encodeURIComponent(user.email)}?subject=${encodeURIComponent(
                'Review the changeset on desktop',
              )}&body=${encodeURIComponent(link)}`}
            >
              Email it to me
            </a>
          ) : null}
        </div>
      </div>
      {open && (
        <ChangesetSheet
          projectId={projectId}
          currentRole={currentRole}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

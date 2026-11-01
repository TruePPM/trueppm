/**
 * /programs/:programId/decisions — the program decision log (ADR-1310, #4772).
 *
 * Two lists: what the program is waiting on (soonest due first) and what it has
 * decided (most recent first). Withdrawn decisions are kept by the server but not
 * listed here — withdrawing is how a member takes a decision off the log without
 * deleting the record.
 *
 * Not the project Decisions view under Reports (ADR-0167), which reads
 * decision-flagged task notes. That one records what a team noted it decided;
 * this one tracks a named call with an owner and a due date until it is made.
 */
import { useState, type FormEvent } from 'react';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useProgram } from '@/hooks/useProgram';
import { useProgramId } from '@/hooks/useProgramId';
import { useUserDateFormat } from '@/hooks/useUserDateFormat';
import { localTodayIso } from '@/lib/localDate';
import { ROLE_MEMBER } from '@/lib/roles';
import { useProgramMembers } from '../hooks/useProgramMembers';
import {
  decidedLabel,
  dueLabel,
  impactProvenance,
  linkLabel,
  ownerName,
  type ProgramDecision,
  type ProgramDecisionStatus,
} from './decisionListModel';
import { useProgramDecisions, useSaveProgramDecision } from './useProgramDecisions';

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1';
const SECONDARY_BUTTON = `min-h-[44px] rounded-control border border-neutral-border px-3 text-sm font-medium text-neutral-text-primary hover:bg-neutral-surface-sunken disabled:opacity-50 ${FOCUS}`;
const PRIMARY_BUTTON = `min-h-[44px] rounded-control bg-brand-primary px-4 text-sm font-medium text-neutral-text-inverse hover:opacity-90 disabled:opacity-50 ${FOCUS}`;
const FIELD = `min-h-[44px] w-full rounded-control border border-neutral-border bg-neutral-surface px-2 text-sm text-neutral-text-primary ${FOCUS}`;

function NewDecisionForm({ programId, onDone }: { programId: string; onDone: () => void }) {
  const members = useProgramMembers(programId);
  const save = useSaveProgramDecision(programId);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [impactNote, setImpactNote] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    save.mutate(
      {
        body: {
          title: title.trim(),
          owner: owner ? Number(owner) : null,
          due_date: dueDate || null,
          impact_note: impactNote,
        },
      },
      { onSuccess: onDone },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Log a decision"
      className="mb-6 flex flex-col gap-3 rounded-card border border-neutral-border bg-neutral-surface p-4"
    >
      <div>
        <label
          htmlFor="decision-title"
          className="mb-1 block text-sm font-medium text-neutral-text-primary"
        >
          Decision
        </label>
        <input
          id="decision-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Go or no-go on the vendor cutover"
          maxLength={512}
          required
          className={FIELD}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label
            htmlFor="decision-owner"
            className="mb-1 block text-sm font-medium text-neutral-text-primary"
          >
            Owner
          </label>
          <select
            id="decision-owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className={FIELD}
          >
            <option value="">No owner</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={String(m.user)}>
                {m.user_detail.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="decision-due"
            className="mb-1 block text-sm font-medium text-neutral-text-primary"
          >
            Due date
          </label>
          <input
            id="decision-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={FIELD}
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="decision-impact"
          className="mb-1 block text-sm font-medium text-neutral-text-primary"
        >
          Owner&apos;s impact estimate
        </label>
        <textarea
          id="decision-impact"
          value={impactNote}
          onChange={(e) => setImpactNote(e.target.value)}
          rows={2}
          placeholder="e.g. recovers 2 days · P80 back to Dec 5"
          aria-describedby="decision-impact-hint"
          className={`${FIELD} py-2`}
        />
        <p id="decision-impact-hint" className="mt-1 text-xs text-neutral-text-secondary">
          Shown as the owner&apos;s estimate, dated — TruePPM does not compute it.
        </p>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-semantic-critical">
          Couldn&apos;t save the decision. Check the fields and try again.
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={save.isPending || !title.trim()} className={PRIMARY_BUTTON}>
          {save.isPending ? 'Saving…' : 'Save decision'}
        </button>
        <button type="button" onClick={onDone} className={SECONDARY_BUTTON}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DecisionRow({
  decision,
  programId,
  canWrite,
}: {
  decision: ProgramDecision;
  programId: string;
  canWrite: boolean;
}) {
  const { fmtDateShort, formatInstantDate } = useUserDateFormat();
  const save = useSaveProgramDecision(programId);
  const due = dueLabel(decision, localTodayIso(), fmtDateShort);
  const decided = decidedLabel(decision, formatInstantDate);
  const provenance = impactProvenance(decision, formatInstantDate);
  const link = linkLabel(decision);
  const move = (status: ProgramDecisionStatus) =>
    save.mutate({ id: decision.id, body: { status } });

  return (
    <li className="flex flex-col gap-2 rounded-card border border-neutral-border bg-neutral-surface p-3 md:flex-row md:items-start">
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium text-neutral-text-primary">
          {decision.title}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-text-secondary">
          <span>{ownerName(decision)}</span>
          {due && (
            <span className={due.overdue ? 'font-medium text-semantic-critical' : undefined}>
              {due.text}
            </span>
          )}
          {decided && <span>{decided}</span>}
          {link && <span>{link}</span>}
        </p>
        {provenance && (
          // Plain body text with its attribution — never the mono/figure styling
          // forecast numbers use (ADR-1310 §2).
          <div className="mt-2 border-l-2 border-neutral-border pl-2">
            <p className="whitespace-pre-wrap break-words text-sm text-neutral-text-primary">
              {decision.impact_note}
            </p>
            <p className="text-xs text-neutral-text-secondary">{provenance}</p>
          </div>
        )}
        {save.isError && (
          <p role="alert" className="mt-1 text-xs text-semantic-critical">
            Couldn&apos;t update this decision.
          </p>
        )}
      </div>
      {canWrite && (
        <div className="flex shrink-0 gap-2">
          {decision.status === 'awaiting' ? (
            <>
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => move('made')}
                className={SECONDARY_BUTTON}
              >
                Mark made
              </button>
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => move('withdrawn')}
                className={SECONDARY_BUTTON}
              >
                Withdraw
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={save.isPending}
              onClick={() => move('awaiting')}
              className={SECONDARY_BUTTON}
            >
              Reopen
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function DecisionSection({
  heading,
  emptyText,
  list,
  programId,
  canWrite,
}: {
  heading: string;
  emptyText: string;
  list: ReturnType<typeof useProgramDecisions>;
  programId: string;
  canWrite: boolean;
}) {
  return (
    <section aria-labelledby={`decisions-${heading}`} className="mb-6">
      <h2
        id={`decisions-${heading}`}
        className="mb-2 text-sm font-semibold text-neutral-text-primary"
      >
        {heading} <span className="font-normal text-neutral-text-secondary">({list.total})</span>
      </h2>
      {list.decisions.length === 0 ? (
        <p className="text-sm text-neutral-text-secondary">{emptyText}</p>
      ) : (
        <ul className="flex list-none flex-col gap-2 p-0">
          {list.decisions.map((d) => (
            <DecisionRow key={d.id} decision={d} programId={programId} canWrite={canWrite} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
          className={`mt-2 ${SECONDARY_BUTTON}`}
        >
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

export function ProgramDecisionsPage() {
  const programId = useProgramId();
  const { data: program } = useProgram(programId);
  const awaiting = useProgramDecisions(programId, 'awaiting');
  const made = useProgramDecisions(programId, 'made');
  const [creating, setCreating] = useState(false);
  // Team Member+ writes (the server enforces it; this only decides what to offer).
  // A Viewer has no rights here, so the controls are absent rather than disabled.
  const canWrite = (program?.my_role ?? 0) >= ROLE_MEMBER;

  const isLoading = awaiting.isLoading || made.isLoading;
  const error = awaiting.error ?? made.error;
  const isEmpty = !isLoading && !error && awaiting.total === 0 && made.total === 0;

  let body;
  if (isLoading) {
    body = (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading decisions">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-card border border-neutral-border bg-neutral-surface motion-safe:animate-pulse"
          />
        ))}
      </div>
    );
  } else if (error) {
    body = (
      <QueryErrorState
        variant="inline"
        message="Couldn't load decisions."
        onRetry={() => {
          void awaiting.refetch();
          void made.refetch();
        }}
      />
    );
  } else if (isEmpty) {
    body = (
      <div className="rounded-card border border-neutral-border bg-neutral-surface p-6 text-center">
        <p className="text-sm font-medium text-neutral-text-primary">No decisions logged</p>
        <p className="mt-1 text-sm text-neutral-text-secondary">
          Log the calls this program is waiting on, with an owner and a due date.
        </p>
      </div>
    );
  } else if (programId) {
    body = (
      <>
        <DecisionSection
          heading="Awaiting"
          emptyText="Nothing is waiting on a decision."
          list={awaiting}
          programId={programId}
          canWrite={canWrite}
        />
        <DecisionSection
          heading="Made"
          emptyText="No decisions made yet."
          list={made}
          programId={programId}
          canWrite={canWrite}
        />
      </>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-neutral-text-primary">Decisions</h1>
          <p className="mt-1 text-sm text-neutral-text-secondary">
            What this program is waiting on, and what it has decided.
          </p>
        </div>
        {canWrite && !creating && (
          <button type="button" onClick={() => setCreating(true)} className={PRIMARY_BUTTON}>
            Log a decision
          </button>
        )}
      </header>
      {creating && programId && (
        <NewDecisionForm programId={programId} onDone={() => setCreating(false)} />
      )}
      {body}
    </div>
  );
}

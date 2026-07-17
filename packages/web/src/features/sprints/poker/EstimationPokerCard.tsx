/**
 * Estimation poker card (ADR-0179, issue 863) — the sprint-planning right-rail surface that
 * sizes unestimated candidates in-place: open a round, vote on a Fibonacci card, reveal
 * simultaneously, discuss the outlier, and commit the agreed Task.story_points.
 *
 * Renders only when the sprint is PLANNED and there is at least one unestimated candidate
 * or a live round. The facilitator (Scrum Master / Product Owner / Admin — `canFacilitate`)
 * sees the open/reveal/commit controls; every team member votes.
 */

import { useMemo, useState } from 'react';
import type { PokerSession } from '@/types';
import { POKER_CARDS, outlierValue } from './pokerOutlier';
import { FibonacciCardRow } from './FibonacciCardRow';
import {
  useCancelPoker,
  useCastVote,
  useCommitPoker,
  useOpenPoker,
  useReopenPoker,
  useRevealPoker,
  useSprintPoker,
} from './usePoker';

interface Candidate {
  id: string;
  name: string;
  story_points: number | null;
}

/** Most-common revealed numeric vote (the consensus default); ties resolve to the higher
 * card so the estimate errs toward caution. Returns a Fibonacci card or null. */
function consensusDefault(session: PokerSession): number | null {
  const counts = new Map<number, number>();
  for (const v of session.votes) {
    if (typeof v.value === 'number') counts.set(v.value, (counts.get(v.value) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const card of POKER_CARDS) {
    const c = counts.get(card) ?? 0;
    if (c >= bestCount && c > 0) {
      best = card;
      bestCount = c;
    }
  }
  return best;
}

export function EstimationPokerCard({
  sprintId,
  candidates,
  canFacilitate,
}: {
  sprintId: string;
  candidates: Candidate[];
  canFacilitate: boolean;
}) {
  const { sessions, isLoading } = useSprintPoker(sprintId);
  const open = useOpenPoker();
  const vote = useCastVote();
  const reveal = useRevealPoker();
  const reopen = useReopenPoker();
  const commit = useCommitPoker();
  const cancel = useCancelPoker();

  const liveSession = sessions[0] ?? null;
  const unestimated = useMemo(
    () => candidates.filter((c) => c.story_points == null),
    [candidates],
  );
  // The next candidate to size: the first unestimated task without a live round.
  const liveTaskIds = new Set(sessions.map((s) => s.task.id));
  const nextCandidate = unestimated.find((c) => !liveTaskIds.has(c.id)) ?? null;

  // Facilitator's chosen commit value (defaults to the consensus once revealed).
  const [commitChoice, setCommitChoice] = useState<number | null>(null);

  // Hide entirely when there's nothing to do (no unestimated candidates and no live round).
  if (!liveSession && unestimated.length === 0) return null;

  return (
    <section
      aria-label="Estimation poker"
      className="rounded border border-neutral-border bg-neutral-surface-raised p-4 flex flex-col gap-3"
    >
      <h3 className="text-sm font-semibold text-neutral-text-primary">Estimation poker</h3>

      {isLoading ? (
        <div className="h-16 rounded bg-neutral-surface motion-safe:animate-pulse" aria-busy="true" />
      ) : !liveSession ? (
        // ── Idle ──────────────────────────────────────────────────────────────
        <div className="flex flex-col gap-2">
          <p className="text-sm text-neutral-text-secondary">
            {unestimated.length === 0
              ? 'All selected candidates estimated · poker idle.'
              : `${unestimated.length} candidate${unestimated.length === 1 ? '' : 's'} still unestimated.`}
          </p>
          {canFacilitate && nextCandidate && (
            <button
              type="button"
              onClick={() => open.mutate({ sprintId, taskId: nextCandidate.id })}
              disabled={open.isPending}
              className="self-start rounded-full bg-brand-primary text-neutral-text-inverse px-4 h-8 text-sm font-medium
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:opacity-50"
            >
              Start poker · {nextCandidate.name}
            </button>
          )}
        </div>
      ) : liveSession.state === 'open' ? (
        // ── Open voting ───────────────────────────────────────────────────────
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-text-primary">
            Sizing: <span className="font-medium">{liveSession.task.name}</span>
          </p>
          <FibonacciCardRow
            value={liveSession.my_vote ? liveSession.my_vote.value : undefined}
            onSelect={(card) =>
              vote.mutate({ sprintId, sessionId: liveSession.id, value: card })
            }
          />
          <p className="text-xs text-neutral-text-secondary tppm-mono" role="status" aria-live="polite">
            {liveSession.vote_count} of {liveSession.participant_count} voted
          </p>
          {canFacilitate && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => reveal.mutate({ sprintId, sessionId: liveSession.id })}
                disabled={reveal.isPending || liveSession.vote_count === 0}
                className="rounded border border-brand-primary/40 text-brand-primary bg-brand-primary/10 px-3 h-7 text-xs font-medium
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                  disabled:opacity-50"
              >
                Reveal
              </button>
              <button
                type="button"
                onClick={() => cancel.mutate({ sprintId, sessionId: liveSession.id })}
                disabled={cancel.isPending}
                className="rounded border border-neutral-border text-neutral-text-secondary px-3 h-7 text-xs font-medium
                  hover:bg-neutral-surface
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        // ── Revealed ──────────────────────────────────────────────────────────
        <RevealBody
          session={liveSession}
          canFacilitate={canFacilitate}
          commitChoice={commitChoice ?? consensusDefault(liveSession)}
          onPick={setCommitChoice}
          onCommit={(points) => {
            commit.mutate(
              { sprintId, sessionId: liveSession.id, points },
              { onSuccess: () => setCommitChoice(null) },
            );
          }}
          onReopen={() => reopen.mutate({ sprintId, sessionId: liveSession.id })}
          committing={commit.isPending}
        />
      )}
    </section>
  );
}

function RevealBody({
  session,
  canFacilitate,
  commitChoice,
  onPick,
  onCommit,
  onReopen,
  committing,
}: {
  session: PokerSession;
  canFacilitate: boolean;
  commitChoice: number | null;
  onPick: (v: number | null) => void;
  onCommit: (points: number) => void;
  onReopen: () => void;
  committing: boolean;
}) {
  const outlier = outlierValue(session.votes.map((v) => v.value));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-neutral-text-primary">
        Revealed: <span className="font-medium">{session.task.name}</span>
      </p>
      <ul className="flex flex-col gap-1 list-none p-0">
        {session.votes.map((v, i) => (
          <li key={i} className="flex items-baseline gap-2 text-sm">
            <span className="tppm-mono w-8 shrink-0 text-neutral-text-primary">
              {v.value ?? '?'}
            </span>
            <span className="text-neutral-text-secondary">
              {v.voter?.display_name ?? 'Unknown'}
            </span>
            {v.comment && (
              <span className="text-xs text-neutral-text-secondary italic truncate">
                — {v.comment}
              </span>
            )}
          </li>
        ))}
      </ul>
      {outlier !== null && (
        <p className="text-xs text-semantic-critical italic">
          ⚠ Outlier at {outlier} — worth a quick conversation before committing.
        </p>
      )}
      {canFacilitate ? (
        <div className="flex flex-col gap-2">
          <FibonacciCardRow value={commitChoice} onSelect={onPick} groupLabel="Agreed estimate" />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={committing || commitChoice == null}
              onClick={() => commitChoice != null && onCommit(commitChoice)}
              className="rounded-full bg-brand-primary text-neutral-text-inverse px-4 h-8 text-sm font-medium
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
                disabled:opacity-50"
            >
              {committing ? 'Committing…' : `Commit · ${commitChoice ?? '—'} points`}
            </button>
            <button
              type="button"
              onClick={onReopen}
              className="rounded border border-neutral-border text-neutral-text-secondary px-3 h-8 text-sm font-medium
                hover:bg-neutral-surface
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              Re-vote
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-neutral-text-secondary">Waiting for the facilitator to commit.</p>
      )}
    </div>
  );
}

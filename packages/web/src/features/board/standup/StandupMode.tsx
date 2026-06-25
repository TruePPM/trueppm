/**
 * Daily standup walk-the-board mode (ADR-0166, issue 1278).
 *
 * A focused, full-surface "drive the room" overlay (often projected) that walks the
 * active sprint one teammate at a time. The Scrum Master steps person-to-person with
 * the on-screen stepper or the ← / → keys; Esc exits. The Sprint Goal is pinned at the
 * top so the Daily Scrum stays anchored to the commitment (VoC Alex). It is the
 * current-state, per-person lens — distinct from the team-wide "what changed" delta
 * feed on the Sprints view, which a footer link points to.
 *
 * Data is server-assembled (useStandup); this component only walks it. Real-time is
 * free: the query is invalidated by useProjectWebSocket on card-sync events, so a card
 * moved by a contributor mid-standup refetches into the walk.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useIterationLabel } from '@/hooks/useIterationLabel';
import { sprintTimebox } from '@/features/board/sprintTimebox';
import { StandupPersonCard } from './StandupPersonCard';
import { useStandup } from './useStandup';

interface Props {
  projectId: string;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

export function StandupMode({ projectId, onClose, onOpenTask }: Props) {
  const itl = useIterationLabel();
  const { data, isLoading, isError } = useStandup(projectId, true);
  const [index, setIndex] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Trap Tab inside the projected overlay and close on Esc — AT users in the room
  // must not tab out into the obscured board behind the dialog (ux-review, rule 204).
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const walk = data?.active ? data.walk : [];
  const count = walk.length;
  // Clamp the cursor whenever the walk shrinks (a card moved out narrows the team).
  const current = Math.min(index, Math.max(0, count - 1));

  const step = useCallback(
    (delta: number) => setIndex((i) => Math.min(Math.max(i + delta, 0), Math.max(0, count - 1))),
    [count],
  );

  // The stepper is run live in a meeting → arrow keys walk regardless of where focus
  // sits (VoC Alex). Window-level so the keys work without first tabbing to a control.
  // Esc is handled by useFocusTrap's onEscape, not here, to avoid a double close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') {
        step(1);
      } else if (e.key === 'ArrowLeft') {
        step(-1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step]);

  // Move focus to the person heading on each advance so a screen-reader user (and the
  // aria-live region) follows the walk; reduced-motion users get an instant swap.
  useEffect(() => {
    if (count > 0) headingRef.current?.focus();
  }, [current, count]);

  const personName = (i: number): string => {
    const a = walk[i]?.assignee;
    return a ? a.name : 'Unassigned';
  };

  return (
    <div
      ref={trapRef}
      tabIndex={-1}
      className="fixed inset-0 z-40 flex flex-col bg-app-canvas focus:outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Daily standup walk-the-board"
      data-testid="standup-mode"
    >
      <Header sprint={data?.active ? data.sprint : null} onClose={onClose} />

      {isLoading ? (
        <Skeleton />
      ) : isError ? (
        <CenteredMessage
          title="Couldn't load the standup"
          body="Something went wrong fetching the walk."
        />
      ) : !data?.active ? (
        <EmptyState reason={data?.reason ?? null} projectId={projectId} />
      ) : count === 0 ? (
        <CenteredMessage
          title={`No one on this ${itl.lower} yet`}
          body="Assign cards to teammates to walk the board."
        />
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <Progress
            current={current}
            count={count}
            personName={personName}
            onJump={setIndex}
          />
          <h2
            ref={headingRef}
            tabIndex={-1}
            // This heading only ever receives PROGRAMMATIC focus (on advance), so it
            // uses :focus (not :focus-visible, which a browser may withhold on a
            // scripted focus) so the ring reliably renders (ux-review).
            className="rounded text-lg font-semibold text-neutral-text-primary focus:outline-none focus:ring-2 focus:ring-brand-primary focus:ring-offset-1"
          >
            {personName(current)}
          </h2>
          <StandupPersonCard bucket={walk[current]} onOpenTask={onOpenTask} />
          <Stepper current={current} count={count} onStep={step} />
          <Footer projectId={projectId} />
        </div>
      )}

      {/* Polite announcement of the walk position (rule 176). The teammate's NAME is
          read by the programmatic focus move to the person heading, so this region
          carries only the position to avoid a double name read (ux-review). */}
      <div className="sr-only" role="status" aria-live="polite">
        {count > 0 ? `Person ${current + 1} of ${count}` : ''}
      </div>
    </div>
  );
}

function Header({
  sprint,
  onClose,
}: {
  sprint: { name: string; goal: string; start_date: string; finish_date: string } | null;
  onClose: () => void;
}) {
  const tb = sprint ? sprintTimebox(sprint.start_date, sprint.finish_date) : null;
  const goal = sprint?.goal.trim() ?? '';
  return (
    <header className="flex items-start justify-between gap-3 border-b border-neutral-border bg-neutral-surface px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-neutral-text-primary">Standup</span>
          {sprint && (
            <span className="text-neutral-text-secondary">
              {sprint.name}
              {tb && tb.phase === 'during' && (
                <>
                  {' · '}
                  <span className="tppm-mono">
                    Day {tb.dayN} of {tb.totalDays}
                  </span>
                </>
              )}
            </span>
          )}
        </p>
        {goal !== '' && (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-neutral-text-secondary">
            <span aria-hidden="true">🎯</span>
            <span className="truncate" title={goal} aria-label={goal}>
              {goal}
            </span>
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="flex min-h-[44px] shrink-0 items-center rounded-control border border-neutral-border px-4 text-sm text-neutral-text-primary transition-colors hover:bg-neutral-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Exit standup
      </button>
    </header>
  );
}

function Progress({
  current,
  count,
  personName,
  onJump,
}: {
  current: number;
  count: number;
  personName: (i: number) => string;
  onJump: (i: number) => void;
}) {
  const dots = useMemo(() => Array.from({ length: count }, (_, i) => i), [count]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-neutral-text-secondary">
        <span className="tppm-mono">{current + 1}</span> of{' '}
        <span className="tppm-mono">{count}</span>
      </p>
      {count > 1 && (
        // A plain group of labeled jump buttons (not a tablist/radiogroup, which would
        // require roving tabindex + arrow handling the window listener already owns).
        // The active teammate is marked with aria-current; each button carries a 44px
        // hit area around a small visual dot (rule 5).
        <div className="flex flex-wrap" role="group" aria-label="Walk to a teammate">
          {dots.map((i) => (
            <button
              key={i}
              type="button"
              aria-current={i === current ? 'true' : undefined}
              aria-label={`Go to ${personName(i)}`}
              onClick={() => onJump(i)}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
            >
              <span
                aria-hidden="true"
                className={`h-3 w-3 rounded-full transition-colors ${
                  i === current
                    ? 'bg-brand-primary'
                    : 'bg-neutral-border hover:bg-neutral-text-disabled'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Stepper({
  current,
  count,
  onStep,
}: {
  current: number;
  count: number;
  onStep: (delta: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={current === 0}
        aria-label="Previous teammate"
        className="flex min-h-[44px] items-center rounded-control border border-neutral-border px-6 text-sm text-neutral-text-primary transition-colors hover:bg-neutral-surface-raised disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        ← Prev
      </button>
      <p className="text-xs text-neutral-text-secondary" aria-hidden="true">
        ← / → to walk
      </p>
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={current >= count - 1}
        aria-label="Next teammate"
        className="flex min-h-[44px] items-center rounded-control border border-neutral-border px-6 text-sm text-neutral-text-primary transition-colors hover:bg-neutral-surface-raised disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        Next →
      </button>
    </div>
  );
}

function Footer({ projectId }: { projectId: string }) {
  return (
    <p className="border-t border-neutral-border pt-3 text-xs text-neutral-text-secondary">
      Current state, person by person. For what changed overnight, see{' '}
      <Link
        to={`/projects/${projectId}/sprints`}
        className="text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
      >
        What changed since yesterday →
      </Link>
    </p>
  );
}

function EmptyState({ reason, projectId }: { reason: string | null; projectId: string }) {
  const itl = useIterationLabel();
  const continuous = reason === 'continuous_cadence';
  return (
    <CenteredMessage
      title={continuous ? 'This board runs in continuous flow' : `No active ${itl.lower} to walk`}
      body={
        continuous
          ? `Standup is a ${itl.lower} ceremony. Switch the board to ${itl.lower} cadence to run a walk-the-board standup.`
          : `Standup runs on the active ${itl.lower} — plan or activate one to begin.`
      }
      cta={
        <Link
          to={`/projects/${projectId}/sprints`}
          className="text-sm text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Go to {itl.lowerPlural} →
        </Link>
      }
    />
  );
}

function CenteredMessage({
  title,
  body,
  cta,
}: {
  title: string;
  body: string;
  cta?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
      <p className="text-lg font-semibold text-neutral-text-primary">{title}</p>
      <p className="max-w-md text-sm text-neutral-text-secondary">{body}</p>
      {cta}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-4" aria-hidden="true">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-card border border-neutral-border bg-neutral-surface p-3">
            <div className="h-4 w-2/3 rounded bg-neutral-surface-sunken" />
            <div className="mt-3 h-10 rounded bg-neutral-surface-sunken" />
            <div className="mt-2 h-10 rounded bg-neutral-surface-sunken" />
          </div>
        ))}
      </div>
    </div>
  );
}

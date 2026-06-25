/**
 * One teammate's panel in the standup walk (ADR-0166, issue 1278): three buckets — Done
 * since the last working day / In progress today / Blockers — each a calm column the
 * Scrum Master reads out loud.
 *
 * Tone is deliberately non-punitive (VoC Priya): an aging card shows a quiet "stale Nd"
 * pill, never a red full-card fill, and color is never the only cue — the text carries
 * the meaning and every icon is aria-hidden (rule 107). The private `blocked_reason` is
 * never on the wire; a blocker shows only its routable type and coarse age.
 */

import type { ReactNode } from 'react';
import { blockerTypeLabel, formatBlockedAge } from '@/lib/blocker';
import type { StandupBucket, StandupCard } from './useStandup';

interface Props {
  bucket: StandupBucket;
  onOpenTask: (taskId: string) => void;
}

export function StandupPersonCard({ bucket, onOpenTask }: Props) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" data-testid="standup-person-card">
      <Bucket title="Done since last working day" tone="done" cards={bucket.done} onOpenTask={onOpenTask} />
      <Bucket
        title="In progress today"
        tone="progress"
        cards={bucket.in_progress}
        onOpenTask={onOpenTask}
      />
      <Bucket title="Blockers" tone="blocker" cards={bucket.blockers} onOpenTask={onOpenTask} />
    </div>
  );
}

type Tone = 'done' | 'progress' | 'blocker';

const EMPTY_COPY: Record<Tone, string> = {
  done: 'Nothing completed',
  progress: 'Nothing in progress',
  blocker: 'No blockers',
};

function Bucket({
  title,
  tone,
  cards,
  onOpenTask,
}: {
  title: string;
  tone: Tone;
  cards: StandupCard[];
  onOpenTask: (taskId: string) => void;
}) {
  return (
    <section className="rounded-card border border-neutral-border bg-neutral-surface p-3">
      <h3 className="flex items-baseline justify-between text-sm font-semibold text-neutral-text-primary">
        <span>{title}</span>
        {/* Count is read by AT (not aria-hidden) so a section-navigating screen-reader
            user hears "Blockers, 2" at a glance (ux-review). */}
        <span className="tppm-mono text-xs text-neutral-text-secondary">{cards.length}</span>
      </h3>
      {cards.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-text-secondary">{EMPTY_COPY[tone]}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {cards.map((card) => (
            <li key={card.id}>
              <CardRow card={card} tone={tone} onOpenTask={onOpenTask} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CardRow({
  card,
  tone,
  onOpenTask,
}: {
  card: StandupCard;
  tone: Tone;
  onOpenTask: (taskId: string) => void;
}) {
  const points =
    card.story_points != null ? (
      <span className="tppm-mono text-xs text-neutral-text-secondary">
        {card.story_points} pt{card.story_points === 1 ? '' : 's'}
      </span>
    ) : null;

  return (
    <button
      type="button"
      onClick={() => onOpenTask(card.id)}
      data-testid="standup-card"
      className="w-full rounded-control border border-neutral-border bg-neutral-surface-sunken px-2.5 py-2 text-left transition-colors hover:border-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      <span className="flex items-center gap-1.5 text-sm text-neutral-text-primary">
        {tone === 'done' && (
          <span aria-hidden="true" className="text-semantic-on-track">
            ✓
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{card.name}</span>
        {points}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-1.5">
        {tone === 'blocker' && <BlockerChip card={card} />}
        {card.aging && tone !== 'done' && <AgingPill dwellDays={card.dwell_days} />}
      </span>
    </button>
  );
}

/** Calm "stale Nd" signal — meaning is in the text, the icon is decorative (rule 107). */
function AgingPill({ dwellDays }: { dwellDays: number | null }): ReactNode {
  const label = dwellDays != null ? `stale ${dwellDays}d` : 'stale';
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-semantic-at-risk px-1.5 py-0.5 text-xs text-semantic-at-risk">
      <span aria-hidden="true">⏳</span>
      <span className="tppm-mono">{label}</span>
    </span>
  );
}

/** Blocker triage chip: routable type + coarse age. Never the private reason text. */
function BlockerChip({ card }: { card: StandupCard }): ReactNode {
  const typeLabel = blockerTypeLabel(card.blocker_type);
  const age = card.blocked_since
    ? formatBlockedAge((Date.now() - new Date(card.blocked_since).getTime()) / 1000)
    : null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-semantic-at-risk-bg px-1.5 py-0.5 text-xs text-semantic-at-risk">
      <span aria-hidden="true">⚠</span>
      <span>{typeLabel ?? 'Blocked'}</span>
      {age && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tppm-mono">{age}</span>
        </>
      )}
    </span>
  );
}

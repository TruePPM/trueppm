import { useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  useFlagForBacklog,
  useReorderDemoList,
  useSetPresenter,
  useSetReviewNote,
  useToggleDemo,
  type ReviewShippedStory,
  type SprintOutcome,
} from '@/hooks/useSprints';
import { useIterationLabel } from '@/hooks/useIterationLabel';

interface Props {
  outcome: SprintOutcome;
  /** True when the requester is Member+ and may curate the demo list (#924). */
  canCurateDemo?: boolean;
}

const GOAL_LABEL: Record<string, string> = {
  MET: 'Met',
  PARTIAL: 'Partial',
  MISSED: 'Missed',
};

/**
 * CLOSED-state review surface (#567, ADR-0094) — the "what was done" outcome,
 * bound entirely to `GET /sprints/{id}/outcome/` (#985). Renders the 5-card
 * outcome row (goal verdict, committed/completed points, rolled-over, velocity Δ)
 * and the read-only "what didn't ship" list. The frozen burndown and retro panel
 * are rendered by the parent (existing components). Every value is server-owned;
 * nothing is derived here.
 */
export function SprintClosedOutcome({ outcome, canCurateDemo = false }: Props) {
  const c = outcome.commitment;
  const v = outcome.velocity;
  // #1097: "Rolled over" is the true carried-disposition point sum (the same source
  // the "what didn't ship" list uses), never the committed−completed proxy that
  // contradicted the list when scope was injected (drops are scope removal, not
  // rollover). Null when velocity is suppressed (points gated) or when per-task
  // disposition was never recorded (sprints closed before #982) — shown as "—"
  // rather than a derived guess, honoring render-don't-derive.
  const rolled = outcome.outcome_recorded ? outcome.didnt_ship_summary.carried_points : null;

  return (
    <div className="flex flex-col gap-4" data-testid="sprint-closed-outcome">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <OutcomeCard label="Goal">
          <GoalVerdict status={outcome.goal_outcome} />
        </OutcomeCard>
        <OutcomeCard label="Committed">
          <Pts value={c.committed_points} />
        </OutcomeCard>
        <OutcomeCard label="Completed">
          <Pts value={c.completed_points} />
          {c.completion_ratio_points != null && (
            <span className="text-xs text-neutral-text-secondary">
              {' '}
              ({Math.round(c.completion_ratio_points * 100)}%)
            </span>
          )}
        </OutcomeCard>
        <OutcomeCard label="Rolled over">
          <Pts value={rolled} />
        </OutcomeCard>
        <OutcomeCard label="Velocity Δ">
          {v && v.velocity_delta_points != null ? (
            <DeltaValue delta={v.velocity_delta_points} />
          ) : (
            <span className="text-sm text-neutral-text-secondary">—</span>
          )}
        </OutcomeCard>
      </div>

      <SprintReviewSection outcome={outcome} canCurate={canCurateDemo} />
      <MilestoneSlipLine outcome={outcome} />

      <DidntShipList outcome={outcome} />
    </div>
  );
}

/**
 * Sprint Review (#924, ADR-0118): the accepted-vs-not acceptance breakdown and the
 * shipped-stories list with a per-story demo toggle. Distinct from the retro — this
 * is Jordan's acceptance ceremony. Counts are server-owned; the demo list is the
 * subset the team flagged for the stakeholder walkthrough.
 */
function SprintReviewSection({
  outcome,
  canCurate,
}: {
  outcome: SprintOutcome;
  canCurate: boolean;
}) {
  const r = outcome.review;
  const sprintId = outcome.sprint_id;
  const toggle = useToggleDemo(sprintId);
  const reorder = useReorderDemoList(sprintId);
  const setPresenter = useSetPresenter(sprintId);
  const setNote = useSetReviewNote(sprintId);
  const flag = useFlagForBacklog(sprintId);
  const itl = useIterationLabel();

  // #1130: the demo walkthrough is the demo-flagged subset of shipped, already in
  // demo_order from the server. Reorder writes the complete demo set's new order.
  const demoStories = r.shipped.filter((s) => s.demo_ready && s.outcome_id);
  const demoIds = demoStories.map((s) => s.outcome_id as string);

  function handleDemoReorder(orderedIds: string[]) {
    reorder.mutate({ outcomeIds: orderedIds });
  }

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface" data-testid="sprint-review">
      <h3 className="px-3 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary border-b border-neutral-border">
        {itl.singular} review
      </h3>

      {/* #1129: committed-at-planning → shipped COUNT delta. Always visible — the
          team knows what it committed, so this line is NOT velocity/points-gated. */}
      <CommitmentLine commitment={r.commitment} />

      {/* Acceptance breakdown — counts always; points only when readable (ADR-0104).
          #1133: "not accepted" → "criteria incomplete", "no criteria" → "criteria
          not set" — coverage-hygiene states, not grades. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm border-b border-neutral-border">
        <span className="text-semantic-on-track font-medium" data-testid="accepted-count">
          <span aria-hidden="true">✓ </span>
          {r.accepted_count} accepted
          {r.accepted_points != null && (
            <span className="text-neutral-text-secondary font-normal"> ({r.accepted_points} pts)</span>
          )}
        </span>
        <span className="text-semantic-at-risk font-medium" data-testid="not-accepted-count">
          <span aria-hidden="true">✗ </span>
          {r.not_accepted_count} criteria incomplete
          {r.not_accepted_points != null && (
            <span className="text-neutral-text-secondary font-normal">
              {' '}
              ({r.not_accepted_points} pts)
            </span>
          )}
        </span>
        {r.no_criteria_count > 0 && (
          <span
            className="text-neutral-text-secondary"
            data-testid="no-criteria-count"
            title="Committed stories with no acceptance criteria — a coverage gap to close in refinement."
          >
            {r.no_criteria_count} criteria not set
          </span>
        )}
      </div>

      {/* Shipped stories + demo curation. */}
      {r.shipped.length === 0 ? (
        <p role="status" className="px-3 py-3 text-xs italic text-neutral-text-secondary">
          No stories shipped this {itl.lower}.
        </p>
      ) : (
        <>
          <div className="px-3 pt-2 text-xs text-neutral-text-secondary">
            Shipped ({r.shipped.length})
            {demoStories.length > 0 && (
              <> · <span aria-hidden="true">★ </span>{demoStories.length} for demo</>
            )}
            {canCurate && demoStories.length > 1 && (
              <span className="ml-2 italic">Drag the ⠿ handle to set demo order.</span>
            )}
          </div>
          {canCurate && demoStories.length > 1 ? (
            <DemoSortableList
              ids={demoIds}
              onReorder={handleDemoReorder}
              stories={r.shipped}
              renderStory={(s) => (
                <ShippedRow
                  story={s}
                  canCurate={canCurate}
                  pending={toggle.isPending}
                  sortable={s.demo_ready && !!s.outcome_id}
                  onToggle={(demoReady) =>
                    s.outcome_id && toggle.mutate({ outcomeId: s.outcome_id, demoReady })
                  }
                  onPresenter={(presenter) =>
                    s.outcome_id && setPresenter.mutate({ outcomeId: s.outcome_id, presenter })
                  }
                  onNote={(note) =>
                    s.outcome_id && setNote.mutate({ outcomeId: s.outcome_id, note })
                  }
                  onFlagForBacklog={() =>
                    s.outcome_id && flag.mutate({ outcomeId: s.outcome_id })
                  }
                />
              )}
            />
          ) : (
            <ul className="divide-y divide-neutral-border">
              {r.shipped.map((s) => (
                <ShippedRow
                  key={s.outcome_id ?? s.task_short_id}
                  story={s}
                  canCurate={canCurate}
                  pending={toggle.isPending}
                  sortable={false}
                  onToggle={(demoReady) =>
                    s.outcome_id && toggle.mutate({ outcomeId: s.outcome_id, demoReady })
                  }
                  onPresenter={(presenter) =>
                    s.outcome_id && setPresenter.mutate({ outcomeId: s.outcome_id, presenter })
                  }
                  onNote={(note) =>
                    s.outcome_id && setNote.mutate({ outcomeId: s.outcome_id, note })
                  }
                  onFlagForBacklog={() =>
                    s.outcome_id && flag.mutate({ outcomeId: s.outcome_id })
                  }
                />
              ))}
            </ul>
          )}
        </>
      )}
      {(toggle.isError || reorder.isError) && (
        <p role="alert" className="px-3 py-2 text-xs text-semantic-critical">
          Couldn&apos;t update the demo list. Please try again.
        </p>
      )}
    </div>
  );
}

/** #1129 — the committed-at-planning → shipped count line. Counts are always
 * visible (never points-gated); carried is null on a provisional sprint. */
function CommitmentLine({ commitment }: { commitment: SprintOutcome['review']['commitment'] }) {
  const { committed_count, shipped_count, carried_count } = commitment;
  if (committed_count == null) return null;
  return (
    <p
      data-testid="review-commitment-line"
      className="px-3 py-2 text-sm text-neutral-text-primary border-b border-neutral-border"
    >
      <span className="font-semibold tppm-mono">{committed_count}</span> committed →{' '}
      <span className="font-semibold tppm-mono">{shipped_count}</span> shipped
      {carried_count != null && (
        <>
          ,{' '}
          <span className="font-semibold tppm-mono">{carried_count}</span> carried over
        </>
      )}
    </p>
  );
}

/** #1130 — dnd wrapper around the shipped list; only demo-flagged rows are sortable. */
function DemoSortableList({
  ids,
  onReorder,
  stories,
  renderStory,
}: {
  ids: string[];
  onReorder: (orderedIds: string[]) => void;
  stories: ReviewShippedStory[];
  renderStory: (s: ReviewShippedStory) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(ids, oldIndex, newIndex));
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="divide-y divide-neutral-border">{stories.map((s) => renderStory(s))}</ul>
      </SortableContext>
    </DndContext>
  );
}

function ShippedRow({
  story,
  canCurate,
  pending,
  sortable,
  onToggle,
  onPresenter,
  onNote,
  onFlagForBacklog,
}: {
  story: ReviewShippedStory;
  canCurate: boolean;
  pending: boolean;
  /** True when this row participates in the demo drag-reorder (demo-flagged + curator). */
  sortable: boolean;
  onToggle: (demoReady: boolean) => void;
  onPresenter: (presenter: string) => void;
  onNote: (note: string) => void;
  onFlagForBacklog: () => void;
}) {
  const { acceptance: a } = story;
  const fullyAccepted = a.total > 0 && a.met === a.total;
  // #1131: a criteria-incomplete (has criteria, not all met) or criteria-not-set
  // (no criteria) story exposes the disclosure + optional note + add-criteria/flag.
  const criteriaIncomplete = a.total > 0 && a.met < a.total;
  const criteriaNotSet = a.total === 0;
  const [open, setOpen] = useState(false);

  // Sortable hooks are always called (rules of hooks); the handle is only wired
  // when this row is draggable.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: story.outcome_id ?? story.task_short_id,
    disabled: !sortable,
  });
  const style = sortable
    ? { transform: CSS.Transform.toString(transform), transition }
    : undefined;

  return (
    <li
      ref={sortable ? setNodeRef : undefined}
      style={style}
      className={`px-3 py-2 text-sm ${isDragging ? 'bg-neutral-surface-raised opacity-70' : ''}`}
    >
      <div className="flex items-center gap-3">
        {sortable && (
          <button
            type="button"
            aria-label={`Reorder demo: ${story.task_title}`}
            className="flex h-7 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-neutral-text-secondary hover:text-neutral-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            ⠿
          </button>
        )}
        <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
          {story.task_short_id}
        </span>
        <span className="flex-1 min-w-0 truncate text-neutral-text-primary">
          {story.task_title}
        </span>
        {/* Acceptance badge — text label, never color alone (WCAG 1.4.1). */}
        {a.total > 0 ? (
          <button
            type="button"
            onClick={() => criteriaIncomplete && setOpen((o) => !o)}
            aria-expanded={criteriaIncomplete ? open : undefined}
            disabled={!criteriaIncomplete}
            className={`text-xs shrink-0 ${fullyAccepted ? 'text-semantic-on-track' : 'text-semantic-at-risk'} ${
              criteriaIncomplete
                ? 'underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded'
                : 'cursor-default'
            }`}
            aria-label={`${a.met} of ${a.total} acceptance criteria met${fullyAccepted ? ' — accepted' : ''}${criteriaIncomplete ? ' — show incomplete criteria' : ''}`}
          >
            <span aria-hidden="true">{fullyAccepted ? '✓ ' : ''}</span>
            {a.met}/{a.total} criteria
          </button>
        ) : (
          <span
            className="text-xs text-neutral-text-disabled shrink-0"
            data-testid="criteria-not-set"
          >
            criteria not set
          </span>
        )}
        {story.story_points != null && (
          <span className="tppm-mono text-xs text-neutral-text-secondary shrink-0">
            {story.story_points} pts
          </span>
        )}
        {/* Demo toggle (Member+) — or a static marker for read-only viewers. */}
        {canCurate && story.outcome_id ? (
          <button
            type="button"
            role="switch"
            aria-checked={story.demo_ready}
            aria-label={`${story.demo_ready ? 'Remove from' : 'Add to'} demo list: ${story.task_title}`}
            disabled={pending}
            onClick={() => onToggle(!story.demo_ready)}
            className={`shrink-0 h-7 px-2 rounded text-xs font-medium border whitespace-nowrap
              disabled:opacity-50 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              ${
                story.demo_ready
                  ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
                  : 'border-neutral-border text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary'
              }`}
          >
            <span aria-hidden="true">{story.demo_ready ? '★' : '☆'} </span>Demo
          </button>
        ) : story.demo_ready ? (
          <span className="shrink-0 text-xs text-brand-primary" aria-label="In the demo list">
            <span aria-hidden="true">★ </span>Demo
          </span>
        ) : null}
      </div>

      {/* #1130: per-demo presenter input (curator only, demo-flagged). */}
      {canCurate && story.demo_ready && story.outcome_id && (
        <div className="mt-1 flex items-center gap-2 pl-16">
          <label className="text-xs text-neutral-text-secondary" htmlFor={`presenter-${story.outcome_id}`}>
            Presenter
          </label>
          <input
            id={`presenter-${story.outcome_id}`}
            type="text"
            defaultValue={story.presenter}
            maxLength={120}
            placeholder="Who's demoing this?"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next !== story.presenter) onPresenter(next);
            }}
            className="flex-1 rounded border border-neutral-border bg-transparent px-2 py-1 text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
        </div>
      )}
      {/* Read-only presenter display for non-curators. */}
      {!canCurate && story.demo_ready && story.presenter && (
        <p className="mt-1 pl-16 text-xs text-neutral-text-secondary">
          Presenter: <span className="text-neutral-text-primary">{story.presenter}</span>
        </p>
      )}

      {/* #1131: disclosure of the specific unmet criteria. */}
      {criteriaIncomplete && open && story.unmet_criteria.length > 0 && (
        <ul className="mt-1 pl-16 text-xs text-neutral-text-secondary" data-testid="unmet-criteria">
          {story.unmet_criteria.map((c) => (
            <li key={c.id} className="flex items-start gap-1">
              <span aria-hidden="true" className="text-semantic-at-risk">
                ✗
              </span>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* #1131/#1132: contributor note + add-criteria + flag-for-backlog on a
          criteria-incomplete / criteria-not-set story. All optional (Member+). */}
      {(criteriaIncomplete || criteriaNotSet) && canCurate && story.outcome_id && (
        <div className="mt-2 flex flex-col gap-2 pl-16">
          <label className="sr-only" htmlFor={`note-${story.outcome_id}`}>
            Note for reviewers
          </label>
          <textarea
            id={`note-${story.outcome_id}`}
            defaultValue={story.review_note}
            maxLength={200}
            rows={2}
            placeholder="Optional note for reviewers…"
            onBlur={(e) => {
              const next = e.target.value.slice(0, 200);
              if (next !== story.review_note) onNote(next);
            }}
            className="rounded border border-neutral-border bg-transparent px-2 py-1 text-xs text-neutral-text-primary placeholder:text-neutral-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
          />
          <div className="flex flex-wrap items-center gap-2">
            {criteriaNotSet && story.task_id && (
              <a
                href={`#/story/${story.task_id}/acceptance`}
                className="text-xs text-brand-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary rounded"
              >
                + Add criteria
              </a>
            )}
            {story.flagged_to_backlog ? (
              <span className="text-xs text-semantic-on-track" data-testid="flagged-state">
                <span aria-hidden="true">✓ </span>Flagged for backlog
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onFlagForBacklog()}
                className="h-7 rounded border border-neutral-border px-2 text-xs font-medium text-neutral-text-secondary hover:border-brand-primary hover:text-brand-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                Flag for backlog
              </button>
            )}
          </div>
        </div>
      )}
      {/* Read-only note for non-curators. */}
      {(criteriaIncomplete || criteriaNotSet) && !canCurate && story.review_note && (
        <p className="mt-1 pl-16 text-xs text-neutral-text-secondary">{story.review_note}</p>
      )}
    </li>
  );
}

/**
 * #1098 — the realized schedule consequence of this sprint, one read: pairs the
 * carried-over points (when readable) with the bound milestone's days-of-slip vs
 * baseline, so the PM never has to leave for the Schedule view to figure out the
 * cascade. All values are server-owned (`outcome.milestone_slip`); the client only
 * composes the sentence — and it does so because the velocity gate runs through the
 * middle of it (points clause is gated, the schedule clause is not).
 */
function MilestoneSlipLine({ outcome }: { outcome: SprintOutcome }) {
  const slip = outcome.milestone_slip;
  if (slip == null) return null;

  const { slip_days: days, milestone_name: name, basis } = slip;
  // Carried points are velocity-gated (null when suppressed); the schedule slip is
  // not, so the points clause degrades independently.
  const carried = outcome.outcome_recorded ? outcome.didnt_ship_summary.carried_points : null;
  const carriedClause = carried != null && carried > 0 ? `Rolled over ${carried} pts → ` : '';

  const verb = basis === 'actual' ? 'finished' : 'now';
  let slipClause: string;
  if (days > 0) {
    slipClause = basis === 'actual' ? `finished ${days}d late vs baseline` : `now +${days}d vs baseline`;
  } else if (days < 0) {
    slipClause = `${verb} ${Math.abs(days)}d ahead of baseline`;
  } else {
    slipClause = `${verb} on baseline`;
  }

  // Slip tone mirrors the AdvancingToMilestoneCard variance chip exactly: ahead =
  // on-track, on baseline = neutral, amber to ~1 work week, red beyond. `band` is
  // the same classification spelled out so the severity isn't conveyed by color
  // alone (rule 120) — a screen reader hears "at risk" / "critical", not just a hue.
  let tone: string;
  let band: string;
  if (days < 0) {
    tone = 'border-semantic-on-track/40 text-semantic-on-track';
    band = 'ahead of schedule';
  } else if (days === 0) {
    tone = 'border-neutral-border text-neutral-text-primary';
    band = 'on baseline';
  } else if (days <= 5) {
    tone = 'border-semantic-at-risk/40 text-semantic-at-risk';
    band = 'at risk';
  } else {
    tone = 'border-semantic-critical/40 text-semantic-critical';
    band = 'critical slip';
  }

  return (
    <p
      role="status"
      data-testid="milestone-slip-line"
      className={`flex items-start gap-2 rounded-md border bg-neutral-surface px-3 py-2 text-sm text-neutral-text-primary ${tone}`}
    >
      <span aria-hidden="true">◆</span>
      <span>
        {carriedClause}
        <span className="font-medium">{name}</span> {slipClause}.
        <span className="sr-only"> ({band})</span>
      </span>
    </p>
  );
}

function OutcomeCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface-raised p-3 flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary">
        {label}
      </span>
      <span className="flex items-baseline">{children}</span>
    </div>
  );
}

function Pts({ value }: { value: number | null }) {
  if (value == null) return <span className="text-sm text-neutral-text-secondary">—</span>;
  return (
    <span className="tppm-mono text-lg font-semibold text-neutral-text-primary">{value}</span>
  );
}

function GoalVerdict({ status }: { status: SprintOutcome['goal_outcome'] }) {
  if (status == null) {
    return <span className="text-sm text-neutral-text-secondary">—</span>;
  }
  const tone =
    status === 'MET'
      ? 'text-semantic-on-track'
      : status === 'PARTIAL'
        ? 'text-semantic-at-risk'
        : 'text-semantic-critical';
  const glyph = status === 'MET' ? '✓' : status === 'PARTIAL' ? '◐' : '✗';
  return (
    <span className={`text-sm font-semibold ${tone}`} aria-label={`Goal ${GOAL_LABEL[status]}`}>
      <span aria-hidden="true">{glyph} </span>
      {GOAL_LABEL[status]}
    </span>
  );
}

function DeltaValue({ delta }: { delta: number }) {
  const itl = useIterationLabel();
  // A drop in velocity is a watch-signal (amber), not an error — reserve critical
  // red for genuine failure states (rule 145).
  const tone =
    delta > 0
      ? 'text-semantic-on-track'
      : delta < 0
        ? 'text-semantic-at-risk'
        : 'text-neutral-text-primary';
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'unchanged';
  return (
    <span
      className={`tppm-mono text-lg font-semibold ${tone}`}
      aria-label={
        delta === 0
          ? `Velocity unchanged vs prior ${itl.lower}`
          : `Velocity ${direction} ${Math.abs(delta)} points vs prior ${itl.lower}`
      }
    >
      <span aria-hidden="true">{arrow} </span>
      {delta > 0 ? '+' : ''}
      {delta}
    </span>
  );
}

function DidntShipList({ outcome }: { outcome: SprintOutcome }) {
  const { didnt_ship: items, didnt_ship_summary: sum, outcome_recorded } = outcome;
  const itl = useIterationLabel();

  if (!outcome_recorded) {
    return (
      <p
        role="status"
        className="rounded-md border border-dashed border-neutral-border bg-neutral-surface p-4 text-xs text-neutral-text-secondary"
      >
        Per-task membership was not recorded for this {itl.lower} (it closed
        before membership capture shipped).
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p
        role="status"
        className="rounded-md border border-neutral-border bg-neutral-surface p-4 text-xs text-neutral-text-secondary"
      >
        <span aria-hidden="true">🎉 </span>Everything committed shipped.
      </p>
    );
  }

  return (
    <div className="rounded-md border border-neutral-border bg-neutral-surface" data-testid="didnt-ship">
      <h3 className="px-3 py-2 text-xs font-semibold tracking-widest uppercase text-neutral-text-secondary border-b border-neutral-border">
        What didn&apos;t ship ({items.length})
        {sum.carried_count > 0 && <> · {sum.carried_count} carried</>}
        {sum.dropped_count > 0 && <> · {sum.dropped_count} dropped</>}
      </h3>
      <ul className="divide-y divide-neutral-border">
        {items.map((it) => (
          <li
            key={`${it.task_short_id}-${it.task_id ?? it.task_title}`}
            className="flex items-center gap-3 px-3 py-2 text-sm"
          >
            <span className="tppm-mono text-xs text-neutral-text-secondary w-16 shrink-0">
              {it.task_short_id}
            </span>
            <span className="flex-1 min-w-0 truncate text-neutral-text-primary">
              {it.task_title}
            </span>
            {it.story_points != null && (
              <span className="tppm-mono text-xs text-neutral-text-secondary">
                {it.story_points} pts
              </span>
            )}
            <DispositionChip item={it} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function DispositionChip({ item }: { item: SprintOutcome['didnt_ship'][number] }) {
  const itl = useIterationLabel();
  if (item.disposition === 'carried') {
    return (
      <span className="text-xs text-neutral-text-secondary shrink-0">
        → {item.next_sprint_name ?? `next ${itl.lower}`}
      </span>
    );
  }
  if (item.disposition === 'dropped') {
    return <span className="text-xs text-neutral-text-secondary shrink-0">dropped</span>;
  }
  return null;
}

import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import type { EstimationScale } from '@/api/types';
import { formatRelative } from '@/lib/formatRelative';
import { NoteIcon } from '@/components/Icons';
import { formatStoryPoints, storyPointsUnit } from '@/lib/storyPoints';
import type { ProjectCustomField } from '@/hooks/useProjectCustomFields';
import { BoardProgressRing } from '../BoardProgressRing';
import { ReadinessChip } from '../ReadinessChip';
import { TypeBadge } from '@/features/project/backlog/components/TypeBadge';
import { CustomFieldMarks } from '../CustomFieldMarks';
import { phaseColor } from '../phaseColors';
import { CardBadgeRow } from './CardBadgeRow';
import { CardHealthPeek } from './CardHealthPeek';
import { cardTitleToneClass, cpTooltip } from './cardFormat';
import type { BoardCardView } from './useBoardCardView';
import { useLaneCrumb } from '../LaneCrumbContext';

/**
 * Baseline variance in calendar days between forecast finish and baseline
 * (issue 186). Positive = late. Null when the task is not baselined.
 */
function baselineVariance(task: Task): number | null {
  if (!task.baselineFinish) return null;
  return Math.round(
    (new Date(task.finish).getTime() - new Date(task.baselineFinish).getTime()) / 86_400_000,
  );
}

/**
 * Identity meta row (issue 1230) — a stream/label color tag (keyed to the card's
 * epic, or its WBS phase parent when ungrouped), the visible short id, and a
 * story-points pill. Each element is independently guarded so the row only
 * renders when the card carries that datum. The color dot is decorative
 * (aria-hidden): its meaning — which stream a card belongs to — is redundant
 * grouping, never conveyed by color alone for anything load-bearing (WCAG 1.4.1).
 */
function CardIdentityRow({
  task,
  estimationScale,
}: {
  task: Task;
  estimationScale: EstimationScale;
}) {
  const streamKey = task.parentEpic ?? task.parentId ?? null;
  const streamColor = streamKey ? phaseColor(streamKey) : null;
  // Prefer the project-qualified reference ("ENG-2026-8"), then the compact one
  // ("T-8"). Never the raw `shortId`: the stored value is zero-padded hex, so the
  // card used to read "0000000A" — an internal identifier leaking into the UI,
  // and not the project-code prefix Settings → General promises (#2430).
  const taskRef = task.qualifiedId ?? task.shortIdDisplay ?? null;
  if (streamColor === null && !taskRef && task.storyPoints == null) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1 min-w-0">
      {streamColor !== null && (
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: streamColor }}
          title="Stream"
          aria-hidden="true"
        />
      )}
      {taskRef && (
        <span
          className="tppm-mono text-xs text-neutral-text-secondary truncate"
          aria-label={`Task reference ${taskRef}`}
        >
          {taskRef}
        </span>
      )}
      {task.storyPoints != null && (
        <span
          className="ml-auto shrink-0 inline-flex items-center px-1.5 py-px rounded-chip text-xs font-semibold tppm-mono
                  bg-neutral-surface-sunken border border-neutral-border text-neutral-text-secondary"
          aria-label={`${task.storyPoints} story point${task.storyPoints === 1 ? '' : 's'}`}
        >
          {formatStoryPoints(task.storyPoints, estimationScale)}
          {storyPointsUnit(task.storyPoints, estimationScale)}
        </span>
      )}
    </div>
  );
}

/**
 * Notes freshness (ADR-0143, issue 740): when the task has a note, show how
 * recently the last one landed — a lightweight signal that there's a
 * why/decision record worth opening, without crowding compact cards.
 */
function NotesFreshness({ latestNoteAt }: { latestNoteAt: string | null | undefined }) {
  if (!latestNoteAt) return null;
  const relative = formatRelative(new Date(latestNoteAt));
  return (
    <div
      className="mt-1 inline-flex items-center gap-0.5 text-xs text-neutral-text-secondary"
      title={`Last note ${relative}`}
      aria-label={`Last note ${relative}`}
    >
      <NoteIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="tppm-mono">{relative}</span>
    </div>
  );
}

interface CardFullBodyProps {
  task: Task;
  view: BoardCardView;
  customFieldDefs?: ProjectCustomField[];
  overallocByResource?: Map<string, number>;
  onShowDeps?: (task: Task) => void;
  onShowRisks?: (task: Task) => void;
  onChainHoverEnter: () => void;
  onChainHoverLeave: () => void;
  /** Board-wide verdict from `readinessIsInformative` (#2430). */
  showReadiness?: boolean;
}

/**
 * Comfortable and detailed density body. Owns the worst-offender peek state
 * (issue 1305) because both the badge that toggles it and the chip panel it
 * reveals live inside this subtree — compact density has no peek.
 */
export function CardFullBody({
  task,
  view,
  customFieldDefs,
  overallocByResource,
  onShowDeps,
  onShowRisks,
  onChainHoverEnter,
  onChainHoverLeave,
  showReadiness = true,
}: CardFullBodyProps) {
  // Worst-offender peek (issue 1305): on touch (no hover) the primary badge toggles
  // the full chip set open; `peekOpen` keeps it open after blur/un-hover. Desktop
  // hover/focus reveal it without this flag via group-hover.
  const [peekOpen, setPeekOpen] = useState(false);
  const signalBadgeRef = useRef<HTMLButtonElement>(null);

  // Escape collapses a tap-opened peek and returns focus to its badge (issue
  // 1305) — matching the overflow menu's Escape pattern.
  useEffect(() => {
    if (!peekOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPeekOpen(false);
        signalBadgeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [peekOpen]);

  // 100%-complete nudge: the card claims done but the column says otherwise.
  const showNudge = task.progress === 100 && task.status !== 'COMPLETE';

  // The container this card actually sits in, when the lane above it names a
  // different (higher) one — see LaneCrumbContext.
  const laneCrumb = useLaneCrumb(task.id);

  return (
    <div className="pl-2.5 pr-2.5 pt-2.5 pb-2.5">
      {laneCrumb && (
        <div
          className="mb-1 text-xs text-neutral-text-secondary truncate"
          // Not aria-hidden: "which phase is this in" is the whole point of the
          // crumb, and it is the one fact the lane header cannot carry for a
          // card that lives below it.
          title={`In ${laneCrumb}`}
        >
          {laneCrumb} <span aria-hidden="true">&#9656;</span>
        </div>
      )}
      {/* Readiness chip — top-left (issue 179). Suppressed board-wide when every
          visible card shares one readiness value: a chip true of everything on
          screen conveys nothing, and it costs a line of the card's scarcest
          resource (#2430). */}
      {task.readiness && showReadiness && (
        <div className="mb-1.5">
          <ReadinessChip readiness={task.readiness} />
        </div>
      )}

      {/* Tech-debt badge (ADR-0178, issue 1076) — debt is the one type surfaced on
          the card face so a team can see remediation work at a glance; other
          types stay unbadged to keep the board calm. Neutral pill, word carries
          the meaning (rule 12). */}
      {task.taskType === 'tech_debt' && (
        <div className="mb-1.5">
          <TypeBadge type="tech_debt" />
        </div>
      )}

      {/* Priority rank — top-right, below the ··· menu */}
      {task.priorityRank !== undefined && (
        <span
          className="absolute top-2 right-8 text-xs text-neutral-text-disabled"
          aria-hidden="true"
        >
          #{task.priorityRank}
        </span>
      )}

      {/* Task name row */}
      <div className="flex items-center gap-1.5 pr-6 min-w-0">
        {!view.isIdea && (
          <BoardProgressRing
            progress={view.effectiveProgress}
            isCritical={view.showCriticalState}
            isStalled={view.isStalled}
          />
        )}
        <span
          className={[
            // line-clamp-2 (not truncate): comfortable/detailed cards wrap the
            // title to a second row so longer task names stay readable without
            // opening the card (issue #1924). Compact density keeps its
            // single-line bar.
            'text-xs font-medium line-clamp-2 min-w-0',
            cardTitleToneClass(view.showCriticalState, view.isIdea),
          ].join(' ')}
          title={view.showCriticalState ? cpTooltip(task) : task.name}
        >
          {task.name}
        </span>
      </div>

      <CardIdentityRow task={task} estimationScale={view.estimationScale} />

      <CardBadgeRow
        task={task}
        view={view}
        overallocByResource={overallocByResource}
        peekOpen={peekOpen}
        onTogglePeek={() => setPeekOpen((v) => !v)}
        signalBadgeRef={signalBadgeRef}
        onShowDeps={onShowDeps}
        onShowRisks={onShowRisks}
        onChainHoverEnter={onChainHoverEnter}
        onChainHoverLeave={onChainHoverLeave}
      />

      {/* Custom fields (#2144, web-rule 271) — lowest priority, last, hairline above.
          Comfortable: ≤3 inline + "+N more" peek; detailed: all inline. Empty → nothing. */}
      {customFieldDefs && customFieldDefs.length > 0 && (
        <CustomFieldMarks
          fields={customFieldDefs}
          values={task.customFields}
          density={view.isDetailed ? 'detailed' : 'comfortable'}
        />
      )}

      {/* Entry stamp — comfortable: only when non-empty; detailed: always when available */}
      {view.stampText && (
        <div
          className={[
            'text-xs mt-1',
            view.isStalled ? 'text-semantic-at-risk font-medium' : 'text-neutral-text-disabled',
          ].join(' ')}
        >
          {view.stampText}
        </div>
      )}

      <NotesFreshness latestNoteAt={task.latestNoteAt} />

      <CardHealthPeek
        task={task}
        view={view}
        baselineVarianceDays={baselineVariance(task)}
        peekOpen={peekOpen}
      />
      {/* end health-chip peek (issue 1305) */}

      {/* 100%-complete nudge */}
      {showNudge && (
        <div className="text-xs text-brand-primary mt-1 font-medium">Move to Done?</div>
      )}
    </div>
  );
}

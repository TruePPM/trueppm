import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@/types';
import { useUpdateTask } from '@/hooks/useTaskMutations';
import { useEffectiveDurationPolicy, useProject, useProjectHoursPerDay } from '@/hooks/useProject';
import { useIsCoarsePointer } from '@/hooks/useIsCoarsePointer';
import { PencilIcon, WarningIcon } from '@/components/Icons';
import { Button } from '@/components/Button';
import { Tooltip } from '@/components/Tooltip';
import { ABBREVIATIONS } from '@/lib/abbreviations';
import { fmtUtcShort } from '@/lib/formatUtcDate';
import { HowDatesWorkLink } from './HowDatesWorkLink';
import { parseDurationInput } from './buildMode/EditableCell';
import { DurationUnitPicker } from './duration/DurationUnitPicker';
import {
  describeEntry,
  formatDuration,
  spellDuration,
  toStoredDays,
  type DurationUnit,
} from './duration/durationUnit';
import { RecalcPercentChip } from './RecalcPercentChip';
import { buildRecalcPrompt, type RecalcPromptState } from './recalcPercentPrompt';
import { useCommitStartOrTodo } from './useCommitStartOrTodo';
import { startCommitAnnouncement, startCommitClause } from './startCommitDisclosure';
import { isMissingCommittedStart, isStartComputed } from './missingCommittedStart';

/**
 * Format an ISO date (YYYY-MM-DD) as "Mon D", omitting the year when it is the
 * current year. UTC-only arithmetic so the rendered day never drifts by a
 * timezone offset (mirrors MetaRail's formatter, which this component
 * replaces in the tabbed drawer redesign, #962).
 */
function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  const currentYear = new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getUTCFullYear() === currentYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

interface CellProps {
  label: string;
  children: ReactNode;
  /** Renders the value in the critical-path color (red) when true. */
  critical?: boolean;
  /** Hides the right divider on the last cell. */
  last?: boolean;
  /** Plain-English reading for a jargon label, surfaced on hover/focus/tap. */
  explain?: string;
}

function Cell({ label, children, critical, last, explain }: CellProps) {
  const heading = (
    <div className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
      {label}
    </div>
  );
  return (
    <div
      role="group"
      aria-label={label}
      className={['px-3.5 py-2.5', last ? '' : 'border-r border-neutral-border'].join(' ')}
    >
      {/* "Float" is scheduling jargon — a PM knows it, the team member reading
          their own task does not (rule 287). Only cells whose label is jargon
          take `explain`; "Start" and "Finish" say what they mean. */}
      {explain ? <Tooltip content={explain}>{heading}</Tooltip> : heading}
      <div
        className={[
          'tppm-mono text-sm font-semibold',
          critical ? 'text-semantic-critical' : 'text-neutral-text-primary',
        ].join(' ')}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Whether the Duration cell's "Nd left" qualifier (ADR-0752 §9) has something
 * to say: an in-progress, not-yet-complete task whose remaining work has
 * shrunk below its full estimate. False for a milestone (no duration to
 * qualify), a not-started task (remaining === duration, nothing consumed
 * yet), and a complete task (remaining is inert once work is done).
 */
function shouldShowRemainingChip(task: Task): boolean {
  return (
    !task.isMilestone &&
    !task.isComplete &&
    typeof task.remainingDuration === 'number' &&
    task.remainingDuration !== task.duration
  );
}

/** Pull the server's `{duration: [...]}` validation message off a failed PATCH. */
function extractDurationError(err: unknown): string | null {
  const data = (err as { response?: { data?: { duration?: unknown } } })?.response?.data;
  const d = data?.duration;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0];
  if (typeof d === 'string') return d;
  return null;
}

interface DurationCellProps {
  /** Current committed duration in working days. */
  days: number;
  /**
   * Working days of remaining work (ADR-0752), or `null` to render no "Nd
   * left" qualifier — the caller ({@link shouldShowRemainingChip}) decides
   * whether the divergence is worth showing.
   */
  remainingDays: number | null;
  /** Always-visible pencil affordance on touch (no hover to reveal it). */
  showPencilAlways: boolean;
  /** Commit a parsed, changed duration. */
  onCommit: (days: number) => void;
  /** A client-side parse failure — the caller surfaces the inline message. */
  onParseError: () => void;
  /** Clear any prior inline error (on edit entry / valid commit). */
  onClearError: () => void;
  /** Unit this task is authored in (#2975). Presentation only. */
  unit: DurationUnit;
  /** The project calendar's hours per working day — governs the conversion. */
  hoursPerDay: number | null | undefined;
  /** Persist a unit change. */
  onUnitChange: (unit: DurationUnit) => void;
}

/**
 * The editable Duration cell (#2106, ADR-0515). At rest it is a button that
 * visually matches the read-only vitals cells but carries a dashed underline —
 * the calm, always-present "this one's editable" cue on a strip that is
 * otherwise read-only. Click / Enter / Space / F2 enters an inline numeric
 * input; Enter or blur commits (reusing `parseDurationInput`, so "2w" still
 * works for desktop power users), Esc cancels. The commit is INSTANT (the caller
 * PATCHes immediately) because Start/Finish/Float are server-computed and only
 * meaningful after the CPM recompute — a staged duration would leave them stale.
 */
function DurationCell({
  days,
  remainingDays,
  showPencilAlways,
  onCommit,
  onParseError,
  onClearError,
  unit,
  hoursPerDay,
  onUnitChange,
}: DurationCellProps) {
  // The rounding notice from the last hours entry — cleared on the next edit.
  // It has to persist past the commit, because the whole point is telling the
  // user what got stored *instead of* what they typed (#2975).
  const [roundingNote, setRoundingNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(days));
  const [flash, setFlash] = useState<'commit' | 'error' | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const prevEditingRef = useRef(false);
  // Set when Enter/Esc exit — focus returns to the at-rest button. A blur/Tab
  // exit leaves it unset so focus follows the natural tab order.
  const focusButtonRef = useRef(false);
  // Set on Enter/Esc so the unmount-triggered blur doesn't re-run the commit.
  const skipNextBlurRef = useRef(false);

  // Reseed the draft when the committed value changes from outside (WS/CPM).
  useEffect(() => {
    if (!editing) setDraft(String(days));
  }, [days, editing]);

  // Focus + select on entering edit mode; return focus to the button on an
  // Enter/Esc exit (never drop focus to <body>, WCAG 2.4.3).
  useEffect(() => {
    if (editing && !prevEditingRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (!editing && prevEditingRef.current && focusButtonRef.current) {
      focusButtonRef.current = false;
      buttonRef.current?.focus();
    }
    prevEditingRef.current = editing;
  }, [editing]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), flash === 'commit' ? 400 : 600);
    return () => clearTimeout(t);
  }, [flash]);

  const startEdit = () => {
    onClearError();
    setDraft(String(days));
    setEditing(true);
  };

  const commit = (raw: string, viaBlur: boolean) => {
    // An explicit `d` or `w` suffix always wins over the picker — a power user
    // who types "2w" means two weeks whichever unit the cell is showing. A bare
    // number is read in the cell's own unit (#2975).
    const explicitUnit = /[dw]\s*$/i.test(raw.trim());
    const bare = Number(raw.trim());
    const parsed =
      unit === 'hours' && !explicitUnit && Number.isFinite(bare) && bare >= 0
        ? toStoredDays(bare, 'hours', hoursPerDay).days
        : parseDurationInput(raw);
    if (parsed === null) {
      onParseError();
      setFlash('error');
      // On blur we cannot hold an open input — revert to the committed value.
      // On Enter we stay in edit mode so the user can fix the input (rule 225).
      if (viaBlur) {
        setDraft(String(days));
        setEditing(false);
      }
      return;
    }
    onClearError();
    // Say what got stored when it is not what was typed. Silence here is the
    // thing that makes a planner stop trusting every other number on screen.
    if (unit === 'hours' && !explicitUnit && Number.isFinite(bare)) {
      setRoundingNote(describeEntry(toStoredDays(bare, 'hours', hoursPerDay), 'hours'));
    } else {
      setRoundingNote(null);
    }
    if (parsed !== days) {
      onCommit(parsed);
      setFlash('commit');
    }
    setEditing(false);
  };

  // The wrapper is the grid item and owns the cell's right divider; the inner
  // value area owns the padding. Bottom padding is light because the picker row
  // below supplies the cell's own `pb-2.5` (keeping both would double the gap).
  const cellWrapper = 'flex flex-col min-w-0 border-r border-neutral-border';
  const cellBase = 'px-3.5 pt-2.5 pb-1.5 min-h-11';

  // Rendered by BOTH branches at the same child index, so React reconciles it to
  // ONE persistent DOM node across the rest<->edit swap. That is load-bearing,
  // not tidiness: the input's `onBlur` commits and leaves edit mode, and blur
  // fires on mousedown — so a picker that unmounted with the branch would be
  // torn out between mousedown and mouseup, no `click` would fire, and clicking
  // `h` while editing would silently do nothing.
  //
  // Rendering it in edit mode is also what keeps the cell one height in both
  // states. Stacked (#3211), an edit-mode cell without it collapsed the vitals
  // strip by 35px and re-expanded on commit, jumping every section below.
  const unitPickerRow = (
    <div className="px-3.5 pb-2.5 flex flex-col gap-1 items-start min-w-0">
      <DurationUnitPicker value={unit} onChange={onUnitChange} />
      {roundingNote && (
        // role=status, not an error: the value was accepted, it just is not the
        // number that was typed, and the user is owed that fact.
        <p role="status" className="text-xs text-neutral-text-secondary max-w-[210px]">
          {roundingNote}
        </p>
      )}
    </div>
  );
  const flashClass =
    flash === 'commit'
      ? 'bg-semantic-on-track-bg'
      : flash === 'error'
        ? 'bg-semantic-critical-bg'
        : '';

  if (editing) {
    return (
      <div className={[cellWrapper, flashClass].join(' ')}>
        <div role="group" aria-label="Duration" className={cellBase}>
          <div className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
            Duration
          </div>
          <div className="flex items-baseline gap-0.5">
            <input
              ref={inputRef}
              value={draft}
              inputMode="numeric"
              aria-label={unit === 'hours' ? 'Duration in hours' : 'Duration in days'}
              className="tppm-mono text-sm font-semibold w-12 bg-neutral-surface text-neutral-text-primary
              px-1 rounded-sm outline-none border border-brand-primary
              focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1
              focus-visible:ring-offset-neutral-surface"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                if (skipNextBlurRef.current) {
                  skipNextBlurRef.current = false;
                  return;
                }
                commit(draft, true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  skipNextBlurRef.current = true;
                  focusButtonRef.current = true;
                  commit(draft, false);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  skipNextBlurRef.current = true;
                  focusButtonRef.current = true;
                  onClearError();
                  setDraft(String(days));
                  setEditing(false);
                }
              }}
            />
            <span
              className="tppm-mono text-sm font-semibold text-neutral-text-secondary"
              aria-hidden="true"
            >
              {unit === 'hours' ? 'h' : 'd'}
            </span>
          </div>
        </div>
        {unitPickerRow}
      </div>
    );
  }

  // ADR-0752 §9: remaining work is a qualifier on Duration, not a fifth cell.
  // The button already carries the accessible name via `aria-label` (which
  // suppresses its subtree from name computation), so the remaining-days fact
  // is folded directly into that string rather than an sr-only child span,
  // which this button would silently ignore. The visible "Nd left" chip below
  // is therefore purely decorative (`aria-hidden`, with a native `title` for a
  // sighted mouse-hover explanation) rather than the shared `Tooltip` component
  // the read-only strip's equivalent chip uses — nesting Tooltip's own focusable
  // trigger inside this button would be a second tab stop inside one control,
  // which the read-only variant (a plain, non-interactive `Cell`) doesn't have
  // to avoid.
  const remainingSuffix =
    remainingDays !== null ? `, ${remainingDays} ${remainingDays === 1 ? 'day' : 'days'} left` : '';

  return (
    // The unit picker stacks BELOW the value, never beside it (#3211). This
    // wrapper is the grid item, and Tailwind's `grid-cols-4` sizes the *track*
    // `minmax(0, 1fr)` while the item keeps `min-width: auto` — so an item wider
    // than its track overflows into the next cell instead of shrinking, with no
    // clipping to make it visible. Side by side, this cell's min-content was the
    // button (95.6px: the "Duration" label plus `px-3.5`) + `gap-2` + the
    // `shrink-0` 66px picker = 169.6px against a 126.25px track in the 540px
    // drawer, and the 43px of overflow painted straight over the Float cell's
    // label and value. Stacked, the cell's min-content is just the button, which
    // fits at every width the strip is rendered at.
    <div className={[cellWrapper, flashClass].join(' ')}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Duration, ${spellDuration(days, unit, hoursPerDay)}${remainingSuffix}. Edit.`}
        className={[
          'group relative flex flex-col items-start text-left w-full cursor-text',
          'transition-colors hover:bg-neutral-surface-sunken',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
          'focus-visible:ring-offset-1 focus-visible:ring-offset-neutral-surface',
          cellBase,
        ].join(' ')}
        onClick={startEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'F2') {
            e.preventDefault();
            startEdit();
          }
        }}
      >
        <span className="text-xs tracking-wider uppercase text-neutral-text-secondary mb-0.5">
          Duration
        </span>
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span
            className="tppm-mono text-sm font-semibold text-neutral-text-primary
            border-b border-dashed border-neutral-border group-hover:border-brand-primary"
          >
            {formatDuration(days, unit, hoursPerDay)}
          </span>
          {remainingDays !== null && (
            <span
              aria-hidden="true"
              title={`${remainingDays} working ${remainingDays === 1 ? 'day' : 'days'} of work remaining, of the estimate shown`}
              className="rounded-chip px-1 py-px text-xs leading-tight tracking-wider uppercase bg-semantic-at-risk-bg text-semantic-at-risk"
            >
              {remainingDays}d left
            </span>
          )}
        </span>
        <PencilIcon
          aria-hidden="true"
          className={[
            'absolute top-2 right-2 h-3 w-3 text-neutral-text-secondary transition-opacity',
            // Faintly persistent at rest so a mouse user sees the cell is editable
            // without hovering (the whole point of #2106); full-strength on
            // hover/focus, and always-on for touch (no hover to reveal it).
            showPencilAlways
              ? 'opacity-100'
              : 'opacity-40 group-hover:opacity-100 group-focus-visible:opacity-100',
          ].join(' ')}
        />
      </button>
      {unitPickerRow}
    </div>
  );
}

/**
 * The Start value when it is CPM-computed rather than PM-committed (#2314/#2379,
 * ADR-0603, web-rule 276).
 *
 * Two cues, because neither alone reaches every user: a **dotted** underline —
 * deliberately not the dashed underline that means "editable" on
 * {@link DurationCell} — and the design's visible `computed` qualifier chip.
 * The chip is what a sighted pointer-free user gets: the previous `title`-only
 * treatment was unreachable on touch (web-rules 22a/121), so the cell still read
 * as a committed date and silently contradicted the advisory below it.
 *
 * The chip is `aria-hidden` and the fuller sr-only qualifier is retained
 * (web-rule 216): "computed" is already carried accessibly, so announcing the
 * chip too would double-read it, and "(computed, not committed)" is the clearer
 * phrasing for a screen-reader user than a bare "computed".
 *
 * The value wraps (`flex-wrap`) rather than clipping — at the 480px drawer width
 * a 4-across grid cell cannot hold the date and the chip on one line.
 */
function ComputedStartValue({ iso }: { iso: string }) {
  return (
    <span
      className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
      title="Auto-calculated by the scheduler (CPM) — not a committed start."
    >
      <span className="border-b border-dotted border-neutral-text-disabled">{formatDate(iso)}</span>
      <span
        aria-hidden="true"
        className="rounded-chip px-1 py-px text-xs leading-tight tracking-wider uppercase bg-semantic-at-risk-bg text-semantic-at-risk"
      >
        computed
      </span>
      <span className="sr-only"> (computed, not committed)</span>
    </span>
  );
}

/**
 * The "Nd left" qualifier on the Duration cell (ADR-0752 §9). Remaining work
 * is a *property of* the duration, not a fifth vitals cell: web-rule 284 (a
 * value renders once per surface, and this strip is the read surface for the
 * Start/Finish SPAN) plus the remaining window being subordinate to the
 * duration it is carved out of is what makes qualifying the Duration cell —
 * rather than adding a cell — the right call.
 *
 * Reuses the rule-276 qualifier-chip treatment ({@link ComputedStartValue}
 * above) rather than inventing a new one: `aria-hidden` with an sr-only long
 * form. Also carries a shared `Tooltip` (rule 287) — "1d left" is shorthand,
 * and shorthand does not ship with a bare `title`.
 *
 * Rendered only when it says something the duration alone doesn't: an
 * in-progress, not-yet-complete task whose remaining work has actually
 * shrunk below its full estimate.
 */
function RemainingDurationChip({ remaining }: { remaining: number }) {
  const unit = remaining === 1 ? 'day' : 'days';
  return (
    <>
      <Tooltip content={`${remaining} working ${unit} of work remaining, of the estimate shown`}>
        <span
          aria-hidden="true"
          className="rounded-chip px-1 py-px text-xs leading-tight tracking-wider uppercase bg-semantic-at-risk-bg text-semantic-at-risk"
        >
          {remaining}d left
        </span>
      </Tooltip>
      <span className="sr-only">
        {' '}
        ({remaining} {unit} of work remaining)
      </span>
    </>
  );
}

/**
 * Pure render of the bordered vitals frame — Start · Finish · {duration slot} ·
 * Float, plus an optional below-grid slot (inline error / recalc prompt) and the
 * critical-path banner. Calls no data hooks, so the read-only strip stays
 * provider-free; the editable variant supplies its own `durationCell`/`belowGrid`.
 */
function StripFrame({
  task,
  durationCell,
  belowGrid,
  startComputed = false,
}: {
  task: Task;
  durationCell: ReactNode | null;
  belowGrid?: ReactNode;
  /**
   * The Start value is CPM-computed, not a committed date (#2314) — render it
   * with the computed cue so this cell stops silently contradicting the
   * "no committed start" advisory below it.
   */
  startComputed?: boolean;
}) {
  const hasSchedule = Boolean(task.start);
  const float = task.totalFloat;
  const dash = <span className="text-neutral-text-disabled font-normal">—</span>;

  return (
    <div className="rounded-card border border-neutral-border overflow-hidden">
      <div className={['grid', task.isMilestone ? 'grid-cols-2' : 'grid-cols-4'].join(' ')}>
        <Cell label={task.isMilestone ? 'Date' : 'Start'}>
          {hasSchedule ? (
            startComputed ? (
              <ComputedStartValue iso={task.start} />
            ) : (
              formatDate(task.start)
            )
          ) : (
            dash
          )}
        </Cell>

        {!task.isMilestone && (
          <Cell label="Finish">{hasSchedule ? formatDate(task.finish) : dash}</Cell>
        )}

        {durationCell}

        {/* Float is a computed metric, not a flag (#2424): it has a home here, beside
            the other server-computed schedule values, and carries the same `computed`
            qualifier the Start cell uses (web-rule 276) so it never reads as editable.
            Negative float is the one value that IS an exception — it turns the cell
            critical and raises a real flag in the drawer's FLAGS band. */}
        <Cell
          label="Float"
          critical={task.isCritical || (typeof float === 'number' && float < 0)}
          last
          explain={ABBREVIATIONS.FLOAT}
        >
          {float === null || float === undefined ? (
            dash
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1">
              {/* `CP` was explained by a native `title` only — invisible to keyboard
                  focus and unreachable on touch, which is exactly the population
                  least likely to already know the term (#2389, rule 287). The
                  tooltip is attached only in the critical case, matching the
                  conditional `title` it replaces: on a non-critical task there is
                  no `CP` on screen and nothing to decode. */}
              {task.isCritical ? (
                <Tooltip content={ABBREVIATIONS.CRITICAL}>
                  <span className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1">
                    {float}d · CP
                  </span>
                </Tooltip>
              ) : (
                <span>{float}d</span>
              )}
              <span
                className="rounded-chip px-1 py-px text-xs uppercase bg-neutral-surface-sunken text-neutral-text-secondary font-normal"
                aria-hidden="true"
              >
                computed
              </span>
              <span className="sr-only"> (computed)</span>
            </span>
          )}
        </Cell>
      </div>

      {belowGrid}

      {task.isCritical && (
        <div className="flex items-center gap-2 px-3.5 py-2 border-t border-neutral-border bg-semantic-critical-bg text-xs text-semantic-critical">
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full bg-semantic-critical shrink-0"
          />
          <span>On the critical path — zero float. Slipping this moves the project finish.</span>
        </div>
      )}
    </div>
  );
}

/**
 * The "no committed start" advisory (#2314, ADR-0603) — the drawer's secondary
 * home for the same flag the Schedule row chip carries (the chip is the primary
 * point-of-fix, #2313). Rendered in the editable strip's `belowGrid` when the
 * task is flagged, so a user already inspecting the task isn't left at a dead end.
 *
 * `role="status"` (advisory tone, web-rule 138 — not `alert`) with the amber
 * rule-8b token set. It reuses the shared {@link useCommitStartOrTodo} handlers,
 * so the two remediations — Set committed start / Move to To Do — commit
 * instantly (web-rule 217 carve-out) and are offline-guarded (rule 29) exactly
 * as the chip does; the write path is never duplicated. Only mounted inside
 * `EditableStrip`, so the caller is already an editor (no `canEdit` re-gate).
 */
function NoCommittedStartAdvisory({
  task,
  projectId,
  onAnnounce,
}: {
  task: Task;
  projectId: string;
  onAnnounce: (sentence: string) => void;
}) {
  const { commitStart, moveToTodo, error } = useCommitStartOrTodo(task, projectId, {
    onCommitted: (iso) => onAnnounce(`Committed start set to ${fmtUtcShort(iso)}.`),
    onMovedToTodo: () => onAnnounce('Moved to To Do.'),
  });
  const startLabel = task.start
    ? `Set committed start (${fmtUtcShort(task.start)})`
    : 'Set committed start';

  return (
    <div
      role="status"
      className="px-3.5 py-2.5 border-t border-semantic-at-risk/80 bg-semantic-at-risk-bg text-xs text-semantic-at-risk"
    >
      <div className="flex items-start gap-2">
        <WarningIcon className="h-4 w-4 shrink-0 mt-px" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">No committed start</p>
          <p className="mt-0.5 leading-relaxed text-neutral-text-primary">
            Start and Finish here are auto-calculated by the scheduler (CPM). This task has no
            committed start, so these dates will shift whenever a predecessor moves.
          </p>
          {error && (
            <p role="alert" className="mt-1 font-medium text-semantic-critical">
              {error}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={commitStart}>
              {startLabel}
            </Button>
            <Button variant="ghost" size="sm" onClick={moveToTodo}>
              Move to To Do
            </Button>
          </div>
          {/* Same docs deep-link the row chip carries (#2484) — the two surfaces
              flag one condition, so they must offer one explanation. The divider
              takes the at-risk hue at low alpha here because this advisory sits
              on the `-bg` tint, where a neutral rule would read as a seam. */}
          <div className="mt-2 border-t border-semantic-at-risk/30 pt-1.5">
            <HowDatesWorkLink />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The uncommitted-start note (#3063) — the calm counterpart to
 * {@link NoCommittedStartAdvisory}.
 *
 * Fires when the Start on display is CPM-computed but the task has *not* reached
 * IN_PROGRESS, which is the state that fills the Unscheduled gutter: no bar on
 * the timeline, no explanation anywhere in the drawer. The dotted `computed` cue
 * on the Start cell says the date is not committed; this says what follows from
 * that — the row is not on the timeline, and here is the one action that puts it
 * there.
 *
 * It carries one condition the cue does not: `!sprintId`. The two answer different
 * questions and must not be fused (the mistake this issue is about, made one level
 * down). *Is this date computed?* is about provenance and is true of a sprint-
 * assigned task too — its start is floored to the sprint window by CPM (ADR-0168),
 * not committed by a PM. *Is this row missing from the timeline?* is about the
 * canvas, and there a sprint IS a commitment: `drawTaskBar` gates on
 * `!plannedStart && !sprintId`, so a sprint-assigned task draws a bar and
 * `useUnscheduledTasks` correctly leaves it out of the gutter. Telling that user
 * the task is "not on the timeline" would be false, and offering to commit a start
 * would invite them to overwrite the sprint floor.
 *
 * Deliberately **not** the amber advisory. That treatment marks a data-integrity
 * defect (work reported underway against dates nobody committed) and offers
 * "Move to To Do" as the demotion out of it. An uncommitted NOT_STARTED task is
 * not a defect — it is ordinary unplanned work, it is already in To Do, and the
 * demotion would be a no-op. Scolding it in at-risk amber would train the user to
 * ignore the color that means something on the other branch (web-rules 8b/12).
 *
 * The commit reuses {@link useCommitStartOrTodo}, so the write path stays single.
 * One behavior worth knowing: unlike the IN_PROGRESS case the hook was written
 * for, committing a start `<= today` on a NOT_STARTED task DOES trip the server's
 * date-gated auto-promote to IN_PROGRESS (`_apply_date_gated_start_transition`,
 * #336), back-stamping `actual_start` for a past date. That is not a surprise
 * introduced here — it is exactly what dragging the same chip out of the gutter
 * onto the timeline already does, and the two paths must not disagree.
 */
function UncommittedStartNote({
  task,
  projectId,
  onAnnounce,
}: {
  task: Task;
  projectId: string;
  onAnnounce: (sentence: string) => void;
}) {
  // The server's date, not the browser's — the promote is gated on Django's
  // `timezone.localdate()`, and the two disagree exactly at the boundary where the
  // answer matters (#3075). Undefined until the project query resolves, which
  // `startCommitClause` treats as "say nothing" rather than "nothing will happen".
  const { data: project } = useProject(projectId);
  const statusBefore = task.status;
  const { commitStart, error, isPending } = useCommitStartOrTodo(task, projectId, {
    onCommitted: (iso, statusAfter) =>
      onAnnounce(startCommitAnnouncement(fmtUtcShort(iso), statusBefore, statusAfter)),
  });
  const clause = startCommitClause(task.start, project?.server_date);
  // One string for the visible label and the accessible name, so a screen-reader user
  // and a sighted user are told the same thing about the same button (rule 8b).
  const commitLabel = `Set committed start (${fmtUtcShort(task.start)})${
    clause ? ` — ${clause}` : ''
  }`;

  return (
    <div
      role="status"
      className="px-3.5 py-2.5 border-t border-neutral-border bg-neutral-surface-sunken text-xs"
    >
      <p className="font-semibold text-neutral-text-primary">Not on the timeline</p>
      <p className="mt-0.5 leading-relaxed text-neutral-text-secondary">
        Start and Finish are auto-calculated by the scheduler (CPM), so they shift whenever a
        predecessor moves. Commit a start to place this task on the timeline.
      </p>
      {error && (
        <p role="alert" className="mt-1 font-medium text-semantic-critical">
          {error}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={commitStart}
          disabled={isPending}
          aria-label={commitLabel}
        >
          {commitLabel}
        </Button>
      </div>
      <div className="mt-2 border-t border-neutral-border pt-1.5">
        <HowDatesWorkLink />
      </div>
    </div>
  );
}

/**
 * Editable variant of the strip (#2106, ADR-0515). Owns the mutation, the
 * ADR-0151 recalc-% prompt, and the inline error/announce state; only mounted
 * for a non-milestone task the user can edit, so all data hooks live here and
 * the read-only path never needs a QueryClient.
 */
function EditableStrip({
  task,
  projectId,
  hoursPerDay,
}: {
  task: Task;
  projectId: string;
  hoursPerDay?: number;
}) {
  const updateTask = useUpdateTask();
  const policy = useEffectiveDurationPolicy(projectId);
  // The entry path converts hours through the project calendar (#3042, completing
  // #2975). Resolved here rather than passed down because this component is the
  // one that is guaranteed a QueryClient: the read-only strip above renders in
  // print layouts and harnesses that have none, which is why the prop exists at
  // all. An explicit prop still wins, so a caller that already holds the rate can
  // supply it without a second fetch.
  const projectHoursPerDay = useProjectHoursPerDay(projectId);
  const rate = hoursPerDay ?? projectHoursPerDay;
  const isCoarse = useIsCoarsePointer();
  const durationUnit: DurationUnit = task.durationUnit ?? 'days';
  const onDurationUnitChange = (unit: DurationUnit) => {
    // Presentation only — no CPM recompute, so this is safe to send on its own
    // and safe offline in a way a duration change is not.
    updateTask.mutate({ id: task.id, projectId, duration_unit: unit });
  };

  const [recalcPrompt, setRecalcPrompt] = useState<RecalcPromptState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState('');

  const commitDuration = (newDays: number) => {
    // Scheduling changes need the server (CPM recompute), so guard offline
    // rather than optimistically queue a change we cannot recompute (rule 29).
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setError("You're offline — reconnect to change duration.");
      return;
    }
    const oldDuration = task.duration;
    const oldPercent = task.progress;
    setError(null);
    updateTask.mutate(
      { id: task.id, projectId, duration: newDays },
      {
        onSuccess: () => {
          setLive(
            `Duration set to ${newDays} ${newDays === 1 ? 'day' : 'days'}. Schedule updated.`,
          );
          // The recalc-% prompt is a post-commit follow-up (ADR-0151): only build
          // it once the edit actually landed, so a rejected edit never prompts.
          setRecalcPrompt(
            buildRecalcPrompt({
              taskId: task.id,
              policy,
              oldPercent,
              oldDuration,
              newDuration: newDays,
              suppressed: isCoarse,
            }),
          );
        },
        onError: (err) => {
          // The optimistic patch is already rolled back by the hook; surface the
          // server span-cap message (#1862) inline rather than a silent failure.
          setError(extractDurationError(err) ?? 'Could not update the duration.');
        },
      },
    );
  };

  const belowGrid = (
    <>
      {isMissingCommittedStart(task) ? (
        <NoCommittedStartAdvisory task={task} projectId={projectId} onAnnounce={setLive} />
      ) : (
        isStartComputed(task) &&
        !task.sprintId && (
          <UncommittedStartNote task={task} projectId={projectId} onAnnounce={setLive} />
        )
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center px-3.5 py-2 border-t border-neutral-border
            bg-semantic-critical-bg text-xs text-semantic-critical"
        >
          {error}
        </div>
      )}

      {recalcPrompt && recalcPrompt.taskId === task.id && (
        <div className="px-3.5 py-2 border-t border-neutral-border">
          <RecalcPercentChip
            prompt={recalcPrompt}
            onAccept={async (percent) => {
              await updateTask.mutateAsync({ id: task.id, projectId, percent_complete: percent });
            }}
            onDismiss={() => setRecalcPrompt(null)}
          />
        </div>
      )}
    </>
  );

  return (
    <div aria-label="Schedule" role="group">
      <StripFrame
        task={task}
        startComputed={isStartComputed(task)}
        durationCell={
          <DurationCell
            days={task.duration}
            remainingDays={
              shouldShowRemainingChip(task) ? (task.remainingDuration as number) : null
            }
            showPencilAlways={isCoarse}
            onCommit={commitDuration}
            onParseError={() => setError('Enter a whole number of days (e.g. 10).')}
            onClearError={() => setError(null)}
            unit={durationUnit}
            hoursPerDay={rate}
            onUnitChange={onDurationUnitChange}
          />
        }
        belowGrid={belowGrid}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>
    </div>
  );
}

/**
 * The schedule "vitals" strip at the top of the Details tab — Start, Finish,
 * Duration, Float in a bordered 4-up grid, with a plain-English critical-path
 * banner when the task is on the critical path (web-rule 49). Replaces the
 * sticky left meta rail from the pre-#962 drawer.
 *
 * Milestones (ADR-0058) relabel Start → "Date" and suppress Finish/Duration —
 * a milestone is a single point in time with no span.
 *
 * When `projectId` + `canEdit` are supplied for a non-milestone task, the
 * Duration cell becomes inline-editable (#2106, ADR-0515): an instant PATCH that
 * lets the strip refresh to the recomputed Start/Finish/Float, honoring the
 * ADR-0151 duration-change percent policy. Absent either prop the strip is the
 * original read-only grid.
 */
export function TaskScheduleStrip({
  task,
  projectId,
  canEdit,
  hoursPerDay,
}: {
  task: Task;
  projectId?: string;
  canEdit?: boolean;
  /**
   * The project calendar's hours per working day, for rendering and entering an
   * hours-unit duration (#2975). Passed in rather than fetched: this component
   * renders in contexts with no QueryClientProvider (print layouts, overlays,
   * several harnesses), so a query here breaks them. Omitted falls back to 8.
   */
  hoursPerDay?: number;
}) {
  // Read-only path renders the duration in the task's own unit too (#2975) — a
  // value that changed unit when you gained edit rights would be a worse bug
  // than not having the unit at all.
  //
  // It deliberately does NOT fetch the calendar. This component is rendered in
  // contexts without a QueryClientProvider (print layouts, overlays, several
  // test harnesses), and adding a query here breaks all of them. Hours therefore
  // render at the 8h default in the read-only strip; the editable strip, which
  // always lives under a provider, uses the project's real hours_per_day.
  const durationUnit: DurationUnit = task.durationUnit ?? 'days';

  if (canEdit && projectId && !task.isMilestone) {
    return <EditableStrip task={task} projectId={projectId} hoursPerDay={hoursPerDay} />;
  }

  return (
    <div aria-label="Schedule" role="group">
      <StripFrame
        task={task}
        // The computed-Start cue is a drawer treatment scoped to non-milestones
        // (#2314); a milestone's "Date" is a single committed point, not a
        // CPM-computed span endpoint. The editable path is already non-milestone.
        startComputed={isStartComputed(task) && !task.isMilestone}
        durationCell={
          task.isMilestone ? null : (
            <Cell label="Duration">
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span>{formatDuration(task.duration, durationUnit, hoursPerDay)}</span>
                {shouldShowRemainingChip(task) && (
                  <RemainingDurationChip remaining={task.remainingDuration as number} />
                )}
              </span>
            </Cell>
          )
        }
      />
    </div>
  );
}

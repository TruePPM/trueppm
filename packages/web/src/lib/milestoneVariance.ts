/**
 * Shared CPM annotation for the milestone rollup variance chip (#551).
 *
 * The variance chip on milestone rows previously showed only the sprint-plan
 * slip vs the milestone date (`+3d slip` / `-2d ahead`). That number is
 * decorative for a CPM-aware PM without the schedule context: a 3-day slip on a
 * milestone with 8 days of float is fine; the same slip on a *critical*
 * milestone is a phone call to the subcontractor. This helper annotates the
 * slip with the CPM float remaining (or critical-path status) and — crucially —
 * derives the color band from slip-vs-float rather than slip magnitude, so all
 * three rollup surfaces (AdvancingToMilestoneCard, Gantt TaskListRow,
 * OverviewSection) share one truth.
 *
 * `isCritical` / `totalFloat` are already computed by the CPM engine and exposed
 * on TaskSerializer (`is_critical` / `total_float`) — this consumes them, no new
 * API. The copy convention (`Nd float`, `· critical path`) matches the existing
 * TaskDrawerHeader float row.
 */

/** Semantic color band; each surface maps this to its own class chrome. */
export type MilestoneVarianceTone = 'critical' | 'at-risk' | 'on-track' | 'neutral';

export interface MilestoneVarianceInput {
  /**
   * Sprint-plan variance vs the milestone date, in calendar days. Positive =
   * slip past the milestone, negative = ahead, 0 = on time, null = unknown
   * (no live sprint or no CPM date).
   */
  varianceDays: number | null;
  /**
   * CPM total float in working days (`task.totalFloat`). Null/undefined until
   * the scheduler has run — then the annotation falls back to slip magnitude.
   */
  totalFloatDays?: number | null;
  /** Whether the milestone is on the CPM critical path (`task.isCritical`). */
  onCriticalPath?: boolean | null;
}

export interface MilestoneVarianceAnnotation {
  tone: MilestoneVarianceTone;
  /**
   * Visible suffix appended after the slip text, e.g. `critical path` or
   * `3d float`. Null when there is no CPM data to annotate (scheduler not run
   * and not on the critical path).
   */
  annotation: string | null;
  /**
   * Screen-reader phrasing of {@link annotation}, e.g. `on the critical path`
   * or `3 days of float remaining`. Null when {@link annotation} is null.
   */
  ariaAnnotation: string | null;
}

/**
 * Compute the tone + CPM annotation for a milestone variance chip.
 *
 * Precedence, matching the acceptance criteria:
 *   1. On the critical path → always `critical` tone + `critical path`, whatever
 *      the slip magnitude (a critical milestone has no float to absorb a slip).
 *   2. Off the critical path with known float → `on-track` when ahead, else
 *      `critical` when the slip exceeds the float and `at-risk` when it fits.
 *   3. Off the critical path without float (scheduler not run) → the pre-#551
 *      magnitude band (≤5d amber, else red), with no float suffix.
 */
export function milestoneVarianceAnnotation({
  varianceDays,
  totalFloatDays,
  onCriticalPath,
}: MilestoneVarianceInput): MilestoneVarianceAnnotation {
  // (1) Critical-path override — red regardless of slip magnitude.
  if (onCriticalPath) {
    return {
      tone: 'critical',
      annotation: 'critical path',
      ariaAnnotation: 'on the critical path',
    };
  }

  const hasFloat = totalFloatDays != null;

  let tone: MilestoneVarianceTone;
  if (varianceDays == null || varianceDays === 0) {
    tone = 'neutral';
  } else if (varianceDays < 0) {
    // Ahead of the milestone → green.
    tone = 'on-track';
  } else if (totalFloatDays != null) {
    // (2) Slip vs float: red when the slip exceeds available float, amber when absorbed.
    tone = varianceDays > totalFloatDays ? 'critical' : 'at-risk';
  } else {
    // (3) No CPM float to compare against — fall back to the pre-#551 magnitude band.
    tone = varianceDays <= 5 ? 'at-risk' : 'critical';
  }

  return {
    tone,
    annotation: hasFloat ? `${totalFloatDays}d float` : null,
    ariaAnnotation: hasFloat
      ? `${totalFloatDays} ${Math.abs(totalFloatDays) === 1 ? 'day' : 'days'} of float remaining`
      : null,
  };
}

/** Tone → text-only color class (Gantt cell + Overview block). */
export function varianceToneTextClass(tone: MilestoneVarianceTone): string {
  switch (tone) {
    case 'critical':
      return 'text-semantic-critical';
    case 'at-risk':
      return 'text-semantic-at-risk';
    case 'on-track':
      return 'text-semantic-on-track';
    case 'neutral':
      return 'text-neutral-text-secondary';
  }
}

/** Tone → bordered-pill class (AdvancingToMilestoneCard chip). */
export function varianceToneChipClass(tone: MilestoneVarianceTone): string {
  switch (tone) {
    case 'critical':
      return 'border-semantic-critical/40 text-semantic-critical';
    case 'at-risk':
      return 'border-semantic-at-risk/40 text-semantic-at-risk';
    case 'on-track':
      return 'border-semantic-on-track/40 text-semantic-on-track';
    case 'neutral':
      return 'border-neutral-border text-neutral-text-primary';
  }
}

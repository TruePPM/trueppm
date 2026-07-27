import type { Task } from '@/types';
import { severityRagBand } from '@/hooks/useTaskDependencies';

/**
 * Get initials from a full name — at most two chars.
 */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Format the dwell line and compute dwell time.
 * Returns daysAgo for use by the SLA aging indicator (issue 192).
 *
 * The line used to read `Entered at 100% · 42d ago`, which was not parseable
 * without knowing the data model (#2430): "entered" referred to the *column*, the
 * percentage was the task's *current* progress rather than its progress on entry,
 * and "42d ago" dated an event the reader could not name. Three facts, none of
 * them stated.
 *
 * It now reads in outcome language — `42d in this column · 60% done` — leading
 * with the fact the board is actually for (how long this has sat where it is) and
 * naming the percentage. "This column" rather than the status name: the column
 * header is directly above the card, so the reference is unambiguous and needs no
 * extra data threaded in.
 *
 * The progress clause is omitted at 0% (nothing to report) and at 100% (a card
 * that is done says so by sitting in Done; "100% done" is a tautology there).
 */
export function entryStamp(task: Task): {
  text: string;
  isStalled: boolean;
  daysAgo: number | null;
} {
  if (!task.statusEnteredAt) {
    return { text: '', isStalled: false, daysAgo: null };
  }

  // dwell + the stalled verdict are server-owned (issue 992, ADR-0115): the API returns
  // dwell_days (the raw fact) and is_stalled (the verdict). Fall back to a client
  // derivation only for tasks not carrying the server fields yet (legacy fixtures /
  // optimistic rows) so the stamp never blanks mid-migration.
  const enteredMs = new Date(task.statusEnteredAt).getTime();
  const derivedDays = Math.floor((Date.now() - enteredMs) / 86_400_000);
  const daysAgo = task.dwellDays ?? derivedDays;
  // "today" rather than "0d": a card that landed this morning has not spent a
  // measurable span here, and "0d in this column" reads like a broken counter.
  const dwellLabel =
    daysAgo === 0 ? 'Moved here today' : `${daysAgo}d in this column`;

  // COMPLETE implies 100% regardless of the stored progress value, so the
  // dwell line matches the column it lives in.  Stalled is also a no-op on
  // DONE — a card sitting in DONE for weeks isn't "stalled," it's finished.
  const effectiveProgress = task.status === 'COMPLETE' ? 100 : task.progress;
  const isStalled =
    task.isStalled ?? (task.status !== 'COMPLETE' && daysAgo > 3 && effectiveProgress < 100);

  const progressClause =
    effectiveProgress > 0 && effectiveProgress < 100 ? ` · ${effectiveProgress}% done` : '';

  return {
    text: `${dwellLabel}${progressClause}${isStalled ? ' — stalled' : ''}`,
    isStalled,
    daysAgo,
  };
}

/**
 * Does the readiness chip carry any signal across this set of cards? (#2430)
 *
 * Readiness is a *comparative* signal: it earns its line of scarce card height
 * only by distinguishing one card from another. On a board where every task is
 * `baselined` — the steady state of any project past planning — a `baselined`
 * chip on every card is pure noise, and it is the least actionable of the four
 * states (rule 107). So the chip renders only once the board holds more than one
 * distinct readiness value.
 *
 * Decided board-wide rather than per card, and applied upstream in `BoardView`
 * (mirroring how `customFieldDefs` is gated, web-rule 271) so the card itself
 * stays unaware of board-view state.
 *
 * Summary rows are excluded: they are structure, not work, and a lone
 * differently-ready summary must not resurrect the chip on every leaf card.
 *
 * @param tasks The board's committed (visible) task set.
 * @returns True when at least two distinct readiness values are present.
 */
export function readinessIsInformative(
  tasks: ReadonlyArray<Pick<Task, 'readiness' | 'isSummary'>>,
): boolean {
  const seen = new Set<string>();
  for (const t of tasks) {
    if (t.isSummary) continue;
    if (!t.readiness) continue;
    seen.add(t.readiness);
    // Two distinct values is all it takes — stop scanning a 500-card board.
    if (seen.size > 1) return true;
  }
  return false;
}

/** Format a currency value compactly (e.g. 125000 → "$125K"). */
export function fmtCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

// Left accent bar color per readiness state (issue 179).
// CP (critical) overrides all; at-risk overrides estimated/ready/baselined.
// `showCriticalState` gates the red CP override so backlog/uncommitted tasks
// don't display scheduled-state styling (issue 332).
export function accentBarClass(task: Task, showCriticalState: boolean): string {
  if (showCriticalState) return 'bg-semantic-critical';
  const r = task.readiness ?? 'estimated';
  switch (r) {
    case 'idea':
      return 'bg-transparent';
    case 'baselined':
      return 'bg-semantic-on-track';
    default:
      return 'bg-brand-primary';
  }
}

/** Tooltip text for a critical-path task (issue 181 / WCAG 1.4.1). */
export function cpTooltip(_task: Task): string {
  return 'On critical path — any delay here will delay the project end date';
}

// Chip tone (bg + border + text) for the inline risk signal chip — maps the
// 5-tier severity register down to a 3-tier RAG palette (ADR-0035 §Q2; full
// breakdown lives in the RiskPopover for color-blind safety), matching the
// float/SPI chip tone patterns so the in-flow signal chips read as one
// calm family.
export function riskChipToneClass(severity: number | null | undefined): string {
  const band = severityRagBand(severity);
  switch (band) {
    case 'red':
      return 'bg-semantic-critical-bg border-semantic-critical/30 text-semantic-critical';
    case 'amber':
      return 'bg-brand-accent/10 border-brand-accent/30 text-brand-accent-dark';
    case 'green':
      return 'bg-semantic-on-track-bg border-semantic-on-track/30 text-semantic-on-track';
    default:
      return 'bg-neutral-surface-sunken border-neutral-border text-neutral-text-secondary';
  }
}

/** Title text/tone classes shared by the compact bar and the wrapped title. */
export function cardTitleToneClass(showCriticalState: boolean, isIdea: boolean): string {
  if (showCriticalState) return 'text-semantic-critical font-semibold';
  if (isIdea) return 'text-neutral-text-disabled italic';
  return 'text-neutral-text-primary';
}

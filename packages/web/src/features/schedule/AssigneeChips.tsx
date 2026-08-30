import type { TaskAssignee } from '@/types';

export type AssigneeChipsSize = 'sm' | 'md';

interface AssigneeChipsProps {
  assignees: TaskAssignee[];
  /** 'sm' = 16 px circles (default — inline next to task name). 'md' = 24 px (Owner column). */
  size?: AssigneeChipsSize;
  /** Max chips to render before collapsing to a "+N" overflow. Default 2. */
  max?: number;
}

function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The single owner of the units→percent conversion. Rule 328: "a fact with three
 * phrasings has no owner" — before #3154 `Math.round(units * 100)` was written out
 * three times in this file alone, and a fourth surface (the Owner gridcell's
 * accessible name) simply omitted the number rather than restating it. Everything
 * that states an allocation now derives from here.
 */
function unitsPercent(units: number): number {
  return Math.round(units * 100);
}

/** `Alice Chen (50%)` — the one phrasing of "who, and how much of them". */
export function chipTitle(a: TaskAssignee): string {
  return `${a.name} (${unitsPercent(a.units)}%)`;
}

/**
 * The visible allocation run drawn beside the md chips: `100%`, `100/50%`.
 * Positional — the numbers are in chip order, so the nth number belongs to the
 * nth chip. One trailing `%` rather than one per number, because the Owner
 * column is 72 px by default and every character has to earn its width.
 */
function formatUnitsRun(assignees: TaskAssignee[]): string {
  return `${assignees.map((a) => unitsPercent(a.units)).join('/')}%`;
}

/**
 * Accessible name for the Schedule outline's Owner gridcell.
 *
 * The units belong in the *name* because they are reachable nowhere else by
 * assistive tech: every chip is `aria-hidden` (they are decorative duplicates of
 * this name) and so is the visible run, so the gridcell's name is the only
 * channel that carries allocation — and it must carry it exactly once
 * (rule 328's second corollary: announcing it twice makes a 40-row plan read as
 * 80 facts).
 */
export function formatOwnerCellLabel(assignees: TaskAssignee[]): string {
  if (assignees.length === 0) return 'Owner: none';
  return `Owner: ${assignees.map(chipTitle).join(', ')}`;
}

const SIZE_CLASSES: Record<AssigneeChipsSize, string> = {
  sm: 'h-4 w-4 text-xs',
  // 24 px circle, 11 px initials, white halo border to separate overlapping chips.
  md: 'h-6 w-6 text-xs border-2 border-neutral-surface',
};

export function AssigneeChips({
  assignees,
  size = 'sm',
  max = 2,
}: AssigneeChipsProps) {
  if (assignees.length === 0) return null;

  const visible = assignees.slice(0, max);
  const overflow = assignees.length - max;
  const sizeClass = SIZE_CLASSES[size];
  // Overlap on 2nd+ at md size only — sm stays gapped to keep dense rows readable.
  const overlapClass = size === 'md' ? '-ml-2 first:ml-0' : '';

  return (
    <span
      // md drops `shrink-0` so the allocation run below can absorb the overflow and
      // ellipsize inside the fixed-width Owner cell; the chips keep their own
      // `shrink-0` so they never compress. sm is unchanged.
      className={
        size === 'md'
          ? 'flex min-w-0 items-center gap-0.5'
          : 'flex shrink-0 items-center gap-0.5'
      }
      title={size === 'md' ? assignees.map(chipTitle).join(', ') : undefined}
    >
      {visible.map((a) => (
        <span
          key={a.resourceId}
          className={[
            'flex shrink-0 items-center justify-center rounded-full bg-brand-primary/20 font-medium text-neutral-text-primary',
            sizeClass,
            overlapClass,
          ].join(' ')}
          title={size === 'sm' ? chipTitle(a) : undefined}
          aria-hidden="true"
        >
          {getInitials(a.name)}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className={[
            'flex shrink-0 items-center justify-center rounded-full bg-brand-primary/20 font-medium text-neutral-text-primary',
            sizeClass,
            overlapClass,
          ].join(' ')}
          title={
            size === 'sm'
              ? assignees
                  .slice(max)
                  .map((a) => a.name)
                  .join(', ')
              : undefined
          }
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}
      {/* Allocation, stated at rest (#3154). It used to live only in the wrapper's
          `title`, which is nothing to a touch user and nothing to a screen reader —
          rule 328(b), "a fact stated only in a `title` or an `aria-label` is not
          stated". `aria-hidden` because the gridcell's name already carries it.
          `truncate` rather than a smaller cap: at 72 px the column fits one
          assignee's number, and a clipped run with an ellipsis reads as incomplete
          where a silently shortened one would read as a different, wrong number
          (the Links column settled this same question in #3023). The column is
          user-resizable, so widening it is the recovery. */}
      {size === 'md' && (
        <span
          // `text-xs` is the type floor (rule 50) — the 10 px this would rather be
          // is a settings-only dispensation (rule 118), and shrinking the number
          // to buy column width is exactly the trade the floor exists to refuse.
          // `leading-none` keeps the 24 px chip, not this label, the row's height.
          className="ml-1 min-w-0 truncate text-xs font-medium leading-none tabular-nums text-neutral-text-secondary"
          aria-hidden="true"
        >
          {formatUnitsRun(visible)}
        </span>
      )}
    </span>
  );
}

import { UserPlusIcon } from '@/components/Icons';
import { STATUS_GLYPH } from './StatusChip';

/** The three Pass 2 avatar sizes, in px: dense rows, default rows, people cards. */
export type AvatarSize = 22 | 28 | 36;

const SIZE_CLASS: Record<AvatarSize, string> = {
  22: 'h-[22px] w-[22px] text-xs',
  28: 'h-7 w-7 text-xs',
  36: 'h-9 w-9 text-[13px]',
};

const CIRCLE = 'inline-flex shrink-0 items-center justify-center rounded-full font-semibold';

/** Initials from a display name: first letter of the first two words, upper-cased. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

export interface AvatarProps {
  /** The person's display name — the avatar's accessible name. */
  name: string;
  size?: AvatarSize;
  /**
   * Load as a percentage when the person is over-allocated (> 100). Renders the
   * amber glyph plus the number beside the circle — the number is the message,
   * so it is printed, never left to a color ring.
   */
  overAllocatedPct?: number;
  /**
   * Set when the person's name is already printed next to the avatar: the
   * circle then hides from assistive tech instead of saying the name twice.
   */
  decorative?: boolean;
}

/**
 * A Pass 2 avatar (rule 439): initials on `surface-3`, 22 / 28 / 36px.
 *
 * Text-1 on surface-3 keeps 4.5:1 in both themes (`p1Tokens.test.ts`), which is
 * why the fill is a surface step and not a per-person hue: a hashed palette has
 * no contrast guarantee and carries no meaning.
 */
export function Avatar({ name, size = 28, overAllocatedPct, decorative = false }: AvatarProps) {
  const circle = (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      title={name}
      className={`${CIRCLE} ${SIZE_CLASS[size]} bg-p1-surface-3 text-p1-text-1 ring-2 ring-p1-surface-1`}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
    </span>
  );
  if (overAllocatedPct === undefined || overAllocatedPct <= 100) return circle;
  return (
    <span className="inline-flex items-center gap-1">
      {circle}
      <span
        data-testid="avatar-over-allocated"
        className="inline-flex items-center gap-0.5 font-mono text-xs font-semibold tabular-nums text-p1-risk-text"
      >
        <span aria-hidden="true">{STATUS_GLYPH.risk}</span>
        <span className="sr-only">over-allocated, </span>
        {Math.round(overAllocatedPct)}%
      </span>
    </span>
  );
}

/**
 * The unassigned slot: a dashed ring with a user-plus icon. Static by default;
 * wrap it in the caller's own button when it opens an assignee picker.
 */
export function UnassignedAvatar({ size = 28 }: { size?: AvatarSize }) {
  return (
    <span
      role="img"
      aria-label="Unassigned"
      className={`${CIRCLE} ${SIZE_CLASS[size]} border border-dashed border-p1-text-3 text-p1-text-2`}
    >
      <UserPlusIcon aria-hidden="true" className="h-3.5 w-3.5" />
    </span>
  );
}

export interface AvatarStackProps {
  people: ReadonlyArray<{ name: string }>;
  size?: AvatarSize;
}

/** At most three faces, then a "+N". */
const STACK_MAX = 3;

/**
 * Overlapping avatars, capped at three plus a "+N" count (rule 439). The count
 * reads "N more people" to a screen reader — a bare "+2" is announced as
 * "plus two", which says nothing about what was counted. An empty list renders
 * the unassigned slot so "nobody" is visible rather than a gap.
 */
export function AvatarStack({ people, size = 28 }: AvatarStackProps) {
  if (people.length === 0) return <UnassignedAvatar size={size} />;
  const shown = people.slice(0, STACK_MAX);
  const rest = people.length - shown.length;
  return (
    <span data-testid="avatar-stack" className="inline-flex items-center -space-x-1.5">
      {shown.map((p, i) => (
        <Avatar key={`${p.name}-${i}`} name={p.name} size={size} />
      ))}
      {rest > 0 && (
        <span
          className={`${CIRCLE} ${SIZE_CLASS[size]} bg-p1-surface-2 font-mono tabular-nums text-p1-text-2 ring-2 ring-p1-surface-1`}
        >
          <span aria-hidden="true">+{rest}</span>
          <span className="sr-only">
            {rest} more {rest === 1 ? 'person' : 'people'}
          </span>
        </span>
      )}
    </span>
  );
}

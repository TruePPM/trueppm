import type { Program } from '@/api/types';
import { contrastText } from './programColor';

type Size = 'sm' | 'md' | 'lg';

interface Props {
  /** Only the identity fields are needed — never thread a whole row's data. */
  program: Pick<Program, 'color' | 'code' | 'name'>;
  size: Size;
  /**
   * Render up to 3 chars (program code, else name initials) inside the tile.
   * Only the `lg` tile is at or above the `text-xs` type floor, so this is
   * ignored at `sm`/`md` — a tile that cannot hold legible type carries none.
   */
  showLabel?: boolean;
  /**
   * Optional dimension override (e.g. `h-10 w-10` for the overview header).
   * Never pass color here — the accent comes from `program.color` through the
   * `style` prop (web-rule 10); the palette lives in `programColor.ts`.
   */
  className?: string;
}

// sm/md are pure wayfinding dots (no label); lg is the only tile wide enough to
// hold type at the `text-xs` floor, so it is the only one that carries initials.
//
// There used to be an `xs-label` variant here: a 16px tile with a `text-[7px]`
// label, added so uncolored programs stayed distinguishable in the dense rail
// list (issue 1051). 7px is below the rule-50 floor everywhere — including the
// settings density carve-out, whose floor is 10px — and two glyphs at 7px inside
// a 16px square are not read, they are guessed at. Both call sites already render
// the program NAME as adjacent text, so the letters were never the distinguishing
// signal they were added to be; the variant is now `md`, a label-free dot (#3475).
const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-2.5 w-2.5 rounded-chip',
  md: 'h-4 w-4 rounded-chip',
  lg: 'h-9 w-9 rounded-chip text-xs font-bold',
};

/**
 * Up to 3 chars for the identity tile: program code if set, else name initials.
 * Defensive against a missing name (the program may still be loading), so a
 * caller never crashes a header render on an in-flight program.
 */
function squareLabel(program: Pick<Program, 'code' | 'name'>): string {
  if (program.code) return program.code.slice(0, 3).toUpperCase();
  const parts = (program.name ?? '').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * The single shared renderer for a program's accent color (#963).
 *
 * Governing rule (do not violate): **shape encodes the signal type, color is
 * the value.** This rounded SQUARE always means program *identity*; project
 * health is a separate CIRCLE dot. Keeping the two shapes distinct is the
 * firewall that stops an accent hue (even green) from ever reading as a status.
 *
 * This is the ONLY place `program.color` renders going forward. Dynamic color
 * goes through the `style` prop, so no hex literal appears here. When `color`
 * is unset — the common case — the tile is a faint FILLED neutral square:
 * never a hollow outline, never health-tinted.
 *
 * Always `aria-hidden`: the marker is decorative. The caller is responsible for
 * the program name being present as adjacent text or in the row's aria-label.
 */
export function ProgramIdentitySquare({ program, size, showLabel = false, className }: Props) {
  const color = program.color;
  // Only the lg tile shows initials, and only when asked. sm/md stay label-free
  // wayfinding dots: neither is wide enough for type at the rule-50 floor, and
  // shrinking the type to fit is the thing rule 50 prohibits.
  const label = size === 'lg' && showLabel ? squareLabel(program) : null;
  return (
    <span
      aria-hidden="true"
      className={[
        'tppm-mono inline-flex shrink-0 items-center justify-center leading-none',
        SIZE_CLASS[size],
        color ? '' : 'bg-neutral-surface-sunken text-neutral-text-secondary',
        className ?? '',
      ].join(' ')}
      style={color ? { backgroundColor: color, color: contrastText(color) } : undefined}
    >
      {label}
    </span>
  );
}

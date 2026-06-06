import type { Program } from '@/api/types';
import { contrastText } from './programColor';

type Size = 'sm' | 'md' | 'lg';

interface Props {
  /** Only the identity fields are needed — never thread a whole row's data. */
  program: Pick<Program, 'color' | 'code' | 'name'>;
  size: Size;
  /**
   * Render up to 3 chars (program code, else name initials) inside the tile.
   * Only the `lg` tile has room, so this is ignored at `sm`/`md`.
   */
  showLabel?: boolean;
  /**
   * Optional dimension override (e.g. `h-10 w-10` for the overview header).
   * Never pass color here — the accent comes from `program.color` through the
   * `style` prop (web-rule 10); the palette lives in `programColor.ts`.
   */
  className?: string;
}

// sm/md are pure wayfinding dots (no label); only lg carries initials.
const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-2.5 w-2.5 rounded-sm',
  md: 'h-4 w-4 rounded-sm',
  lg: 'h-9 w-9 rounded-md text-xs font-bold',
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
  // Only the lg tile has room for the label.
  const label = showLabel && size === 'lg' ? squareLabel(program) : null;
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

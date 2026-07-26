/**
 * The one pin toggle (#2390, ADR-0627).
 *
 * Before this it existed twice, byte-similar, in `Sidebar` and `ProgramCard`.
 * Six surfaces would have made it six, so it is promoted here and owns
 * everything a caller would otherwise have to remember: the mutation, both
 * toasts, the offline guard, the in-flight lockout, and the full ARIA wiring.
 * Callers pass identity and placement — nothing else.
 *
 * **What a pin is.** A private, per-user wayfinding shortcut. It is visible to
 * nobody else, it grants no access, and it says nothing about the pinned item.
 * Not the same concept as the thumbtack `PinIcon` used for notes, attachments,
 * and mobile-nav views — those are *shared*. Different glyph, different meaning.
 */
import { useRef, type MouseEvent } from 'react';
import { useTogglePin, type PinKind } from '@/hooks/usePins';
import { toast } from '@/components/Toast';

export interface PinToggleProps {
  kind: PinKind;
  id: string;
  /** Display name — used verbatim in the aria-label and both toasts. */
  name: string;
  pinned: boolean;
  /**
   * Placement preset — decides box size, glyph size, and reveal behavior.
   * - `rail`   sidebar rows: 44px with negative margins so the row height is
   *            unchanged, 13px glyph, hover-reveal above `md`
   * - `row`    list rows and cards: 44px, 15px glyph, hover-reveal above `md`
   * - `header` page headers: 44px shrinking to 28px at `md:`, always visible —
   *            a header has no row to hover
   */
  placement: 'rail' | 'row' | 'header';
  /** Positioning only (e.g. ProgramCard's absolute corner placement). */
  className?: string;
}

const BASE =
  'flex shrink-0 items-center justify-center rounded-control ' +
  'focus:outline-none focus:ring-2 focus:ring-brand-primary';

// `focus:` not `focus-visible:` — this is a standalone action button, and
// `focus-visible:` withholds the ring on pointer-driven focus in Firefox and
// desktop Safari. `focus:opacity-100` is separate from the ring and load-bearing:
// it is what makes a hover-revealed control visible once a keyboard user reaches
// it. `max-md:opacity-100` is the touch escape — `:hover` never fires on touch,
// so without it an unpinned toggle is invisible and unreachable on a phone.
const REVEAL =
  'opacity-0 max-md:opacity-100 group-hover:opacity-100 focus:opacity-100 aria-pressed:opacity-100';

const PLACEMENT: Record<PinToggleProps['placement'], { box: string; glyph: number }> = {
  rail: { box: `${BASE} -my-2 -mr-1 h-11 w-11 ${REVEAL}`, glyph: 13 },
  row: { box: `${BASE} h-11 w-11 hover:bg-neutral-surface-raised ${REVEAL}`, glyph: 15 },
  // Never `sm:` — that fires at 375px, still a phone, and would drop the target
  // below 44px exactly where it is needed.
  header: {
    box: `${BASE} h-11 w-11 md:h-7 md:w-7 hover:bg-neutral-surface-raised`,
    glyph: 15,
  },
};

export function PinToggle({ kind, id, name, pinned, placement, className }: PinToggleProps) {
  const togglePin = useTogglePin();
  const inFlightRef = useRef(false);
  const { box, glyph } = PLACEMENT[placement];

  const handleClick = (e: MouseEvent) => {
    // The rail row and the program card are both links; a pin must not navigate.
    e.stopPropagation();
    e.preventDefault();

    if (!navigator.onLine) {
      // A pin is not part of the offline sync delta, so it cannot be queued.
      // Disable and say so rather than borrowing "pending sync" vocabulary for
      // something that is not pending.
      toast.info("You're offline — pins can't be changed right now.");
      return;
    }
    // ~200ms lockout on this target only. Cheaper and less disruptive than
    // `disabled`, which would yank focus mid-interaction and freeze aria-pressed.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    togglePin.mutate(
      { kind, id, name, next: !pinned },
      { onSettled: () => (inFlightRef.current = false) },
    );
  };

  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      aria-pressed={pinned}
      aria-busy={togglePin.isPending || undefined}
      // aria-disabled, not the `disabled` attribute: a disabled button leaves
      // the tab order and can no longer explain why it is inert.
      aria-disabled={offline || undefined}
      title={offline ? "You're offline — pins can't be changed right now." : pinned ? 'Unpin' : 'Pin'}
      className={`${box} ${offline ? 'opacity-60' : ''} ${className ?? ''}`}
    >
      <PinStar filled={pinned} size={glyph} rail={placement === 'rail'} />
    </button>
  );
}

/**
 * Five-point star — the per-user pin.
 *
 * State is carried by **shape** (filled vs outline), **ink weight** (primary vs
 * secondary), and **words** (`aria-pressed` plus the label flipping Pin↔Unpin) —
 * never by hue. The pinned fill deliberately does *not* use
 * `semantic-at-risk`: amber is a reserved health hue, and on the Project
 * Overview header a filled amber star would sit a few hundred pixels from an
 * amber "At risk" chip and read as a status. A pin is not a status.
 */
function PinStar({ filled, size, rail }: { filled: boolean; size: number; rail: boolean }) {
  const ink = rail
    ? filled
      ? 'text-chrome-text-primary'
      : 'text-chrome-text-secondary'
    : filled
      ? 'text-neutral-text-primary'
      : 'text-neutral-text-secondary';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
      className={ink}
    >
      <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.8 4.2 13.3l.7-4.3-3.1-3 4.3-.6L8 1.5z" />
    </svg>
  );
}

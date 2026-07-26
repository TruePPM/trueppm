/**
 * The one pin toggle (#2390, ADR-0627).
 *
 * Before this it existed twice, byte-similar, in `Sidebar` and `ProgramCard`.
 * Six surfaces would have made it six, so it is promoted here and owns
 * everything a caller would otherwise have to remember: the mutation, both
 * toasts, the offline guard, the in-flight lockout, the reveal behavior, and
 * the full ARIA wiring. Callers pass identity plus a size/tone recipe — never
 * behavior.
 *
 * **What a pin is.** A private, per-user wayfinding shortcut. It is visible to
 * nobody else, it grants no access, and it says nothing about the pinned item.
 * Not the same concept as the thumbtack `PinIcon` used for notes, attachments,
 * and mobile-nav views — those are *shared* curation any Member+ can toggle.
 * Different glyph (map pin vs thumbtack), different meaning.
 */
import { useRef, useState, type MouseEvent } from 'react';
import { useTogglePin, type PinKind } from '@/hooks/usePins';
import { toast } from '@/components/Toast';

export type PinToggleSize = 'sm' | 'md' | 'lg';

export interface PinToggleProps {
  kind: PinKind;
  id: string;
  /** Display name — used verbatim in the aria-label and every toast. */
  name: string;
  pinned: boolean;
  /**
   * Visual recipe. The *hit* area is 44px at every size — `sm` shrinks only the
   * painted plate and restores the target with a pseudo-element.
   * - `sm` 36px plate / 16px glyph — rails and dense table rows
   * - `md` 44px plate / 18px glyph — default, cards
   * - `lg` 44px plate / 20px glyph — page headers
   */
  size?: PinToggleSize;
  /**
   * - `auto` (default) hover-reveal on fine pointers; always rendered at 60% on
   *   coarse pointers. Used inside rows and cards, which have a hover target.
   * - `always` full strength at rest. Used on page headers, where there is
   *   exactly one of these and no row to hover.
   */
  reveal?: 'auto' | 'always';
  /** `chrome` for the dark sidebar rail, `surface` (default) for page content. */
  tone?: 'surface' | 'chrome';
  /**
   * Supplied by list surfaces that hold their row order steady across a pin, so
   * a freshly-pinned row does not leap out from under the pointer. When present,
   * the confirmation toast offers "Re-sort now" — the deferred move, on demand —
   * instead of "Undo".
   */
  onResort?: () => void;
  /** Positioning only (e.g. ProgramCard's absolute corner placement). */
  className?: string;
}

// `focus:` not `focus-visible:` — this is a standalone action button, and
// `focus-visible:` withholds the ring on pointer-driven focus in Firefox and
// desktop Safari. `ring-inset` is load-bearing, not cosmetic: a 44px control
// sitting in a 36px dense row would clip an outset ring against the row edge.
const BASE =
  'relative flex shrink-0 items-center justify-center rounded-control ' +
  'transition-[color,opacity] duration-fast ease-brand ' +
  'focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-primary';

const SIZE: Record<PinToggleSize, { box: string; glyph: number }> = {
  // 36px plate + a 4px pseudo-element bleed on every edge = a 44px target
  // (rule 211 / #2207). `min-w` would have grown the plate and reflowed the row.
  sm: { box: "h-9 w-9 before:absolute before:inset-[-4px] before:content-['']", glyph: 16 },
  md: { box: 'h-11 w-11', glyph: 18 },
  lg: { box: 'h-11 w-11', glyph: 20 },
};

/**
 * Reveal is a **pointer-capability** behavior, not a breakpoint.
 *
 * The bug this replaces: reveal was `md:`-gated, so a tablet or a touch laptop —
 * both wider than `md`, neither able to fire `:hover` — rendered an unpinned
 * toggle at `opacity-0`. On those devices a *first* pin could not be created at
 * all, only found by a lucky tap on an invisible 44px box.
 *
 * Four rules, in the design's order:
 *  1. Pinned is always visible — a pin you cannot see is a pin you cannot undo.
 *     Branching in JS rather than leaning on `aria-pressed:` keeps this immune
 *     to Tailwind's variant-ordering, where two equal-specificity rules would
 *     otherwise race.
 *  2. Unpinned + coarse pointer → 60%, always rendered. Not 100%: a dozen
 *     fully-lit pins out-shout the project names they sit beside.
 *  3. Unpinned + fine pointer → revealed on row hover, and on focus regardless.
 *  4. Never `display:none` — reveal is opacity only, so the control keeps its
 *     box, its tab order, and its screen-reader presence at all times.
 */
function revealClasses(pinned: boolean, reveal: 'auto' | 'always'): string {
  if (pinned || reveal === 'always') return 'opacity-100';
  return (
    'opacity-0 group-hover:opacity-100 focus:opacity-100 ' +
    '[@media(hover:none)]:opacity-60 [@media(pointer:coarse)]:opacity-60'
  );
}

export function PinToggle({
  kind,
  id,
  name,
  pinned,
  size = 'md',
  reveal = 'auto',
  tone = 'surface',
  onResort,
  className,
}: PinToggleProps) {
  const togglePin = useTogglePin();
  const inFlightRef = useRef(false);
  const [popping, setPopping] = useState(false);
  const { box, glyph } = SIZE[size];

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
    // Pop on create only. The flip is optimistic, so this fires with the visual
    // change rather than after the round-trip. Assigning both ways (rather than
    // only setting it true) also clears a stale pop: under prefers-reduced-motion
    // the animation never runs, so `animationend` never fires to reset it.
    setPopping(!pinned);
    togglePin.mutate(
      { kind, id, name, next: !pinned, onResort },
      { onSettled: () => (inFlightRef.current = false) },
    );
  };

  const offline = typeof navigator !== 'undefined' && !navigator.onLine;
  const hoverPlate = tone === 'chrome' ? 'hover:bg-chrome-row-hover' : 'hover:bg-neutral-surface-raised';

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
      className={`${BASE} ${box} ${hoverPlate} ${revealClasses(pinned, reveal)} ${
        offline ? 'opacity-60' : ''
      } ${className ?? ''}`}
    >
      <PinGlyph
        filled={pinned}
        size={glyph}
        tone={tone}
        popping={popping}
        onPopEnd={() => setPopping(false)}
      />
    </button>
  );
}

/**
 * Map pin — the per-user wayfinding pin.
 *
 * State is carried by **shape** (solid vs outline), **ink weight** (primary vs
 * secondary), and **words** (`aria-pressed` plus the label flipping Pin↔Unpin) —
 * never by hue, so it survives greyscale and every form of color blindness.
 *
 * The pinned fill is deliberately *neutral ink*, not `brand-primary`. The design
 * called for the brand accent, but in this token set `--brand-primary` and
 * `--semantic-on-track` are the identical value (`49 111 87` light, `102 185 152`
 * dark). A brand-filled pin would therefore render in exactly the "On track"
 * health hue — beside the health chip on the Project Overview header, and beside
 * the health dot on every rail row, where a pinned at-risk project would show an
 * orange dot and a green pin on the same line. A pin is not a status.
 * See ADR-0627 §D12.
 *
 * The hole is a genuine knock-out (`fill-rule: evenodd` over a single path)
 * rather than a background-colored dot, so it inherits whatever is behind it —
 * the row, the hover plate, or the focus ring — with no color to keep in sync.
 */
function PinGlyph({
  filled,
  size,
  tone,
  popping,
  onPopEnd,
}: {
  filled: boolean;
  size: number;
  tone: 'surface' | 'chrome';
  popping: boolean;
  onPopEnd: () => void;
}) {
  const ink =
    tone === 'chrome'
      ? filled
        ? 'text-chrome-text-primary'
        : 'text-chrome-text-secondary'
      : filled
        ? 'text-neutral-text-primary'
        : 'text-neutral-text-secondary';

  // Teardrop body; the second subpath is the hole. Under `evenodd` the inner
  // ring subtracts from the outer one, so the filled glyph reads as a pin
  // rather than a blob at 16px.
  const BODY = 'M12 21.2c4.3-4.9 6.4-8.4 6.4-10.9a6.4 6.4 0 1 0-12.8 0c0 2.5 2.1 6 6.4 10.9z';
  const HOLE = 'M14.3 10a2.3 2.3 0 1 0-4.6 0 2.3 2.3 0 1 0 4.6 0z';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={`${ink} ${popping ? 'motion-safe:animate-pin-pop' : ''}`}
      onAnimationEnd={onPopEnd}
    >
      {filled ? (
        <path d={`${BODY} ${HOLE}`} fill="currentColor" fillRule="evenodd" />
      ) : (
        <>
          <path
            d={BODY}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="10" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
        </>
      )}
    </svg>
  );
}

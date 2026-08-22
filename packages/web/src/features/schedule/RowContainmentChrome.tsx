import { outlineGuideX } from './outlineDrag';

/**
 * The two visual halves of "what is inside what" on the Schedule outline
 * (#2956, design `TruePPM - Designer Prototype.html` — "Reading structure").
 *
 * A phase used to be *a slightly bolder row*, and nothing else on the outline
 * said what contained what — so a 40-row plan had no readable shape.
 *
 * Both marks here are **redundant encodings**, deliberately. Containment is
 * already carried by `aria-level`, the WBS number, the fold caret and its
 * `N inside` / `N hidden` count. These add a visual channel for a sighted user
 * scanning quickly; neither is the only carrier of any fact, which is why both
 * are `aria-hidden` and why the guides may sit below the 3:1 non-text contrast
 * floor without failing WCAG 1.4.11 (that floor governs marks that convey
 * information on their own).
 */

/**
 * Left offset, in px, of the vertical rule for depth `d` (1-based).
 *
 * The one shared helper web rule 309(a) requires — it lives in `outlineDrag`
 * because the drag's drop indicator derives its x from the same ladder, and two
 * copies of the formula would let the indicator drift off the guides without
 * anything rendering wrong enough to notice. Matches the task cell's own
 * `paddingLeft: (level - 1) * WBS_INDENT + 8`, so a guide lands exactly on the
 * indent origin of the level it belongs to rather than near it.
 */
const guideX = outlineGuideX;

/**
 * One vertical rule per ancestor level, drawn inside the task-name cell.
 *
 * The deepest guide on a child row sits at the same x as its container's own
 * band edge (`PhaseBandEdge` below), so the container's edge visually continues
 * down through its contents — the edge and the guide are one line, not two
 * marks that happen to be near each other. That is the whole idea: "inside that
 * phase" becomes a line you can follow.
 *
 * `pointer-events-none`, and a SIBLING of the cell's content rather than a
 * wrapper around it. Both matter: an overlay that wraps content, or that omits
 * the property, intercepts clicks on everything beneath it — the #2782 class,
 * where a de-emphasis layer froze the task list.
 */
export function DepthGuides({ level }: { level: number }) {
  if (level <= 1) return null;
  const depths = Array.from({ length: level - 1 }, (_, i) => i + 1);
  return (
    <span aria-hidden="true" data-testid="depth-guides" className="pointer-events-none">
      {depths.map((d) => (
        <span
          key={d}
          data-depth={d}
          className="absolute top-0 bottom-0 w-px bg-neutral-border/60"
          style={{ left: guideX(d) }}
        />
      ))}
    </span>
  );
}

/**
 * The phase band's sage edge, at the container's own indent origin.
 *
 * NOT at the row's far-left edge, and that is a constraint rather than a
 * preference: `border-l-2 border-brand-primary` there already encodes
 * *selection*, and `ModeGutter`'s 3px stripe already encodes *delivery mode*.
 * A third left-edge stripe would make all three ambiguous. Placing it at the
 * indent origin puts it where the row's depth is already stated — and makes it
 * the same line the children's deepest guide runs on.
 */
export function PhaseBandEdge({ level }: { level: number }) {
  return (
    <span
      aria-hidden="true"
      data-testid="phase-band-edge"
      className="pointer-events-none absolute top-0 bottom-0 w-[2px] rounded-full bg-brand-primary/70"
      style={{ left: guideX(level) }}
    />
  );
}

/**
 * Row background for a phase. A wash rather than a border so it reads as a
 * *band* the eye can land on while scanning, and weak enough that the
 * selection and hover washes still win on top of it.
 */
export const PHASE_BAND_ROW_CLASS = 'bg-brand-primary/[0.045]';

/** Task-name treatment for a phase: the display face, per the design. */
export const PHASE_BAND_NAME_CLASS = 'font-display font-medium tracking-tight';

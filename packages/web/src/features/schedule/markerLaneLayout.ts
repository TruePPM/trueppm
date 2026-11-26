/**
 * Collision layout for the timescale marker lane (#4068, #4050 §5 A5).
 *
 * The lane is one 18px strip, so there is no second row to stack a colliding
 * label on. Each marker therefore tries, in order, its preferred side at full
 * text, the opposite side at full text, then both sides again at the short text
 * (the name without the date); a marker none of those fit keeps its tick but
 * loses its label. P80 prefers the left of its line and Target the right, so the
 * two that most often land a few days apart open away from each other.
 *
 * Pure and measure-injectable: the lane component feeds it real viewport pixels,
 * and the unit tests feed it a fixed-width measure so the geometry is exact.
 */

export type LaneMarkerKind = 'today' | 'p80' | 'target';

export interface LaneMarkerInput {
  kind: LaneMarkerKind;
  /** Viewport x of the marker's line (scroll already subtracted). */
  x: number;
  fullText: string;
  shortText: string;
  /** `auto` tries the right side first, then the left. */
  preferredSide: 'left' | 'right' | 'auto';
}

export interface LaneMarkerPlacement {
  kind: LaneMarkerKind;
  x: number;
  /** False when no variant fit; the tick still draws, the chip does not. */
  labelShown: boolean;
  side: 'left' | 'right';
  text: string;
  /** Chip left edge, viewport px. Meaningful only when `labelShown`. */
  left: number;
  width: number;
}

/** Gap between a chip and its own line, and between neighbouring chips. */
export const LANE_LINE_GAP = 3;
export const LANE_CHIP_GAP = 4;
const CHAR_WIDTH = 6.6;
const CHIP_PAD = 12;

export function estimateChipWidth(text: string): number {
  return Math.ceil(text.length * CHAR_WIDTH + CHIP_PAD);
}

/** Placement priority: the two forecast markers outrank Today when space runs out. */
const PRIORITY: Record<LaneMarkerKind, number> = { p80: 0, target: 1, today: 2 };

export function layoutMarkerLane(
  markers: readonly LaneMarkerInput[],
  viewportWidth: number,
  measure: (text: string) => number = estimateChipWidth,
): LaneMarkerPlacement[] {
  const placed: { left: number; right: number }[] = [];
  const out = new Map<LaneMarkerKind, LaneMarkerPlacement>();

  const ordered = [...markers].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  for (const m of ordered) {
    const first: 'left' | 'right' = m.preferredSide === 'left' ? 'left' : 'right';
    const second: 'left' | 'right' = first === 'left' ? 'right' : 'left';
    const variants: { side: 'left' | 'right'; text: string }[] = [
      { side: first, text: m.fullText },
      { side: second, text: m.fullText },
      { side: first, text: m.shortText },
      { side: second, text: m.shortText },
    ];

    let result: LaneMarkerPlacement = {
      kind: m.kind,
      x: m.x,
      labelShown: false,
      side: first,
      text: m.fullText,
      left: m.x,
      width: 0,
    };
    for (const v of variants) {
      const width = measure(v.text);
      const left = v.side === 'right' ? m.x + LANE_LINE_GAP : m.x - LANE_LINE_GAP - width;
      const right = left + width;
      if (left < 0 || right > viewportWidth) continue;
      if (placed.some((p) => left < p.right + LANE_CHIP_GAP && right + LANE_CHIP_GAP > p.left)) {
        continue;
      }
      placed.push({ left, right });
      result = { kind: m.kind, x: m.x, labelShown: true, side: v.side, text: v.text, left, width };
      break;
    }
    out.set(m.kind, result);
  }
  // Return in the caller's order so index-based consumers stay stable.
  return markers.map((m) => out.get(m.kind) as LaneMarkerPlacement);
}

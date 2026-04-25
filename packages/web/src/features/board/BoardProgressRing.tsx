/**
 * Circular progress ring for board cards (issue #130).
 *
 * Renders as an SVG donut so stroke colours can reference Tailwind design
 * tokens directly (rule 8 — no hex literals in components). State → token:
 *   - 0 %     → stroke-neutral-border
 *   - CP task  → stroke-semantic-critical
 *   - stalled  → stroke-semantic-warning
 *   - 100 %    → stroke-semantic-on-track
 *   - default  → stroke-brand-primary
 *
 * Intentionally unlabelled — the inner % would have to sit below the
 * text-xs floor (rule 50). The parent card's aria-label + entry stamp
 * carry the progress meaning; the ring itself is aria-hidden.
 */
interface Props {
  /** 0–100 */
  progress: number;
  isCritical?: boolean;
  isStalled?: boolean;
}

const SIZE = 22;
const STROKE_WIDTH = 3;
const RADIUS = (SIZE - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function fillClass(pct: number, isCritical?: boolean, isStalled?: boolean): string {
  if (pct === 0) return 'stroke-neutral-border';
  if (isCritical) return 'stroke-semantic-critical';
  if (isStalled) return 'stroke-semantic-warning';
  if (pct === 100) return 'stroke-semantic-on-track';
  return 'stroke-brand-primary';
}

export function BoardProgressRing({ progress, isCritical, isStalled }: Props) {
  const pct = Math.max(0, Math.min(100, progress));
  const dashOffset = CIRCUMFERENCE * (1 - pct / 100);

  return (
    <svg
      aria-hidden="true"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="flex-shrink-0"
    >
      {/* Track */}
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE_WIDTH}
        className="stroke-neutral-surface-sunken"
      />
      {/* Progress arc */}
      {pct > 0 && (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          className={fillClass(pct, isCritical, isStalled)}
        />
      )}
    </svg>
  );
}

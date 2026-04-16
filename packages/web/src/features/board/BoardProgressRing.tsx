/**
 * Circular progress ring for board cards (issue #130).
 *
 * Uses a CSS conic-gradient for the filled arc and a white inner circle to
 * create the donut shape. Color follows task severity:
 *   - 0 %     → neutral border (no progress yet)
 *   - CP task  → semantic-critical (#B91C1C)
 *   - stalled  → semantic-warning (#D97706)
 *   - default  → brand-primary (#1C6B3A)
 *   - 100 %    → semantic-on-track (#166534), shows a ✓ checkmark
 *
 * The ring is aria-hidden — the parent card's aria-label carries the meaning.
 */
interface Props {
  /** 0–100 */
  progress: number;
  isCritical?: boolean;
  isStalled?: boolean;
}

// Token hex values (sourced from tailwind.config.ts to avoid hex literals in callers).
const COLOR_NEUTRAL  = '#D4D2CE'; // neutral-border
const COLOR_NORMAL   = '#1C6B3A'; // brand-primary
const COLOR_CRITICAL = '#B91C1C'; // semantic-critical
const COLOR_WARNING  = '#D97706'; // semantic-warning
const COLOR_COMPLETE = '#166534'; // semantic-on-track

const TRACK_COLOR = '#E2E8F0'; // Slate-200 — matches spec

export function BoardProgressRing({ progress, isCritical, isStalled }: Props) {
  const pct = Math.max(0, Math.min(100, progress));

  const fillColor =
    pct === 0
      ? COLOR_NEUTRAL
      : isCritical
        ? COLOR_CRITICAL
        : isStalled
          ? COLOR_WARNING
          : pct === 100
            ? COLOR_COMPLETE
            : COLOR_NORMAL;

  return (
    <div
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        background: `conic-gradient(${fillColor} ${pct}%, ${TRACK_COLOR} 0)`,
        display: 'inline-grid',
        placeItems: 'center',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {/* White inner donut mask */}
      <div
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: 'white',
          position: 'absolute',
        }}
      />
      {/* Label — relative so it floats above the mask */}
      <span
        style={{
          position: 'relative',
          fontSize: 8,
          fontWeight: 700,
          color: '#334155',
          lineHeight: 1,
        }}
      >
        {pct === 100 ? '✓' : `${pct}%`}
      </span>
    </div>
  );
}

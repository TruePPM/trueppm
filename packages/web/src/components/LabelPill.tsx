/**
 * Task-label pill (ADR-0400, #1089) — the shared render for a colored label on
 * board cards and the schedule drawer.
 *
 * A pill pairs the tinted background with an AA-safe text token and a leading
 * color dot; the label *name* is always visible, so color is never the sole
 * signal (brand §15 / rule 208). Color comes from the categorical palette in
 * `@/lib/labelColors` via theme-aware CSS custom properties — not an arbitrary
 * Tailwind color class. Pills are presentational (non-interactive on the card
 * face); assignment happens in the label popover.
 */
import type { TaskLabel } from '@/types';
import { labelDotStyle, labelTokenStyle } from '@/lib/labelColors';

export function LabelPill({
  label,
  dotOnly = false,
}: {
  label: TaskLabel;
  /** Compact board density: render just the color dot (name in the tooltip). */
  dotOnly?: boolean;
}) {
  if (dotOnly) {
    return (
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={labelDotStyle(label.color)}
        title={label.name}
        aria-label={`Label: ${label.name}`}
      />
    );
  }
  return (
    <span
      className="inline-flex max-w-[10rem] items-center gap-1 rounded-chip border px-1.5 py-px text-xs font-medium"
      style={labelTokenStyle(label.color)}
      title={label.name}
    >
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={labelDotStyle(label.color)}
        aria-hidden="true"
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export type LabelDensity = 'compact' | 'comfortable' | 'detailed';

/**
 * A density-capped row of label pills for a task.
 * - compact: up to 3 color dots + a `+N` count (no text)
 * - comfortable: up to 2 pills + a `+N` overflow chip
 * - detailed: every pill
 * Labels are ordered by palette `position` then name for a stable row.
 */
export function LabelPillRow({
  labels,
  density = 'comfortable',
}: {
  labels: TaskLabel[];
  density?: LabelDensity;
}) {
  if (labels.length === 0) return null;
  const sorted = [...labels].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
  );

  if (density === 'compact') {
    const shown = sorted.slice(0, 3);
    const extra = sorted.length - shown.length;
    return (
      <span
        className="inline-flex items-center gap-0.5"
        aria-label={`Labels: ${sorted.map((l) => l.name).join(', ')}`}
      >
        {shown.map((l) => (
          <LabelPill key={l.id} label={l} dotOnly />
        ))}
        {extra > 0 && <span className="text-xs text-neutral-text-secondary">+{extra}</span>}
      </span>
    );
  }

  const cap = density === 'detailed' ? sorted.length : 2;
  const shown = sorted.slice(0, cap);
  const hidden = sorted.slice(cap);
  return (
    <>
      {shown.map((l) => (
        <LabelPill key={l.id} label={l} />
      ))}
      {hidden.length > 0 && (
        <span
          className="inline-block rounded-chip border border-neutral-border px-1 py-px text-xs text-neutral-text-secondary"
          title={hidden.map((l) => l.name).join(', ')}
        >
          +{hidden.length}
        </span>
      )}
    </>
  );
}

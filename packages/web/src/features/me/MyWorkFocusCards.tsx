/**
 * My Work v2 focus row — three (or two) risk-ranked focus cards rendered above
 * the assigned-task list. Translates the v2 spec's `.focus` / `.ftitle` /
 * `.fbig` / `.spark` styling into Design-System tokens (border + card radius,
 * no shadow per rule 1; mono kicker + display value). Worst signal leads, so
 * the card order from `buildMyWorkFocusCards` is the DOM order — visual order
 * === reading order, no CSS `order`.
 */
import type { MyWorkFocusCard } from './myWorkFocus';
import type { OverviewMetricVariant } from '@/features/project/overviewMetrics';

const VALUE_COLOR: Record<OverviewMetricVariant, string> = {
  critical: 'text-semantic-critical',
  'at-risk': 'text-semantic-at-risk',
  neutral: 'text-neutral-text-primary',
  'on-track': 'text-semantic-on-track',
};

// The first (leading) card is the "Needs attention" card and gets a left accent
// matching its severity — amber when at-risk, critical-red when blocked — so it
// reads as the worst signal at a glance (the spec's amber-bordered lead card).
const ACCENT_BORDER: Record<OverviewMetricVariant, string> = {
  critical: 'border-l-2 border-l-semantic-critical',
  'at-risk': 'border-l-2 border-l-semantic-at-risk',
  neutral: '',
  'on-track': '',
};

function Spark({ heights }: { heights: number[] }) {
  // Decorative progress spark — the value + label already carry the meaning
  // (rule 6 / 120), so the bars are aria-hidden. The final bar is the real
  // completion share; earlier bars encode direction only.
  return (
    <div className="flex h-9 items-end gap-[3px]" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={i}
          className={[
            'flex-1 rounded-t-chip',
            i === heights.length - 1 ? 'bg-brand-primary' : 'bg-brand-primary/30',
          ].join(' ')}
          style={{ height: `${Math.round(Math.max(0.06, Math.min(1, h)) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function MyWorkFocusCards({ cards }: { cards: MyWorkFocusCard[] }) {
  // 1.3fr/1fr/1fr at md+ per the spec; single column stacked on mobile. The
  // grid widens the lead card so the worst signal also reads biggest.
  const cols = cards.length === 3 ? 'md:grid-cols-[1.3fr_1fr_1fr]' : 'md:grid-cols-2';
  return (
    <div className={`grid grid-cols-1 gap-3 md:gap-4 ${cols}`}>
      {cards.map((card, i) => (
        <div
          key={card.key}
          className={[
            'flex flex-col gap-2.5 rounded-card border border-neutral-border',
            'bg-neutral-surface-raised p-4 md:p-5 [container-type:inline-size]',
            i === 0 ? ACCENT_BORDER[card.variant] : '',
          ].join(' ')}
        >
          <span className="tppm-mono text-[10.5px] font-medium uppercase tracking-[0.07em] text-neutral-text-secondary">
            {card.label}
          </span>
          <div className="flex items-baseline gap-2">
            <span
              className={`font-display text-[clamp(1.5rem,9cqi,1.875rem)] font-semibold leading-none tracking-tight ${VALUE_COLOR[card.variant]}`}
            >
              {card.value}
            </span>
            {card.delta && (
              <span className="tppm-mono text-xs text-neutral-text-secondary">{card.delta}</span>
            )}
          </div>
          {/* Second real figure (#1236): schedule-health on card 1, burn pace on
              the sprint card. Its own tone; the text carries the meaning so the
              signal is never color-only (a11y). */}
          {card.detail && (
            <span className={`tppm-mono text-xs font-medium ${VALUE_COLOR[card.detail.tone]}`}>
              {card.detail.text}
            </span>
          )}
          {card.spark && <Spark heights={card.spark} />}
        </div>
      ))}
    </div>
  );
}

import { useState, useRef, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import type { MonteCarloResult } from '@/types';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { MonteCarloHistogram } from './MonteCarloHistogram';

interface Props {
  result: MonteCarloResult;
}

/**
 * Timeline side of the Monte Carlo row.
 *
 * Renders three permanently-visible date chips — P50 (green), P80 (amber),
 * P95 (red). Hover or keyboard-focus opens a detailed histogram tooltip.
 *
 * Why chips-only (no inline mini histogram): real-world MC inputs frequently
 * have no PERT estimates, so every simulation collapses to a single end date
 * and the histogram strip degenerates to one bar. The dates are the
 * persona-aligned signal (PMs, PMO, execs all read a date and a percentile);
 * the distribution shape is power-user information and lives in the tooltip.
 *
 * The chips satisfy WCAG 1.4.1 — percentile boundaries are expressed as
 * labelled text, not colour alone.
 */
export function MonteCarloTimeline({ result }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const { p50, p80, p95 } = result;

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(iso),
    );

  const openTooltip = useCallback((x: number, y: number) => {
    setTooltipPos({ x, y });
    setIsOpen(true);
  }, []);

  const closeTooltip = useCallback(() => {
    setTooltipPos(null);
    setIsOpen(false);
  }, []);

  const showAtCenter = useCallback(() => {
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    openTooltip(rect.left + rect.width / 2, rect.top);
  }, [openTooltip]);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLDivElement>) => openTooltip(e.clientX, e.clientY),
    [openTooltip],
  );
  const handleMouseMove = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (isOpen) setTooltipPos({ x: e.clientX, y: e.clientY });
    },
    [isOpen],
  );
  const handleMouseLeave = useCallback(closeTooltip, [closeTooltip]);
  const handleFocus = useCallback(showAtCenter, [showAtCenter]);
  const handleBlur = useCallback(closeTooltip, [closeTooltip]);
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (isOpen) {
          closeTooltip();
        } else {
          showAtCenter();
        }
      }
      if (e.key === 'Escape') closeTooltip();
    },
    [isOpen, closeTooltip, showAtCenter],
  );

  const chips = [
    { label: 'P50', iso: p50, border: 'border-semantic-on-track/40', text: 'text-semantic-on-track' },
    { label: 'P80', iso: p80, border: 'border-semantic-at-risk/40',  text: 'text-semantic-at-risk'  },
    { label: 'P95', iso: p95, border: 'border-semantic-critical/40', text: 'text-semantic-critical' },
  ] as const;

  return (
    <>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`Monte Carlo: P50 ${fmt(p50)}, P80 ${fmt(p80)}, P95 ${fmt(p95)}. Press Enter for distribution.`}
        className="flex-1 min-w-0 flex items-center justify-end gap-1.5 px-3 overflow-hidden border-t border-neutral-border bg-neutral-surface
          cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-primary"
        onMouseEnter={handleMouseEnter}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {/* P50 / P80 / P95 chips — always visible; outlined style per rule 21/39 */}
        {chips.map(({ label, iso, border, text }) => (
          <span
            key={label}
            className={`text-xs font-medium px-1.5 py-0.5 rounded border ${border} ${text} bg-transparent whitespace-nowrap`}
          >
            {label} {fmt(iso)}
          </span>
        ))}
        <span className="ml-1 text-xs text-neutral-text-secondary" aria-hidden="true">
          Detail ›
        </span>
      </div>

      {/* Detailed histogram tooltip — fixed-position to escape overflow:hidden ancestors */}
      {isOpen && tooltipPos && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Monte Carlo distribution histogram"
          className={`fixed z-50 w-60 p-3 rounded border border-neutral-border bg-neutral-surface pointer-events-none ${
            prefersReducedMotion ? '' : 'motion-safe:transition-opacity motion-safe:duration-150'
          }`}
          style={{
            left: Math.min(tooltipPos.x - 120, window.innerWidth - 256),
            top: tooltipPos.y - 168 < 8 ? tooltipPos.y + 24 : tooltipPos.y - 168,
          }}
        >
          <p className="text-sm font-medium text-neutral-text-primary mb-2">
            8 in 10 simulations finish by{' '}
            <strong>
              {new Intl.DateTimeFormat('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }).format(new Date(p80))}
            </strong>
            .
          </p>
          <p className="text-xs text-neutral-text-secondary mb-1.5">
            Distribution of project end dates
          </p>
          <MonteCarloHistogram result={result} />
          <div className="mt-2 flex items-center gap-4 text-xs text-neutral-text-secondary">
            {[
              { label: 'P50', iso: p50, cls: 'bg-semantic-on-track' },
              { label: 'P80', iso: p80, cls: 'bg-semantic-at-risk' },
              { label: 'P95', iso: p95, cls: 'bg-semantic-critical' },
            ].map(({ label, iso, cls }) => (
              <span key={label} className="flex items-center gap-1">
                <span className={`inline-block w-2.5 h-1 ${cls} rounded-sm`} aria-hidden="true" />
                <span className="font-medium">{label}</span>
                <span>
                  {new Date(iso).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

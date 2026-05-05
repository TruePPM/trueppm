import { useState, useRef, useCallback, type KeyboardEvent, type MouseEvent } from 'react';
import type { MonteCarloResult } from '@/types';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Props {
  result: MonteCarloResult;
}

/**
 * Timeline side of the Monte Carlo row.
 *
 * Renders three permanently-visible date chips — `P50: {date}` (green),
 * `P80: {date}` (amber), `P95: {date}` (red). Hover or keyboard-focus opens
 * a small popover translating the P80 percentile into plain English ("8 in
 * 10 simulations finish by …"), or — when every simulation converged on the
 * same date — a one-paragraph hint that PERT estimates are required to see
 * a distribution.
 *
 * Why no histogram in the popover: VoC review (2026-05-05) found the chart
 * was decorative for every persona — Janet (COO) values only the plain-English
 * headline; nobody else uses distribution shape at this surface. The full
 * histogram lives in dedicated MC views (`MCResultPanel` from the TopBar P80
 * pill, `MonteCarloSheet` on mobile) where the user explicitly asked for it.
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
  const isCollapsed = p50 === p80 && p80 === p95;

  const fmtShort = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(iso),
    );
  const fmtLong = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));

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
        aria-label={`Monte Carlo: P50 ${fmtShort(p50)}, P80 ${fmtShort(p80)}, P95 ${fmtShort(p95)}. Press Enter for details.`}
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
            {label}: {fmtShort(iso)}
          </span>
        ))}
        <span className="ml-1 text-xs text-neutral-text-secondary" aria-hidden="true">
          Detail ›
        </span>
      </div>

      {/* Plain-English popover — fixed-position to escape overflow:hidden ancestors. */}
      {isOpen && tooltipPos && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Monte Carlo confidence detail"
          className={`fixed z-50 w-72 p-3 rounded border border-neutral-border bg-neutral-surface pointer-events-none ${
            prefersReducedMotion ? '' : 'motion-safe:transition-opacity motion-safe:duration-150'
          }`}
          style={{
            left: Math.min(tooltipPos.x - 144, window.innerWidth - 304),
            top: tooltipPos.y - 120 < 8 ? tooltipPos.y + 24 : tooltipPos.y - 120,
          }}
        >
          {isCollapsed ? (
            <>
              <p className="text-sm text-neutral-text-primary leading-snug">
                Every simulation finished on{' '}
                <strong>{fmtLong(p80)}</strong>.
              </p>
              <p className="mt-2 text-xs text-neutral-text-secondary leading-snug">
                Add PERT estimates (optimistic / most-likely / pessimistic durations) on tasks to see a distribution.
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-text-primary leading-snug">
              8 in 10 simulations finish by{' '}
              <strong>{fmtLong(p80)}</strong>.
            </p>
          )}
        </div>
      )}
    </>
  );
}

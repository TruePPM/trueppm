import type { ReactNode } from 'react';
import { StarIcon, ToolsIcon } from '@/components/Icons';

const BANNER_CLASS = `flex items-center gap-2 px-3 py-1.5 text-xs
                bg-brand-primary/5 border-b border-brand-primary/20
                text-brand-primary`;

const CLEAR_LINK_CLASS = `ml-1 underline hover:no-underline
                  focus:ring-2 focus:ring-brand-primary focus:outline-none rounded-control`;

interface LensBannerProps {
  glyph: ReactNode;
  label: string;
  clearLabel: string;
  onClear: () => void;
  testId?: string;
}

/**
 * One "this board is narrowed" banner. Every active lens gets one so a filtered
 * board can never read as "lost tasks" — the filter state stays inescapable.
 */
function LensBanner({ glyph, label, clearLabel, onClear, testId }: LensBannerProps) {
  return (
    <div className={BANNER_CLASS} role="status" data-testid={testId}>
      <span aria-hidden="true">{glyph}</span>
      <span>{label}</span>
      <button type="button" onClick={onClear} className={CLEAR_LINK_CLASS}>
        {clearLabel}
      </button>
    </div>
  );
}

interface BoardLensBannersProps {
  /** "My tasks" filter (issue 198) is on. */
  mineActive: boolean;
  onClearMine: () => void;
  /** Tech-debt lens (ADR-0178, #1076) is on. */
  debtOnly: boolean;
  onClearDebt: () => void;
}

/** The task-level lens banners rendered above the board body. */
export function BoardLensBanners({
  mineActive,
  onClearMine,
  debtOnly,
  onClearDebt,
}: BoardLensBannersProps) {
  return (
    <>
      {mineActive && (
        <LensBanner
          glyph={<StarIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Filter: My tasks"
          clearLabel="Show all →"
          onClear={onClearMine}
        />
      )}
      {debtOnly && (
        <LensBanner
          glyph={<ToolsIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          label="Filter: Tech debt"
          clearLabel="Show all →"
          onClear={onClearDebt}
        />
      )}
    </>
  );
}

interface FocusLaneBannerProps {
  /** Name of the focused lane; null when no lane is focused (or the id is stale). */
  phaseName: string | null;
  onExit: () => void;
}

/**
 * Phase-lane focus banner (issue 1460, ADR-0192 Part 3) — keeps focus mode
 * inescapable (mirrors the lens banners above) so a board zoomed to one lane
 * never reads as "lost lanes". A stale `?focus=` for a phase that no longer
 * exists resolves to a null name here and self-hides.
 */
export function FocusLaneBanner({ phaseName, onExit }: FocusLaneBannerProps) {
  if (phaseName === null) return null;
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs
                bg-brand-primary/5 border-b border-brand-primary/20 text-brand-primary"
      role="status"
      data-testid="focus-banner"
    >
      <svg
        aria-hidden="true"
        width={12}
        height={12}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
      >
        <circle cx="8" cy="8" r="2.2" />
        <path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15" strokeLinecap="round" />
      </svg>
      <span>
        Focused on <strong className="font-semibold">{phaseName}</strong> · other lanes hidden
      </span>
      <button
        type="button"
        onClick={onExit}
        data-testid="exit-focus"
        className="ml-1 underline hover:no-underline
                  focus:ring-2 focus:ring-brand-primary focus:ring-offset-1 focus:outline-none rounded-control"
      >
        Exit focus →
      </button>
    </div>
  );
}

interface BoardZeroMatchProps {
  onClearAll: () => void;
}

/**
 * Zero-match state (issue 1091) — facets are active but no card matches.
 * Supersedes the board body (which would otherwise be every card dimmed to
 * 30%); offers a one-click clear.
 */
export function BoardZeroMatch({ onClearAll }: BoardZeroMatchProps) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-text-secondary text-sm"
      role="status"
      data-testid="board-zero-match"
    >
      <p>No cards match these filters.</p>
      <button
        type="button"
        onClick={onClearAll}
        data-testid="board-zero-match-clear"
        className="border border-brand-primary/40 rounded-control px-3 py-1.5 text-xs
                  text-brand-primary font-medium hover:bg-brand-primary/10
                  focus:ring-2 focus:ring-brand-primary focus:outline-none"
      >
        Clear filters
      </button>
    </div>
  );
}

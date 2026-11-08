/**
 * The Pass 2 title scale — eight steps, two families (rule 439).
 *
 * The display family is the one the shell v2 sheet already sets
 * (`AppShell2`'s `font-display`); the second family is mono, for every ID, date
 * and number that must line up. A step names a ROLE, not a size: a page asks
 * for `TYPE.pageTitle`, never `text-[20px]`, so a later retune moves every
 * page at once instead of each page drifting on its own.
 *
 * Figures (`lead`, `tile`) carry `tabular-nums` so a changing value does not
 * shift its neighbors as digits change width.
 */
export const TYPE = {
  /** 44/52 — the one headline figure on a home or overview. */
  lead: 'text-[44px] leading-[52px] font-semibold tabular-nums tracking-tight',
  /** 32/40 — the home greeting. */
  greeting: 'text-[32px] leading-[40px] font-semibold tracking-tight',
  /** 20/28 — the page's H1. */
  pageTitle: 'text-[20px] leading-[28px] font-semibold',
  /** 20/28 tabular — a KPI tile's value. */
  tile: 'text-[20px] leading-[28px] font-semibold tabular-nums',
  /** 15/22 — a section heading (H2) inside a page. */
  section: 'text-[15px] leading-[22px] font-semibold',
  /** 13/20 — running text, table cells. */
  body: 'text-[13px] leading-[20px]',
  /** 12/16 — captions, timestamps, column headers. */
  meta: 'text-xs',
  /** 12 mono tabular — IDs, dates and numbers. */
  mono: 'font-mono text-xs tabular-nums',
} as const;

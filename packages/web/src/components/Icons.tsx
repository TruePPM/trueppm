/**
 * TruePPM icon set — all inline SVG, no external dependency.
 *
 * All icons use a 16×16 viewBox and inherit color via `currentColor`.
 * Pass `className` and `aria-hidden="true"` at the call site.
 */

export interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
  /** Test hook for decorative icons that carry no accessible name of their own. */
  'data-testid'?: string;
}

/** Clock — a circle with hour/minute hands; the "log time" affordance */
export function ClockIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} {...rest}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.75V8L10.25 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mini Gantt chart — three horizontal bars of varying length */
export function GanttIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="2" width="9" height="2.5" rx="1.25" />
      <rect x="1" y="6.75" width="14" height="2.5" rx="1.25" />
      <rect x="1" y="11.5" width="6" height="2.5" rx="1.25" />
    </svg>
  );
}

/** Chain-link glyph — external-link indicator (issue 767). Stroke-based; tints via currentColor. */
export function LinkIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

/** Agent oversight — a shield enclosing a check; governance-of-agents glyph (#2020) */
export function AgentIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 1.5 13 3.25V7.5c0 3.1-2.1 5.4-5 6.75-2.9-1.35-5-3.65-5-6.75V3.25L8 1.5Z" />
      <path d="M5.75 7.75 7.25 9.25 10.5 6" />
    </svg>
  );
}

/** Kanban board — three vertical columns */
export function BoardIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="2" width="4" height="9" rx="1" />
      <rect x="6" y="2" width="4" height="6" rx="1" />
      <rect x="11" y="2" width="4" height="12" rx="1" />
    </svg>
  );
}

/** List — three horizontal rows with a left dot each */
export function ListIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <circle cx="2.5" cy="4" r="1.25" />
      <rect x="5" y="3" width="10" height="2" rx="1" />
      <circle cx="2.5" cy="8" r="1.25" />
      <rect x="5" y="7" width="10" height="2" rx="1" />
      <circle cx="2.5" cy="12" r="1.25" />
      <rect x="5" y="11" width="7" height="2" rx="1" />
    </svg>
  );
}

/** Calendar */
export function CalendarIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} {...rest}>
      <rect x="1.5" y="3" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="1.5" y1="7" x2="14.5" y2="7" stroke="currentColor" strokeWidth="1" />
      <line
        x1="5"
        y1="1.5"
        x2="5"
        y2="4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="11"
        y1="1.5"
        x2="11"
        y2="4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Resources — two person silhouettes */
export function ResourcesIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <circle cx="5.5" cy="4.5" r="2.5" />
      <path d="M0.5 13c0-2.76 2.24-5 5-5s5 2.24 5 5" />
      <circle cx="12" cy="4.5" r="2" opacity="0.55" />
      <path
        d="M10.5 9c1.66.55 2.8 2.1 2.8 3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
    </svg>
  );
}

/** Sprint — circular arrow suggesting time-boxed iteration cadence */
export function SprintIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} {...rest}>
      <path
        d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11 1.5L13.5 4L11 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Warning triangle — for at-risk badge */
export function WarningIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} {...rest}>
      <path
        d="M6 1L11.5 10.5H0.5L6 1Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <line
        x1="6"
        y1="5"
        x2="6"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="6" cy="9" r="0.6" fill="currentColor" />
    </svg>
  );
}

/** Filled circle — for critical count badge */
export function CriticalDotIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className={className} {...rest}>
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}

/** WBS — hierarchical indented outline (three rows with indent levels) */
export function WbsIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="2" width="8" height="2" rx="1" />
      <rect x="3" y="6" width="6" height="2" rx="1" />
      <rect x="3" y="10" width="9" height="2" rx="1" />
      <rect x="5" y="13.5" width="5" height="1.5" rx="0.75" />
    </svg>
  );
}

/** Shield — risk register icon */
export function RiskIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <path d="M8 1L2 3.5V8c0 3.31 2.55 5.8 6 6.85C11.45 13.8 14 11.31 14 8V3.5L8 1zm0 2.1l4 1.6V8c0 2.37-1.72 4.27-4 5.22C5.72 12.27 4 10.37 4 8V4.7l4-1.6z" />
    </svg>
  );
}

/** Overview / dashboard home icon */
export function OverviewIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

/** "Today" — a compact sun glyph for the Unified Today view (ADR-0180). */
export function TodayIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="3" />
      <rect x="7.25" y="0.5" width="1.5" height="2.5" rx="0.75" />
      <rect x="7.25" y="13" width="1.5" height="2.5" rx="0.75" />
      <rect x="0.5" y="7.25" width="2.5" height="1.5" rx="0.75" />
      <rect x="13" y="7.25" width="2.5" height="1.5" rx="0.75" />
    </svg>
  );
}

/** Activity — a pulse/waveform line, the "what changed" feed */
export function ActivityIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M1.5 8h3l2-4.5L9.5 12l2-4h3" />
    </svg>
  );
}

/** Settings — cog with centre circle */
export function SettingsIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" />
    </svg>
  );
}

/** Bar chart — three ascending columns for the Reports tab */
export function BarChartIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="8" width="4" height="7" rx="1" />
      <rect x="6" y="4" width="4" height="11" rx="1" />
      <rect x="11" y="1" width="4" height="14" rx="1" />
    </svg>
  );
}

/**
 * Board-card density layout previews (issue #1925) — a small wireframe of each
 * density so the Density menu shows what the layout looks like, not just its
 * name. Compact = stacked thin bars (the single-line "bar" view); Comfortable =
 * two roomy cards; Detailed = one card with a metrics row. Decorative — always
 * `aria-hidden`; the radio option's label + aria-label carry the meaning.
 */
export function DensityCompactIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="3" width="14" height="2" rx="1" />
      <rect x="1" y="7" width="14" height="2" rx="1" />
      <rect x="1" y="11" width="14" height="2" rx="1" />
    </svg>
  );
}

export function DensityComfortableIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="2.5" width="14" height="4.5" rx="1.3" />
      <rect x="1" y="9" width="14" height="4.5" rx="1.3" />
    </svg>
  );
}

export function DensityDetailedIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <rect x="1" y="2" width="14" height="8" rx="1.3" />
      <rect x="1" y="11.5" width="3" height="2.5" rx="0.8" />
      <rect x="5.5" y="11.5" width="3" height="2.5" rx="0.8" />
      <rect x="10" y="11.5" width="3" height="2.5" rx="0.8" />
    </svg>
  );
}

/**
 * TruePPM brand mark — the duotone dependency arrow (brand v1.0, ADR-0103).
 * Two task nodes joined by the sage critical-path arrow: navy nodes, sage arrow.
 * Duotone, so it does NOT use `currentColor` — nodes and arrow are themed
 * independently. Nodes reverse to pale on dark (`navy reverses to pale`); the
 * sage arrow holds in both modes. Below ~24px the arrowhead degrades — use the
 * favicon build instead. Geometry mirrors brand/assets/mark.svg (64×64).
 */
export function LogoMark({ size = 24, className, ...rest }: IconProps & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {/* sage critical-path arrow — holds in both modes */}
      <line
        x1="19"
        y1="45"
        x2="35"
        y2="31"
        className="stroke-sage-500"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <polygon points="42,23 39.67,36.44 28.53,24.96" className="fill-sage-500" />
      {/* navy nodes — reverse to pale on dark */}
      <circle cx="15" cy="49" r="7" className="fill-navy-700 dark:fill-reversed" />
      <circle cx="49" cy="16" r="9.5" className="fill-navy-700 dark:fill-reversed" />
    </svg>
  );
}

/** Magnifying glass — search inputs */
export function SearchIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      {...rest}
    >
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  );
}

/** Plus — create actions */
export function PlusIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      {...rest}
    >
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}

/** Close — dismiss panes, sheets, toasts */
export function CloseIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      {...rest}
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/** Chevron right — collapsed disclosure / dropdown caret */
export function ChevronRightIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  );
}

/** Chevron down — expanded disclosure / menu trigger */
export function ChevronDownIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <polyline points="4 6 8 10 12 6" />
    </svg>
  );
}

export function ChevronUpIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <polyline points="4 10 8 6 12 10" />
    </svg>
  );
}

/** Drag handle — six-dot grip for reorderable rows */
export function DragHandleIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <circle cx="6" cy="4" r="1.3" />
      <circle cx="10" cy="4" r="1.3" />
      <circle cx="6" cy="8" r="1.3" />
      <circle cx="10" cy="8" r="1.3" />
      <circle cx="6" cy="12" r="1.3" />
      <circle cx="10" cy="12" r="1.3" />
    </svg>
  );
}

/** Arrow right — "Pull →" affordance */
export function ArrowRightIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <line x1="3" y1="8" x2="12" y2="8" />
      <polyline points="8.5 4.5 12 8 8.5 11.5" />
    </svg>
  );
}

/** External link — "Open ↗" to a linked task */
export function ExternalLinkIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M9 3h4v4" />
      <line x1="13" y1="3" x2="7.5" y2="8.5" />
      <path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" />
    </svg>
  );
}

/** Inbox tray — empty "My Work" warm empty state (line style, navy stroke) */
export function InboxIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} {...rest}>
      <path
        d="M2 9.5 4 3h8l2 6.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path
        d="M2 9.5h3l1 1.5h4l1-1.5h3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Thumbtack — pin/unpin a view onto the mobile navigation bar (issue 1591) */
export function PinIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <path d="M6 1.5h4a1 1 0 0 1 .9 1.45L10 5v2l2 2v1.5H8.75V14L8 15.5 7.25 14v-3.5H4V9l2-2V5L5.1 2.95A1 1 0 0 1 6 1.5z" />
    </svg>
  );
}

/**
 * Bell — the TopBar notification affordance (issue 1707). Always the plain,
 * active bell; unread is signalled by the count badge + accent color, never by
 * swapping to a slashed/muted variant. A genuine muted state (none exists today)
 * would use a distinct bell-with-stroke glyph driven by a real mute flag.
 */
export function BellIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.5 11.25c.75-.75 1.5-1.75 1.5-4.5a4 4 0 0 1 8 0c0 2.75.75 3.75 1.5 4.5Z" />
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

/**
 * Moon — a filled crescent; the Do-Not-Disturb indicator (#1707). Rides as a
 * small corner chip over the (unchanged, active) bell. Deliberately the OS-standard
 * "quiet mode" glyph, NOT a slashed bell — DND pauses emails/push, the in-app
 * inbox stays active, so an off-implying bell would misread. Filled (like
 * CriticalDotIcon) so it stays crisp in the ~9px chip.
 */
export function MoonIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <path d="M13.8 10.2A6 6 0 1 1 7.6 2.2 4.7 4.7 0 0 0 13.8 10.2Z" />
    </svg>
  );
}

/** Horizontal ellipsis — overflow menus */
export function MoreHorizontalIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <circle cx="3.5" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.5" cy="8" r="1.3" />
    </svg>
  );
}

/**
 * Padlock — the "private / team-private / baselined / locked" affordance
 * (issue 1739). Replaces the 🔒 emoji, which rendered inconsistently across
 * platforms and never inherited the surrounding text color.
 */
export function LockIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

/** Concentric target — the sprint-goal affordance (issue 1739, replaces 🎯). */
export function TargetIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="3.25" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** No-entry circle — the "disabled / not permitted" affordance (issue 1739, replaces 🚫). */
export function BanIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="3.6" y1="3.6" x2="12.4" y2="12.4" />
    </svg>
  );
}

/**
 * File-type glyphs (issue 1739) — a generic, house-style set that replaces the
 * emoji mime/preview maps in AttachmentSection and previewType. Deliberately
 * generic line marks (not third-party brand logos): the per-host provider marks
 * — GitHub/GitLab/Figma/… — are a separate brand-asset decision (issue #1748).
 * All share the folded-corner sheet outline so the family reads as one set.
 */
const FILE_OUTLINE =
  'M4 1.75h4.5L12.25 5.5v8.25a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2.25a.5.5 0 0 1 .5-.5Z';
const FILE_CORNER = 'M8.5 1.75V5.5h3.75';

/** Generic document (folded-corner sheet). */
export function FileIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
    </svg>
  );
}

/** Text document — sheet with body lines (doc / word / pdf). */
export function FileTextIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
      <path d="M5.75 8.5h4.5M5.75 10.75h4.5" strokeLinecap="round" />
    </svg>
  );
}

/** PDF — text sheet with a filled label tag to distinguish it from a plain doc. */
export function FilePdfIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
      <rect x="5" y="8.5" width="6" height="3.25" rx="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Printer — the "send to print dialog" affordance (issue 1970). */
export function PrinterIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M4.5 6V2.75h7V6" strokeLinecap="round" />
      <path d="M4.5 11.5h-1A1.5 1.5 0 0 1 2 10V7.5A1.5 1.5 0 0 1 3.5 6h9A1.5 1.5 0 0 1 14 7.5V10a1.5 1.5 0 0 1-1.5 1.5h-1" />
      <rect x="4.5" y="10" width="7" height="3.25" rx="0.5" />
      <path d="M11.5 8.25h0.75" strokeLinecap="round" />
    </svg>
  );
}

/** Spreadsheet — sheet with a small grid. */
export function FileSpreadsheetIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
      <path d="M5.5 8.25h5M5.5 11h5M8 8.25V11" />
    </svg>
  );
}

/** Image file — sheet with a sun + mountain. */
export function FileImageIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
      <circle cx="6.5" cy="9" r="0.9" />
      <path d="M5 12.75l2-2 1.25 1.25L9.75 10.5l1.75 2.25" strokeLinecap="round" />
    </svg>
  );
}

/** Presentation — sheet with a slide bar chart. */
export function PresentationIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d={FILE_OUTLINE} />
      <path d={FILE_CORNER} strokeLinecap="round" />
      <path d="M6 12v-1.5M8 12V9M10 12v-2.25" strokeLinecap="round" />
    </svg>
  );
}

/** Folder — the "folder / multi-file" affordance. */
export function FolderIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M1.75 4a1 1 0 0 1 1-1h3l1.5 1.75h5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1V4Z" />
    </svg>
  );
}

/** Paperclip — the generic attachment affordance (replaces 📎). */
export function PaperclipIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13 7.5l-5.4 5.4a3 3 0 0 1-4.24-4.24l5.65-5.66a2 2 0 0 1 2.83 2.83l-5.66 5.65a1 1 0 0 1-1.41-1.41L9.7 5" />
    </svg>
  );
}

/**
 * Sliders — three tracks with offset handles; the "Display / adjust what you
 * see" affordance for the Schedule Display menu (#1741). Distinct from the
 * `SettingsIcon` cog (which reads as "configuration"), this reads as
 * "filter/adjust the current view".
 */
export function SlidersIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      {...rest}
    >
      <line x1="2" y1="4" x2="14" y2="4" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2" y1="12" x2="14" y2="12" />
      <circle cx="5.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Circled "i" — the "more information about this field" affordance (issue 1975) */
export function InfoIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="6.25" />
      <line x1="8" y1="7.25" x2="8" y2="11" />
      <circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Pencil — inline "edit this value" affordance (e.g. the drawer duration cell, issue 2106) */
export function PencilIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L5 13l-2.75.75L3 11z" />
      <line x1="10" y1="4" x2="12" y2="6" />
    </svg>
  );
}

/** Check mark — marks the currently-selected row in a chooser/help list (issue 1975) */
export function CheckIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <polyline points="3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

/** Cross mark — fail/reject status signal (issue 1749) */
export function XMarkIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

/**
 * Half-filled circle — the "partially met" middle band of a three-state outcome,
 * between CheckIcon (met) and XMarkIcon (missed). Replaces the `◐` glyph (issue 1749).
 *
 * The outline is stroked and the left half filled, so the mark reads as partial at
 * chip size where a shaded fill would just look like a lighter dot.
 */
export function HalfCircleIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Small filled dot — marks the selected row of a **radio** group in a menu, where
 * CheckIcon marks a checkbox row. Replaces the `●` glyph (issue 1749).
 *
 * Distinct from CriticalDotIcon: that one is a semantic critical-count badge at a
 * fixed 8px, this one scales with the surrounding text like the other row marks.
 *
 * `filled` is the state, not a style choice: the solid dot and the hollow ring
 * are the `●`/`○` pair the glyphs carried — selected vs unselected in a radio
 * group, and "counted" vs "still pending acceptance" on the board. Rendering
 * both from one component keeps the two states the same size and optical
 * weight, which two separate glyphs never guaranteed.
 */
export function RadioDotIcon({
  className,
  filled = true,
  ...rest
}: IconProps & { filled?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? undefined : 'currentColor'}
      strokeWidth={filled ? undefined : 1.5}
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="3.5" />
    </svg>
  );
}

/**
 * Price-tag outline with a stroked eyelet — the Labels settings row (issue 2425).
 *
 * The eyelet is stroked rather than filled: a filled dot of this radius closes up
 * into a blob at the 16px rail size, and the row then reads as a generic marker.
 */
export function TagIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M7.73 2.53H3.47a.93.93 0 0 0-.93.93v4.27c0 .27.13.47.27.67l5.2 5.2c.4.4 1 .4 1.33 0l4.27-4.27c.4-.4.4-1 0-1.33l-5.2-5.2a.93.93 0 0 0-.67-.27Z" />
      <circle cx="5.4" cy="5.4" r=".93" />
    </svg>
  );
}

/**
 * Struck-through eye — the Signal privacy settings row (issue 2425).
 *
 * Never tint this red. Signal privacy is a setting a team opts into, not an alarm
 * state; a critical tint would make a deliberate configuration read as a fault.
 */
export function EyeOffIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M6.87 4.53A6.6 6.6 0 0 1 8 4.4c3.73 0 6 3.6 6 3.6a11.6 11.6 0 0 1-1.73 2.07" />
      <path d="M4.4 5.27C2.8 6.33 2 8 2 8s2.27 3.6 6 3.6c1.07 0 2-.27 2.8-.67" />
      <path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" />
      <path d="M2.8 2.8 13.2 13.2" />
    </svg>
  );
}

/**
 * Framed panel with a tab bar and one divider — the Surfaces settings row (issue 2425).
 *
 * Deliberately asymmetric so it does not read as BoardIcon, whose three equal
 * columns mean "kanban board" elsewhere in the product.
 */
export function LayoutIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <rect x="2.27" y="2.93" width="11.47" height="10.13" rx="1.33" />
      <path d="M2.27 6.27h11.47M6.4 6.27v6.8" />
    </svg>
  );
}

/**
 * Two-prong plug — the Integrations settings row (issue 2425).
 *
 * The prong gap is held wide enough that the two strokes stay separable at 16px;
 * a tighter gap fills in and the glyph reads as a solid block.
 */
export function PlugIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M6 2.27v2.87M10 2.27v2.87" />
      <path d="M4.4 5.13h7.2v1.93a3.6 3.6 0 0 1-7.2 0V5.13Z" />
      <path d="M8 10.67v3.07" />
    </svg>
  );
}

/**
 * Three linked nodes — the Sharing settings row (issue 2425).
 *
 * A share *network*, not an arrow leaving a box: sharing grants access inside
 * TruePPM, so ExternalLinkIcon (which means "this leaves the app") is wrong here.
 */
export function ShareIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <circle cx="11.87" cy="3.87" r="1.53" />
      <circle cx="4.13" cy="8" r="1.53" />
      <circle cx="11.87" cy="12.13" r="1.53" />
      <path d="M5.53 7.27 10.47 4.67M5.53 8.73 10.47 11.33" />
    </svg>
  );
}

/** Bolt — the board's "stale" signal: work sitting in a column past its SLA. */
export function BoltIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8.75 1.5 3.5 9h3.5l-.75 5.5L12.5 7H9l-.25-5.5Z" />
    </svg>
  );
}

/** Flag — the board's critical-path / negative-float signal. */
export function FlagIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <line x1="3.75" y1="1.75" x2="3.75" y2="14.25" />
      <path d="M3.75 2.75h7.5l-1.75 3 1.75 3h-7.5" />
    </svg>
  );
}

/**
 * Balance scale — the "this note is a decision" marker, replacing the `⚖` glyph.
 *
 * The pans are open triangles rather than filled bowls: a filled pan collapses
 * into a blob at chip size, while the two hanging Vs still read as a scale. They
 * are 4 units wide so the V stays open at 14px — below that the strokes converge
 * and the mark closes up, so do not render this under `h-3.5`. Kept inside the
 * 1.75–14.25 safe area the rest of the set uses so it does not optically outsize
 * its neighbors.
 */
export function ScaleIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 2.75v10.5" />
      <path d="M5.25 13.25h5.5" />
      <path d="M2.75 5.25h10.5" />
      <path d="M1.75 9.25h4L3.75 5.25Z" />
      <path d="M10.25 9.25h4L12.25 5.25Z" />
    </svg>
  );
}

/**
 * Memo — a sheet whose top-right corner is open to a pencil, replacing the `📝`
 * note-freshness marker.
 *
 * Deliberately NOT `FileTextIcon`: that mark is the mime-type glyph for a text
 * document and appears on attachment rows in the same drawer, so reusing it for
 * "this task has notes" would give one silhouette two meanings a few rows apart.
 */
export function NoteIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13 8.5v5.25H3V2.25h5.25" />
      <path d="M5.75 7.75h4" />
      <path d="M5.75 10.5h2.75" />
      <path d="m10.75 1.9 2.9 2.9-3.4 3.4H8.5V6.4z" />
    </svg>
  );
}

/** Repeat loop — the recurrence affordance, replacing the `🔁` glyph. */
export function RepeatIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M3.25 7V6a2 2 0 0 1 2-2h5.5" />
      <polyline points="9,2.25 11.25,4 9,5.75" />
      <path d="M12.75 9v1a2 2 0 0 1-2 2h-5.5" />
      <polyline points="7,10.25 4.75,12 7,13.75" />
    </svg>
  );
}

/**
 * Five-point star — the "in the demo list" marker, replacing the `★`/`☆` pair.
 *
 * `filled` is the state, not a style choice: the outline star means "not picked
 * for the demo" and the solid one means "picked", the same two-state contrast
 * the glyph pair carried.
 */
export function StarIcon({ className, filled = false, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 1.9l1.85 3.75 4.15.6-3 2.93.71 4.12L8 11.36l-3.71 1.94.71-4.12-3-2.93 4.15-.6z" />
    </svg>
  );
}

/** Trending down — the board's behind-on-earned-value signal. */
export function TrendDownIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M1.75 4.5 6 8.75l2.5-2.5 5.75 5.75" />
      <polyline points="14.25,8 14.25,12 10.25,12" />
    </svg>
  );
}

/**
 * Filled diamond — the milestone mark, replacing the `◆` glyph (issue 1749).
 *
 * Milestones are zero-duration, so the diamond is the one schedule shape that
 * means "a date, not a span"; it is echoed on the Gantt, the calendar chip, the
 * outline grid, and the planning bridge, which is why it is one shared icon
 * rather than a per-surface glyph.
 */
export function MilestoneIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      {...rest}
    >
      <path d="M8 1.75 14.25 8 8 14.25 1.75 8z" />
    </svg>
  );
}

/**
 * Outline square — the plain-task counterpart to {@link MilestoneIcon} in the
 * outline grid and the changelog's object-type column. Replaces `□` (issue 1749).
 */
export function SquareIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" />
    </svg>
  );
}

/**
 * Dotted-outline check — the seeded-and-untouched row mark in the outline margin
 * (#2731, ADR-0799 §4). Deliberately distinct from {@link MilestoneIcon}: a
 * dashed, not solid, ring reads as provisional — "a machine wrote this, nobody
 * has looked yet" — the same disposability the seed banner states in words. Never
 * shown for a row a person has since edited (`Task.isUntouchedSeed`, ADR-0786);
 * it disappears the moment anyone touches the row, same as the delete offer.
 */
export function SeededUntouchedIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <circle cx="8" cy="8" r="5.5" strokeDasharray="2 1.75" />
      <path d="M5.5 8.2 7.2 9.9 10.5 6.4" />
    </svg>
  );
}

/** Waste basket — the destructive row-menu action, replacing `🗑` (issue 1749). */
export function TrashIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.75 4.25h10.5" />
      <path d="M6.25 4.25V2.75h3.5v1.5" />
      <path d="M4.25 4.25l.6 8.4a.9.9 0 0 0 .9.85h4.5a.9.9 0 0 0 .9-.85l.6-8.4" />
      <path d="M6.75 7v4M9.25 7v4" />
    </svg>
  );
}

/** Speech bubble — the "someone commented" activity mark, replacing `💬` (issue 1749). */
export function CommentIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13.75 9.5a1.75 1.75 0 0 1-1.75 1.75H7L4 13.75V11.25h-.25A1.75 1.75 0 0 1 2 9.5V4.5a1.75 1.75 0 0 1 1.75-1.75h8.25A1.75 1.75 0 0 1 13.75 4.5z" />
    </svg>
  );
}

/**
 * Crossed hammer and wrench — the "work in progress" board lens, replacing the
 * `⚒` glyph (issue 1749). The missing icon for this mark is what stalled the
 * CalmToolbar and BoardLensBanners conversions in the earlier slices (#2480).
 */
export function ToolsIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.25 13.75 8 8" />
      <path d="M9.75 3.25a2.75 2.75 0 0 0 3.6 3.6l-4.6 4.6" />
      <path d="M11.5 13.75 6.5 8.75" />
      <path d="M4.75 2.25 2.25 4.75l2.5 2.5 2.5-2.5z" />
    </svg>
  );
}

/** Counter-clockwise arrow — "un-mark complete", replacing `↺` (issue 1749). */
export function UndoIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M3.25 8a4.75 4.75 0 1 0 1.4-3.35L2.75 6.5" />
      <polyline points="2.75,3 2.75,6.5 6.25,6.5" />
    </svg>
  );
}

/** Ticked box — "mark complete" on a row menu, replacing `☑` (issue 1749). */
export function CheckboxIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13.25 8v4a1.25 1.25 0 0 1-1.25 1.25H4A1.25 1.25 0 0 1 2.75 12V4A1.25 1.25 0 0 1 4 2.75h6" />
      <polyline points="5.5,7.75 8,10.25 13.75,4.5" />
    </svg>
  );
}

/** Arrow into a bar — indent a task one WBS level, replacing `⇥` (issue 1749). */
export function IndentIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.25 8h6.5" />
      <polyline points="6.25,5.5 8.75,8 6.25,10.5" />
      <path d="M12.75 3.25v9.5" />
    </svg>
  );
}

/** Arrow out of a bar — outdent a task one WBS level, replacing `⇤` (issue 1749). */
export function OutdentIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13.75 8h-6.5" />
      <polyline points="9.75,5.5 7.25,8 9.75,10.5" />
      <path d="M3.25 3.25v9.5" />
    </svg>
  );
}

/** Arrow up-and-right — "add predecessor", replacing `↗` (issue 1749). */
export function ArrowUpRightIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M4.25 11.75 11.75 4.25" />
      <polyline points="5.5,4.25 11.75,4.25 11.75,10.5" />
    </svg>
  );
}

/** Arrow down-and-left — "add successor", replacing `↙` (issue 1749). */
export function ArrowDownLeftIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M11.75 4.25 4.25 11.75" />
      <polyline points="10.5,11.75 4.25,11.75 4.25,5.5" />
    </svg>
  );
}

/**
 * Arrow into a tray — "download this attachment", replacing `⬇` (issue 1749).
 *
 * Paired with ExternalLinkIcon on the attachment row: the same control is either
 * a download or an open-externally depending on the attachment kind, so the two
 * marks have to read as siblings.
 */
export function DownloadIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 2.25v7.5" />
      <polyline points="4.75,6.5 8,9.75 11.25,6.5" />
      <path d="M2.75 12.25h10.5" />
    </svg>
  );
}

/** Left arrow — "removed from sprint" in the activity feed, replacing `←` (issue 1749). */
export function ArrowLeftIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M13.25 8H2.75" />
      <polyline points="6.5,3.75 2.75,8 6.5,12.25" />
    </svg>
  );
}

/** Opposed arrows — "moved between sprints", replacing `⇄` (issue 1749). */
export function SwapIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M2.75 5.5h10.5" />
      <polyline points="10.5,2.75 13.25,5.5 10.5,8.25" />
      <path d="M13.25 10.5H2.75" />
      <polyline points="5.5,7.75 2.75,10.5 5.5,13.25" />
    </svg>
  );
}

/** Overlapping sheets — "duplicate this row", replacing `⎘` (issue 1749). */
export function CopyIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.25" />
      <path d="M10.25 5.75V4A1.25 1.25 0 0 0 9 2.75H4A1.25 1.25 0 0 0 2.75 4v5A1.25 1.25 0 0 0 4 10.25h1.75" />
    </svg>
  );
}

/**
 * Burst — the "nothing left to worry about" empty state, replacing `🎉`
 * (issue 1749). Celebratory rather than status-bearing: it is always paired with
 * text that carries the meaning.
 */
export function CelebrationIcon({ className, ...rest }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5" />
      <path d="M3.6 3.6l1.75 1.75M10.65 10.65l1.75 1.75M12.4 3.6l-1.75 1.75M5.35 10.65 3.6 12.4" />
    </svg>
  );
}

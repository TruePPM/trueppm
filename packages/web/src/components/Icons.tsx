/**
 * TruePPM icon set — all inline SVG, no external dependency.
 *
 * All icons use a 16×16 viewBox and inherit color via `currentColor`.
 * Pass `className` and `aria-hidden="true"` at the call site.
 */

export interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
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

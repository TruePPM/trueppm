/**
 * TruePPM icon set — all inline SVG, no external dependency.
 *
 * All icons use a 16×16 viewBox and inherit color via `currentColor`.
 * Pass `className` and `aria-hidden="true"` at the call site.
 */

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
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

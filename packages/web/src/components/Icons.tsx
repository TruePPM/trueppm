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
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="1" y="2"  width="9"  height="2.5" rx="1.25" />
      <rect x="1" y="6.75" width="14" height="2.5" rx="1.25" />
      <rect x="1" y="11.5" width="6"  height="2.5" rx="1.25" />
    </svg>
  );
}

/** Kanban board — three vertical columns */
export function BoardIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="1"  y="2" width="4" height="9"  rx="1" />
      <rect x="6"  y="2" width="4" height="6"  rx="1" />
      <rect x="11" y="2" width="4" height="12" rx="1" />
    </svg>
  );
}

/** List — three horizontal rows with a left dot each */
export function ListIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <circle cx="2.5" cy="4"  r="1.25" />
      <rect   x="5"   y="3"   width="10" height="2" rx="1" />
      <circle cx="2.5" cy="8"  r="1.25" />
      <rect   x="5"   y="7"   width="10" height="2" rx="1" />
      <circle cx="2.5" cy="12" r="1.25" />
      <rect   x="5"   y="11"  width="7"  height="2" rx="1" />
    </svg>
  );
}

/** Calendar */
export function CalendarIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={className} {...rest}>
      <rect x="1.5" y="3" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="1.5" y1="7" x2="14.5" y2="7" stroke="currentColor" strokeWidth="1" />
      <line x1="5"  y1="1.5" x2="5"  y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="11" y1="1.5" x2="11" y2="4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Resources — two person silhouettes */
export function ResourcesIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <circle cx="5.5" cy="4.5" r="2.5" />
      <path d="M0.5 13c0-2.76 2.24-5 5-5s5 2.24 5 5" />
      <circle cx="12" cy="4.5" r="2" opacity="0.55" />
      <path d="M10.5 9c1.66.55 2.8 2.1 2.8 3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" opacity="0.55" />
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
      <path d="M11 1.5L13.5 4L11 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Warning triangle — for at-risk badge */
export function WarningIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} {...rest}>
      <path d="M6 1L11.5 10.5H0.5L6 1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <line x1="6" y1="5"   x2="6" y2="7.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
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
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="1" y="2"   width="8"  height="2" rx="1" />
      <rect x="3" y="6"   width="6"  height="2" rx="1" />
      <rect x="3" y="10"  width="9"  height="2" rx="1" />
      <rect x="5" y="13.5" width="5" height="1.5" rx="0.75" />
    </svg>
  );
}

/** Shield — risk register icon */
export function RiskIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <path d="M8 1L2 3.5V8c0 3.31 2.55 5.8 6 6.85C11.45 13.8 14 11.31 14 8V3.5L8 1zm0 2.1l4 1.6V8c0 2.37-1.72 4.27-4 5.22C5.72 12.27 4 10.37 4 8V4.7l4-1.6z" />
    </svg>
  );
}

/** Overview / dashboard home icon */
export function OverviewIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
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
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className={className} {...rest}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" />
    </svg>
  );
}

/** Bar chart — three ascending columns for the Reports tab */
export function BarChartIcon({ className, ...rest }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className={className} {...rest}>
      <rect x="1"  y="8"  width="4" height="7" rx="1" />
      <rect x="6"  y="4"  width="4" height="11" rx="1" />
      <rect x="11" y="1"  width="4" height="14" rx="1" />
    </svg>
  );
}

/** Logo mark — mini Gantt bars forming a "T" silhouette */
export function LogoMark({ className, ...rest }: IconProps) {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="currentColor" className={className} {...rest}>
      <rect x="0" y="0"    width="10" height="3" rx="1.5" />
      <rect x="3" y="5.5"  width="15" height="3" rx="1.5" />
      <rect x="0" y="11"   width="7"  height="3" rx="1.5" />
    </svg>
  );
}

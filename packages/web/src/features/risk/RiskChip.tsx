import type { Risk } from '@/api/types';

interface SeverityLevel {
  label: string;
  classes: string;
}

function getSeverityLevel(severity: number): SeverityLevel {
  // Rule 86: severity chip color mapping. The HIGH chip uses `text-brand-accent-text`
  // (#92400E, ≥6:1 on the accent-light tint) — NOT `text-brand-accent-dark`
  // (#C17A10), which is a fill/border weight and only 3.13:1 as text on the tint
  // (WCAG 1.4.3 fail fixed in #2197).
  if (severity >= 20) {
    return { label: 'Critical', classes: 'text-semantic-critical bg-semantic-critical-bg' };
  }
  if (severity >= 12) {
    return {
      label: 'High',
      classes:
        'text-brand-accent-text dark:text-brand-accent bg-brand-accent-light dark:bg-brand-accent/20',
    };
  }
  if (severity >= 6) {
    return { label: 'Medium', classes: 'text-neutral-text-primary bg-brand-accent-light/50' };
  }
  if (severity >= 2) {
    return { label: 'Low', classes: 'text-neutral-text-secondary bg-neutral-surface-raised' };
  }
  // severity === 1: Minimal — use text-neutral-text-secondary per rule 87
  // (text-neutral-text-disabled on bg-neutral-surface-sunken fails WCAG at 1.97:1)
  return { label: 'Minimal', classes: 'text-neutral-text-secondary bg-neutral-surface-sunken' };
}

interface RiskChipProps {
  severity: Risk['severity'];
  /** When true, appends " · {score}" after the label (e.g. "High · 16"). */
  showScore?: boolean;
  className?: string;
}

export function RiskChip({ severity, showScore, className }: RiskChipProps) {
  const { label, classes } = getSeverityLevel(severity);

  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded-chip text-xs font-medium',
        classes,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {label}
      {showScore ? ` · ${severity}` : ''}
    </span>
  );
}

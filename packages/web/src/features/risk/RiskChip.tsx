import type { Risk } from '@/api/types';

interface SeverityLevel {
  label: string;
  classes: string;
}

function getSeverityLevel(severity: number): SeverityLevel {
  // Rule 86: severity chip color mapping. All combinations achieve WCAG 4.5:1 on neutral-surface.
  if (severity >= 20) {
    return { label: 'Critical', classes: 'text-semantic-critical bg-semantic-critical-bg' };
  }
  if (severity >= 12) {
    return {
      label: 'High',
      classes:
        'text-brand-accent-dark dark:text-brand-accent bg-brand-accent-light dark:bg-brand-accent/20',
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

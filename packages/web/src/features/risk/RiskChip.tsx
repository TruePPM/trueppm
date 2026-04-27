import type { Risk } from '@/api/types';

interface SeverityLevel {
  label: string;
  classes: string;
}

function getSeverityLevel(severity: number): SeverityLevel {
  // Rule 86: severity chip color mapping. All combinations achieve WCAG 4.5:1 on neutral-surface.
  if (severity >= 20) {
    return { label: 'CRITICAL', classes: 'text-semantic-critical bg-semantic-critical/10' };
  }
  if (severity >= 12) {
    return { label: 'HIGH', classes: 'text-brand-accent-dark dark:text-brand-accent bg-brand-accent-light dark:bg-brand-accent/20' };
  }
  if (severity >= 6) {
    return { label: 'MEDIUM', classes: 'text-neutral-text-primary bg-brand-accent-light/50' };
  }
  if (severity >= 2) {
    return { label: 'LOW', classes: 'text-neutral-text-secondary bg-neutral-surface-raised' };
  }
  // severity === 1: MINIMAL — use text-neutral-text-secondary per rule 87
  // (text-neutral-text-disabled on bg-neutral-surface-sunken fails WCAG at 1.97:1)
  return { label: 'MINIMAL', classes: 'text-neutral-text-secondary bg-neutral-surface-sunken' };
}

interface RiskChipProps {
  severity: Risk['severity'];
  /** When true, appends " · {score}" after the label (e.g. "HIGH · 16"). */
  showScore?: boolean;
  className?: string;
}

export function RiskChip({ severity, showScore, className }: RiskChipProps) {
  const { label, classes } = getSeverityLevel(severity);

  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold',
        classes,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {label}{showScore ? ` · ${severity}` : ''}
    </span>
  );
}

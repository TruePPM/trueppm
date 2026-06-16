import type { ComponentType, ReactNode, SVGProps } from 'react';

export interface EmptyStateProps {
  /** Surface icon (from components/Icons) — rendered decoratively in a circle. */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Short, encouraging heading — the warm replacement for a bare "No data" line. */
  title: string;
  /** Optional one- or two-sentence orientation copy. */
  description?: ReactNode;
  /** Optional CTA(s) — typically a primary <Button> that starts the empty surface. */
  action?: ReactNode;
  /** Extra container classes (e.g. `h-full` when the host must fill its area). */
  className?: string;
}

/**
 * Shared warm empty / first-run state (issue 1171, design-system-v2 row 10).
 *
 * Single source for the v2 empty-state anatomy — icon-in-circle, heading,
 * orientation copy, optional CTA — so cold "No data" strings across primary
 * surfaces read consistently. Surfaces with bespoke needs (role-flavored copy,
 * multiple CTAs) may still roll their own; this covers the common case.
 *
 * Motion: the whole block does a single subtle fade+lift on mount via
 * `motion-safe:animate-empty-state-in`, so it never animates under
 * `prefers-reduced-motion` (the v2 motion contract — motion only, never content).
 * `role="status"` announces the state to assistive tech; the icon is decorative.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={`flex flex-1 flex-col items-center justify-center px-6 py-16 text-center motion-safe:animate-empty-state-in ${className}`}
    >
      <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary">
        <Icon aria-hidden="true" className="h-8 w-8" />
      </div>
      <h2 className="mt-5 text-[17px] font-semibold text-neutral-text-primary">{title}</h2>
      {description && (
        <p className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-neutral-text-secondary">
          {description}
        </p>
      )}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

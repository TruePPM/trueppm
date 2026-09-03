import type { ComponentType, ReactNode, SVGProps } from 'react';

import { useEmptyStateAnnouncement } from './emptyStateAnnouncements';

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
 * Announcement: the block itself carries **no role and no live region**. It
 * announces its title through the shell's one persistent polite region
 * (`EmptyStateAnnouncer`, ADR-0989) on the transition *into* empty, so a
 * remount at unchanged emptiness — a route change, a project switch, a filter
 * edit that leaves the surface empty — says nothing, and four empty blocks on
 * one surface say it once. The icon stays decorative and the `<h2>` stays a
 * real heading, reachable by heading navigation (#3198).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: EmptyStateProps) {
  useEmptyStateAnnouncement(title);

  return (
    <div
      // Stable handle for specs that used to scope on the removed `role="status"`
      // (rule 242's re-anchor recipe). The block has no role of its own by design.
      data-testid="empty-state"
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

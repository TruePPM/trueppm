import type { ComponentType, ReactNode, SVGProps } from 'react';

import { TYPE } from './page2/typeScale';
import { useEmptyStateAnnouncement } from './emptyStateAnnouncements';

interface WarmEmptyStateProps {
  /** `warm` (default) — the centered v2 block with an icon-in-circle. */
  variant?: 'warm';
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

interface PageEmptyStateProps {
  /**
   * `page` — the shell v2 Pass 2 empty state (rule 439): left-aligned, no
   * illustration, at most two actions. The tuple type is the "at most two":
   * a third action does not compile.
   */
  variant: 'page';
  icon?: never;
  title: string;
  description?: ReactNode;
  actions?: readonly [ReactNode] | readonly [ReactNode, ReactNode];
  className?: string;
}

export type EmptyStateProps = WarmEmptyStateProps | PageEmptyStateProps;

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
export function EmptyState(props: EmptyStateProps) {
  useEmptyStateAnnouncement(props.title);
  if (props.variant === 'page') return <PageEmptyState {...props} />;
  return <WarmEmptyState {...props} />;
}

function WarmEmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
}: WarmEmptyStateProps) {
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

/**
 * Pass 2 empty state. Left-aligned so it starts where the content it replaces
 * would have started, with no illustration: the Pass 2 audit found the centered
 * icon block read as a loading spinner on a wide sheet. Same announcement and
 * heading contract as the warm block (no role; the shell's polite region speaks).
 */
function PageEmptyState({ title, description, actions, className = '' }: PageEmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      data-variant="page"
      className={`flex flex-col items-start gap-2 py-8 text-left motion-safe:animate-empty-state-in ${className}`}
    >
      <h2 className={`${TYPE.section} text-p1-text-1`}>{title}</h2>
      {description && <p className={`max-w-[480px] ${TYPE.body} text-p1-text-2`}>{description}</p>}
      {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

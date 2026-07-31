import type { ComponentType, SVGProps } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';

export interface MethodologyEmptyStateProps {
  /** Both actions route relative to this — inert (no-op) while it is absent. */
  projectId: string | null | undefined;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  /** Primary CTA — routes to the view this project's methodology actually surfaces. */
  primaryLabel: string;
  primaryTo: string;
  className?: string;
}

/**
 * Explanatory empty state for a view the project's methodology preset hides from
 * the nav (issue #2619). Direct URL navigation to a methodology-hidden view is
 * deliberate policy (`methodologyTabs.ts` — "this is not how we work here", not
 * "this is not allowed"), so this never blocks the route. It replaces the generic
 * cold-start empty state's primary "start using this surface" CTA — which
 * actively invited the deviation the methodology preset exists to discourage —
 * with copy that names the mismatch and a primary action pointed at the view this
 * project's methodology actually surfaces. "Use it anyway" is demoted to a
 * secondary action that routes through Settings → Methodology (`#methodology`,
 * mirroring `ProjectOverviewPage`'s settings deep-links), so enabling the hidden
 * surface is a deliberate configuration decision, never an incidental click.
 */
export function MethodologyEmptyState({
  projectId,
  icon,
  title,
  description,
  primaryLabel,
  primaryTo,
  className,
}: MethodologyEmptyStateProps) {
  const navigate = useNavigate();
  return (
    <EmptyState
      className={className}
      icon={icon}
      title={title}
      description={description}
      action={
        <>
          <Button variant="primary" onClick={() => projectId && void navigate(primaryTo)}>
            {primaryLabel}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              projectId && void navigate(`/projects/${projectId}/settings#methodology`)
            }
          >
            Change methodology
          </Button>
        </>
      }
    />
  );
}

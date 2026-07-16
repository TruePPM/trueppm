/**
 * /programs/:programId/backlog — the program backlog (ADR-0069, #742).
 *
 * Replaces the former stub tab. Wires the shared controller and picks the
 * layout by viewport: the desktop two-pane (≥ md) or the distinct mobile
 * shell (< md). Page-level load/permission errors short-circuit before either
 * layout renders.
 *
 * The data layer is fixture-backed until ADR-0069's endpoints (#733/#737/#739)
 * land; the controller's hook signatures already match the API contract, so the
 * swap is local to `./hooks`.
 */

import { Link, useParams } from 'react-router';
import { QueryErrorState } from '@/components/QueryErrorState';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BacklogDesktop } from './components/BacklogDesktop';
import { MobileBacklogPage } from './components/mobile/MobileBacklogPage';
import { useBacklogController } from './hooks/useBacklogController';

export function ProgramBacklogPage() {
  const { programId } = useParams<{ programId: string }>();
  const breakpoint = useBreakpoint();
  const controller = useBacklogController(programId);

  // A transient load failure (not a permission/existence problem) gets the shared
  // Retry surface (web-rule 246 / #1996). forbidden/not-found are terminal and
  // keep their bespoke guidance below.
  if (controller.errorKind === 'generic') {
    return <QueryErrorState message="Couldn't load the backlog." />;
  }

  if (controller.errorKind) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-neutral-text-primary">
          {controller.errorKind === 'forbidden'
            ? "You don't have access to this program's backlog"
            : 'This program no longer exists'}
        </h2>
        <p className="mt-2 text-sm text-neutral-text-secondary">
          {controller.errorKind === 'forbidden'
            ? 'Ask a program admin to grant you access.'
            : 'It may have been deleted.'}
        </p>
        <Link
          to="/programs"
          className="mt-6 inline-block text-sm font-medium text-brand-primary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Back to programs
        </Link>
      </div>
    );
  }

  if (controller.isLoading) {
    // Shape skeleton (web-rule 248 / #1996): a role="status" ghost of the header
    // + a few list rows so the layout doesn't jump when data lands, and the E2E
    // paint gate resolves on this node detaching (not on a "Loading…" string).
    return (
      <div
        role="status"
        aria-label="Loading backlog…"
        className="flex h-full flex-col bg-app-canvas"
      >
        <div className="border-b border-neutral-border bg-neutral-surface-raised px-6 py-4">
          <div
            aria-hidden="true"
            className="h-3 w-28 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken"
          />
          <div
            aria-hidden="true"
            className="mt-2 h-5 w-24 motion-safe:animate-pulse rounded-chip bg-neutral-surface-sunken"
          />
        </div>
        <div className="flex-1 space-y-2 px-6 py-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={`backlog-skeleton-${i}`}
              aria-hidden="true"
              className="h-10 motion-safe:animate-pulse rounded-card bg-neutral-surface-sunken"
            />
          ))}
        </div>
      </div>
    );
  }

  return breakpoint === 'sm' ? (
    <MobileBacklogPage controller={controller} />
  ) : (
    <BacklogDesktop controller={controller} />
  );
}

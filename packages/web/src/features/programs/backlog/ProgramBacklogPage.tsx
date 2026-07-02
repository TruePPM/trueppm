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
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BacklogDesktop } from './components/BacklogDesktop';
import { MobileBacklogPage } from './components/mobile/MobileBacklogPage';
import { useBacklogController } from './hooks/useBacklogController';

export function ProgramBacklogPage() {
  const { programId } = useParams<{ programId: string }>();
  const breakpoint = useBreakpoint();
  const controller = useBacklogController(programId);

  if (controller.errorKind) {
    return (
      <div className="mx-auto max-w-md px-6 py-16 text-center">
        <h2 className="text-base font-semibold text-neutral-text-primary">
          {controller.errorKind === 'forbidden'
            ? "You don't have access to this program's backlog"
            : controller.errorKind === 'not-found'
              ? 'This program no longer exists'
              : "Couldn't load the backlog"}
        </h2>
        <p className="mt-2 text-sm text-neutral-text-secondary">
          {controller.errorKind === 'forbidden'
            ? 'Ask a program admin to grant you access.'
            : controller.errorKind === 'not-found'
              ? 'It may have been deleted.'
              : 'Try reloading the page.'}
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
    return (
      <div className="flex h-full flex-col bg-app-canvas">
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
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-neutral-text-secondary">Loading backlog…</span>
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

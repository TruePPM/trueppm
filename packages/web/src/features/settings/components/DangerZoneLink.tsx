/**
 * Lightweight signpost from a General settings page to its Archive / Delete page
 * (#977).
 *
 * Replaces the old full "Danger zone" card on Workspace General — the destructive
 * actions (export, transfer ownership, archive, delete) live solely on the dedicated
 * Archive / Delete page, which is always reachable via the DANGER nav section. A full
 * card here only duplicated that nav entry and padded the page; a single inline link
 * is the lighter discoverability hook. Kept identical across Workspace / Program /
 * Project General so the three scopes stay consistent.
 */

import { Link } from 'react-router';

interface DangerZoneLinkProps {
  /** Route to this scope's Archive / Delete page (absolute or router-relative). */
  to: string;
}

export function DangerZoneLink({ to }: DangerZoneLinkProps) {
  return (
    <div className="px-6 pb-10 max-w-[720px]">
      <Link
        to={to}
        className="inline-flex items-center gap-1 text-[12px] text-neutral-text-secondary hover:text-neutral-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 rounded"
      >
        Go to Archive / Delete
        <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}

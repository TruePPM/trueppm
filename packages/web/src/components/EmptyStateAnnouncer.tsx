import { useEffect, useSyncExternalStore } from 'react';

import {
  getEmptyStateAnnouncement,
  resetEmptyStateAnnouncerSession,
  subscribeEmptyStateAnnouncement,
} from './emptyStateAnnouncements';

/**
 * The one persistent polite live region every empty surface speaks through
 * (#3198, ADR-0989).
 *
 * Mounted once in `AppShell`, permanently and empty, so a message is injected
 * into a node that was already in the accessibility tree — the requirement
 * web-rule 335 states and the reason relocating `role="status"` off
 * `EmptyState` without a persistent host would have fixed nothing.
 *
 * Being single is also what satisfies "N empty blocks announce once": the
 * registry coalesces, and there is no second region to race it.
 */
export function EmptyStateAnnouncer() {
  // The region must enter the tree EMPTY. The store outlives this component
  // (module-level, and `AppShell` does unmount — logout, or a throw reaching the
  // `RequireAuth` net), so a remount would otherwise render carrying the last
  // session's sentence.
  useEffect(resetEmptyStateAnnouncerSession, []);

  const message = useSyncExternalStore(
    subscribeEmptyStateAnnouncement,
    getEmptyStateAnnouncement,
    getEmptyStateAnnouncement,
  );

  return (
    <div aria-live="polite" role="status" className="sr-only" data-testid="empty-state-announcer">
      {message}
    </div>
  );
}

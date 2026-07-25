/**
 * Debounced screen-reader announcement for a filter result count. ADR-0620, #2383.
 *
 * A filter panel that stays open across selections changes the result count on
 * every click. Announcing each one immediately makes a polite live region read a
 * stream of half-finished counts — the user hears "18 of 214… 22 of 214… 26 of
 * 214" while still picking. Holding the message for 600ms after the last change
 * means they hear the count once, for the selection they actually settled on.
 *
 * `''` while settling is deliberate: the caller renders the returned string into
 * an `aria-live="polite"` node, and an empty node announces nothing.
 */

import { useEffect, useState } from 'react';

/** Matches the type-ahead reset window in {@link LabelFacet} so the two feel of a piece. */
const ANNOUNCE_DELAY_MS = 600;

export function useFilterAnnouncement(message: string, delayMs = ANNOUNCE_DELAY_MS): string {
  const [announced, setAnnounced] = useState('');

  useEffect(() => {
    if (!message) {
      setAnnounced('');
      return undefined;
    }
    const timer = setTimeout(() => setAnnounced(message), delayMs);
    return () => clearTimeout(timer);
  }, [message, delayMs]);

  return announced;
}

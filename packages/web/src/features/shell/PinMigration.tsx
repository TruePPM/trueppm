/**
 * Mount point for the one-time legacy-pin upload (#2390, ADR-0627).
 *
 * A component rather than a bare hook call in `AppShell` for the same reason
 * `SettingsHotkey` is one: the `AppShell` function body runs *outside*
 * `QueryClientProvider`, and this migration invalidates the pins query when it
 * finishes (#2298). Rendering it as a child puts it inside the provider.
 *
 * Renders nothing.
 */
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePinMigration } from '@/hooks/usePinMigration';

export function PinMigration() {
  const { user } = useCurrentUser();
  // Gate on a resolved user: every POST is authenticated, so running before the
  // session is known would spend the one-shot migration on a burst of 401s and
  // then stamp the sentinel as if it had succeeded.
  usePinMigration(!!user);
  return null;
}

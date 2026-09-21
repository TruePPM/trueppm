import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { editionQueryOptions, type DemoLoginHint, type EditionResponse } from './useEdition';

/**
 * Whether this deployment is a read-only demo, and the credential it publishes
 * (ADR-1197 D3/D4, #3926).
 *
 * Rides the existing `GET /api/v1/edition/` on the shared `['edition']` query key
 * rather than a new discovery endpoint: the mode is needed **before** login (the login
 * screen announces it), and this is the one endpoint the shell already calls
 * unauthenticated. `staleTime: Infinity` makes it the session's only fetch, and the
 * post-login shell reads the same cached entry.
 *
 * A build-time global was the other candidate and is wrong: the mode is a property of
 * the *deployment*, and the same image serves the demo and a normal install.
 */
export function useDemoMode(): {
  isDemoReadOnly: boolean;
  loginHint: DemoLoginHint | null;
  isLoading: boolean;
} {
  const { data, isLoading, isError } = useQuery(editionQueryOptions);
  // A failed `/edition/` read is NOT an error surface (rule 246 does not apply): every
  // consumer here is a *withdrawal* — a banner, a panel, a disabled control — and the
  // safe default for all three is "this is a normal install". Rendering a
  // QueryErrorState would put a red retry on a login screen to report that we could
  // not confirm the absence of a demo. So the failure is read, and deliberately
  // collapsed to the same answer as "no server ever said it was a demo".
  const resolved = isError ? undefined : data;
  return {
    isDemoReadOnly: resolved?.demo_read_only ?? false,
    loginHint: resolved?.demo_login_hint ?? null,
    isLoading,
  };
}

/**
 * The same fact for the modules that cannot hold a hook — the axios response
 * interceptor and the mutation `onError` callbacks that decide whether a refusal may
 * write the preview overlay.
 *
 * Reads the cache the hook fills rather than firing its own request: by the time any
 * write is possible the shell has long since resolved `['edition']`. An unresolved
 * cache reads as `false`, which is the safe default — the overlay (and the demo toast)
 * stay off on a deployment whose mode is not yet known.
 */
export function isDemoReadOnlySync(): boolean {
  return queryClient.getQueryData<EditionResponse>(['edition'])?.demo_read_only === true;
}

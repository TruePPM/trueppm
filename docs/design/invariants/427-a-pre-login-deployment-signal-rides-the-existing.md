# Rule 427 — A pre-login deployment signal rides the existing `['edition']` query, through vanilla axios

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md), section *Surface states*. The index carries the rule's headline; this file carries its full text. Binding everywhere, not only on the surface that produced it.

**A fact about the *deployment* that a surface needs before the user has signed in is served on `GET /api/v1/edition/`, read on the shared `['edition']` query key, through the one exported `editionQueryOptions` in `src/hooks/useEdition.ts`.** Not `apiClient` (its 401 interceptor fires on the first unauthenticated load), not a second discovery endpoint, and not a build-time global.

**Not a build-time global**, because the same image serves a demo deployment and a normal install: `__APP_VERSION__` and friends describe the *build*, and a mode describes the *deployment*. Baking it in makes the two indistinguishable and the value untestable against a running server.

**One options object, not three hand-copied `queryFn`s.** `useEdition`, `useBuildInfo` and `useDemoMode` all read the same response; three copies of the fetcher is how one cache entry becomes two network calls, and nothing fails when it does. `useDemoMode.test.tsx` pins it: mounting two of the hooks together issues exactly one request.

**Public routes have a `QueryClientProvider` at `RootLayout`, deliberately.** `AppShell` provides one for the authenticated tree; before #3926 there was none anywhere else, so any `useQuery` on `/login` threw "No QueryClient set" straight into the route error boundary — a whole-page crash, not a degraded panel. `RootLayout` now provides the **same client instance**, so the shell's provider nests over it as a no-op. Adding a query to a public route is therefore allowed; adding a second `QueryClient` is not.

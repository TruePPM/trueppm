# Rule 472 — A public share page is chromeless, linkless, and has one unavailable state

> **Invariant.** Indexed from [`packages/web/CLAUDE.md`](../../../packages/web/CLAUDE.md). The index carries the rule's headline; this file carries its full text (#3150).

**A page reached by a share token (`/share/<kind>/:token`) (a) renders outside the app shell with no navigation, no `<a>` into the workspace and a visible "Read-only" label; (b) fetches only its anonymous share endpoint, with bare `axios`, never `apiClient`; (c) mounts `useNoReferrer()`; (d) prints only what that endpoint returned, never a value it derived from live data; and (e) when the server folds every unavailable outcome into one `404` (status-update links), shows one "not available" state and does not branch on the response body.**

**Why.** The token is a capability in the URL. A link into the workspace hands the holder a URL that either 401s or, worse, leaks the token through `Referer` to a page that logs it. `apiClient` attaches a bearer token and runs the session-expiry flow, which a signed-in recipient would turn into an authenticated request from a public page. The server's uniform `404` exists so a holder of a revoked link cannot be told apart from a guesser; a client that reads the `detail` to pick different copy rebuilds the oracle the server removed.

**How to apply.** Reference: `PublicStatusUpdateSharePage` in `src/features/share/PublicStatusUpdateSharePage.tsx`. The e2e spec `e2e/status-update-share.spec.ts` asserts zero anchors, zero navigation landmarks and no request to a non-public API path. The board and schedule viewers predate the rule: their `410` states are deliberate (ADR-0245) and stay, since those links are not uniform-404.

# ADR-0313: Jira connect flow — PAT-based in-page wizard, not an OAuth route sequence (#1421)

## Status
Accepted

## Context

ADR-0097 introduced a user-scoped, read-only external task-source registry
(`EXTERNAL_TASK_SOURCES`) so a contributor can pull the items assigned to them from
their own account into **My Work**. #1418/#1419 shipped its data layer (per-source
PAT connection endpoints + the read-only pull worker) and #1420 (ADR-0291) shipped the
**Available sources** section of the personal Connected Accounts page — deliberately
*registry + live connection-state only*, leaving the connect/manage flow as an explicit
seam for #1421 (a non-interactive "Coming soon" pill, never a dead-click button).

#1421 was filed against a **stale OAuth premise** that does not match shipped reality:

1. It specified four dedicated routes (`/…/jira/connect`, `/syncing`, `/connected`,
   `/manage`) and a "Continue to Atlassian" full-page OAuth redirect with a
   callback + `auth/` + `auth-status/` endpoints. **None of that exists.** The dedicated
   routes existed for exactly one reason — to survive the OAuth full-page redirect that
   destroys React state.
2. Per ADR-0097 the OAuth 3LO flow is on the **Enterprise** side of the boundary; the OSS
   backend is **PAT-based** (`PUT /me/connections/jira/` with `{secret, base_url,
   account_email, jql, project_keys}`, verified server-side against `/rest/api/3/myself`
   before the token is stored). #1419/#1420 already committed to PAT; the imported design
   JSX (`jira-connect-pages.jsx`) even labels its authorize screen a "generic OAuth
   consent" stand-in.

So #1421 cannot be built as literally written without either inventing an OAuth backend
(new work) or crossing the Apache-2.0 boundary. The design intent — a guided
connect → configure → connected → manage experience — is still valid; only its OAuth
scaffolding is dead.

## Decision

Fill the #1420 seam with a **PAT-based, in-page dialog wizard**, not a route sequence.

- **Surface = in-page dialog on the Jira source card.** With no OAuth redirect to survive,
  dedicated routes are cost without benefit. The Connected Accounts page already
  establishes the in-page dialog pattern (`ConnectCredentialDialog`, ADR-0049); this
  mirrors it. The "Connect" affordance replaces the gated "Coming soon" `<span>` on an
  `available` source; the connected state (Active pill, cached-item count, Sync now,
  Disconnect, recently-pulled list) renders inline on the same card. "Manage" collapses
  into the inline card actions rather than a separate screen.
- **Wizard steps map to the single `PUT`.** Step 1 collects the credential (site URL,
  account email, API token) with the read-only / never-writes-back reassurance framing
  from the design. Step 2 ("what to pull") collects `assignee = currentUser()` (default)
  vs. a custom JQL filter, plus an optional project-key filter — both are real backend
  `config` fields. Submit issues one `PUT`, shows a "Connecting…" state while it (and a
  first `POST …/sync/`) resolve, then dismisses. A `422` (bad credential/host) surfaces
  inline on the credential step using the backend `detail`.
- **Drop the unbacked "sync frequency" control.** The design's Every-15-min/Hourly/Manual
  selector has no backing field (sync cadence is server-scheduled + manual "Sync now").
  Per the #1420 precedent, we do not ship a dead control; per-user cadence would be a
  separate backend change.
- **First-sync feedback is data-driven, not a polling route.** A connection that is
  `connected` but has a null `last_synced_at` renders a "First sync in progress" hint;
  the item list and connection summary are invalidated after connect + on "Sync now".

## Consequences

- #1421 ships as a tight, boundary-correct MR against the API that actually shipped, with
  no new backend and no OAuth. The four-route reading is explicitly not built.
- The only capability given up vs. the literal spec is bookmarkable per-step URLs, which
  have no value for a one-time personal connect.
- Follow-ups (not in scope): live sync progress polling / WS event for first sync; a
  per-user sync-frequency backend field; GitHub as a second OSS source (registry already
  lists it `coming_soon`).
- The stale OAuth wording in the #1421 issue is superseded by this ADR; the imported
  design's PAT-shaped screens (registry → authorize → configure → connected) are the
  reference, with "authorize" realized as the credential step.

# ADR-0291: "Available sources" section on the personal Connected Accounts page (#1420)

## Status
Accepted

## Context

ADR-0097 (§1) introduced a user-scoped, read-only external task-source registry
(`EXTERNAL_TASK_SOURCES`) so a contributor can pull the items assigned to them from
their own account (e.g. Jira Cloud) into **My Work**. #1418 shipped its data layer:
per-source PAT-based connection endpoints `GET/PUT/DELETE /api/v1/me/connections/<source>/`
and `POST .../sync/`. The OSS registry registers exactly one source — `jira`
(`OSS_EXTERNAL_TASK_SOURCES = (JiraCloudSource,)`). #1422 shipped the consumer side:
My Work already renders `external_items` / `external_sources` via `useMyWork()` and
`ExternalWorkItemRow`.

What is **missing** is the management surface ADR-0076 (Open Questions §2) anticipated:
a personal **Connected Accounts** page where a user sees which external sources are
available and which they have connected. ADR-0097 (line 17) states it "fills the
personal 'Connected Accounts' surface ADR-0076 anticipated," and ADR-0076 scoped that
surface as "read-only summary → CRUD inline."

#1420 was originally specified against three assumptions that do **not** match shipped
reality, which is why it was blocked pending this re-scope:

1. It assumed an aggregate `GET /api/v1/me/integrations/sources/` endpoint. Reality:
   per-source `GET /me/connections/<source>/` only; a GET for an unregistered source
   returns `400`.
2. It assumed a brand-new `/settings/me/connected-accounts` route. Reality: a
   **Connected Accounts page already ships** for a *different* feature — #587 / ADR-0049
   task-link-preview credentials (`TASK_LINK_PROVIDERS`: gitlab/github), routed at
   `me/settings/connected-accounts` with vitest + Playwright coverage. `TASK_LINK_PROVIDERS`
   and `EXTERNAL_TASK_SOURCES` are **distinct registries**: `jira` is Enterprise-reserved
   in the former and OSS-owned in the latter (ADR-0097 §1).
3. It assumed an OAuth Jira connect flow (#1421). Reality: the shipped backend is
   **PAT-based** (API token + account email + `*.atlassian.net` base URL). #1421 (the
   dedicated connect/manage flow) is unbuilt.

**P3M layer:** Operations (Priya, the individual contributor connecting her own source).
**Repo:** OSS — user-scoped, one-way, read-only personal pull is the ADR-0097 OSS carve-out.

VoC (focused panel, avg 7.3/10, no 🔴): Priya 7 🟡 ("a Connect button that does nothing
is friction"), Nadia 8 🟢 (renders off the existing contract, no schema churn), Sarah 7 🟢
(read-only/one-way respects Jira as *their* source of truth). The one 🟡 — do not ship a
dead-click Connect — is a hard constraint on this design.

## Decision

Append a **non-destructive** "Available sources" section to the **existing** #587
`ConnectedAccountsPage` (`packages/web/src/features/me/ConnectedAccountsPage.tsx`). This
is faithful to ADR-0076/§0097's surface-sharing intent and does not touch the shipped
`TASK_LINK_PROVIDERS` section, its slot, its hash anchors, or its tests.

1. **Static OSS registry** — new `packages/web/src/features/integrations/registry.ts`
   exporting `EXTERNAL_TASK_SOURCES`, an array of
   `{ provider, name, description, status: 'available' | 'coming_soon' }`. It lists **only
   OSS-owned sources**: `jira` (`available`) and `github` (`coming_soon`, the natural next
   OSS source per ADR-0097's own logic — user-scoped, one-way, read-only). It must **not**
   hard-code Enterprise sources (`servicenow`, `azure_devops`): those register dynamically
   through the existing `user_settings.connected_accounts` widget-registry slot at
   `AppConfig.ready()` and render via the already-present `EnterpriseProviderSlots`
   component. Keeping the static list to OSS-registered/OSS-planned sources is the boundary
   guarantee.

2. **Live connection-state display** — for each `available` source, read its connection
   state via `GET /me/connections/<source>/` (new `useExternalConnection(source)` hook).
   `exists: true` → "Active" badge + last-synced note; otherwise → not connected. A non-200
   (e.g. `400` for a source the backend doesn't register) is treated as *not connected /
   unavailable*, never an error surfaced to the user. `coming_soon` sources are **not
   fetched** — there is nothing to connect yet. This is the "read-only summary" ADR-0076
   scoped, and it is forward-compatible: once #1421 lands and a user connects, the section
   reflects "Active" with no rewrite.

3. **Connect gated as "Coming soon" for this slice** — the connect/manage flow is #1421's
   scope (and must itself be re-scoped to the shipped PAT model, not OAuth). Until it
   lands, the per-source affordance is an unmistakable non-interactive **"Coming soon"**
   ghost pill — *not* a live-looking button (resolves the Priya 🟡 dead-click). An already-
   connected source shows a passive "Active" state, no live Manage action yet.

4. **Trust framing** — the section header carries the ADR-0097 invariant as
   non-interactive badges: **read-only · one-way into My Work · never writes back**. This
   is what resolves the Priya↔Sarah source-of-truth tension (Jira stays *theirs*; TruePPM
   never writes back).

If the existing personal-settings nav lacks a "Connected accounts" entry, add one
(non-destructively) so the page is reachable without a deep link — verified at
implementation time.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Append "Available sources" to the existing #587 page (chosen)** | Faithful to ADR-0076/0097 surface-sharing; non-destructive; reuses `SourceMark`, the widget-registry slot, and existing tests; one Connected Accounts surface, not two | Two conceptually-distinct registries share one page — must be visually sectioned so a user isn't confused about "credentials for link previews" vs "sources feeding My Work" |
| B. New separate route/page for external sources | Clean conceptual separation | Two "Connected accounts"-flavored pages is exactly the fragmentation ADR-0097 says to avoid; duplicates nav; the #1420 spec's `/settings/me/...` route scheme was never adopted |
| C. Wire a PAT-connect modal now (skip the gate) | Section is immediately functional | Collides head-on with #1421's scope; doubles the surface area of this slice; #1421 owns connect/manage/verify/sync error handling — building it twice invites drift |
| D. Add an aggregate `GET /me/integrations/sources/` endpoint first | One fetch for all sources | Backend work outside a frontend-only slice; unnecessary when OSS registers exactly one fetchable source; premature abstraction |
| E. List all providers (incl. Enterprise) as "coming soon" | Richer-looking section | Hard-codes Enterprise source names into OSS — an Apache-2.0 boundary leak; Enterprise sources must self-register via the slot |

## Consequences

- **Easier:** #1421 lands into a ready-made surface — it only wires the connect/manage
  flow; the registry, state display, and trust framing already exist. My Work's
  connect→pull loop (#1422) gains its missing front door. Enterprise sources appear
  automatically via the untouched widget-registry slot.
- **Harder:** One page now hosts two registries; the sectioning and copy must keep them
  distinct. A reviewer must confirm the new section does not perturb #587's tests
  (hash anchors `#provider-*`, `data-testid="enterprise-connected-accounts-slot"`).
- **Risks:** (1) The `github` "coming soon" entry is a soft roadmap signal, not a
  commitment — it is clearly non-actionable and trivially removable if descoped. (2) The
  `useExternalConnection` fetch must fail *soft* (non-200 → not-connected) so a backend
  that doesn't register a listed `available` source never shows an error. (3) The gated
  Connect must read as "not yet," never as broken — the VoC-mandated design constraint.

## Implementation Notes
- **P3M layer:** Operations (individual contributor, personal source).
- **Affected packages:** web only. (`registry.ts`, a `useExternalConnection` hook,
  additions to `ConnectedAccountsPage.tsx`, reuse of `SourceMark`; possibly a nav entry.)
- **Migration required:** no.
- **API changes:** no — consumes the shipped `GET /me/connections/<source>/` (#1418).
- **OSS or Enterprise:** OSS. Enterprise sources register dynamically via the
  `user_settings.connected_accounts` slot; the OSS static registry lists only OSS sources.

### Durable Execution
This is a read-only frontend feature with no async side effects — it renders a static
registry and a single GET. Every item below is N/A for that reason.
1. Broker-down behaviour: N/A — no dispatch; no write path.
2. Drain task: N/A — no async work.
3. Orphan window: N/A — no outbox rows.
4. Service layer: N/A — no backend change; reads the existing `ExternalConnectionView`.
5. API response on best-effort dispatch: N/A — read-only GET, standard 200/4xx.
6. Outbox cleanup: N/A — no outbox rows.
7. Idempotency: N/A — GET is nullipotent; the section holds no client-mutable state.
8. Dead-letter / failure handling: N/A — a non-200 from `GET /me/connections/<source>/`
   degrades to "not connected" in the UI; there is no queued work to fail.

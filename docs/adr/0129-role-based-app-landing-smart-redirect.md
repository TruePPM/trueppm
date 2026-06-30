# ADR-0129: Role-based app landing — server-resolved smart redirect

## Status
Accepted — implemented on main; status corrected 2026-06-30 after ADR audit (verified: default_landing)

## Context

Today the web app's front door — what a user sees on login or when hitting `/` —
is a single project's **Project Overview** (`/projects/:id/overview`). `RootRedirect`
in `router.tsx` redirects `/` to the *first* project's overview; `ADR-0030`
designated Overview as the canonical landing surface and §3 of that ADR specified a
post-login decision tree keyed on **edition + portfolio project count**.

A VoC panel (8 personas) evaluated three options for the front door:

- **Option A** — My Work as the universal default. Avg 5.75.
- **Option B** — keep Overview as the universal default. Avg 3.38.
- **Option C** — role-based smart redirect. Avg **6.75 — chosen.**

The decision (Option C) is already made; this ADR designs the implementation, not the
choice. The forces the panel surfaced and that this design must honor:

- 🔴 **A PM status page as the universal front door is an adoption blocker.** For Morgan
  (Agile Coach) it reads as a surveillance tool → performative adoption → data rot. For
  Marcus (PMO, 40 projects) a single bookmarked project is meaningless. For Priya (Team
  Member — whose *non-adoption is the primary failure mode*) a PM cockpit is the wrong
  first impression. The front door must adapt to who you are.
- 🟡 **Route by ROLE, not by project count.** ADR-0030 §3's "multi-project → portfolio /
  single-project → overview" proxy misfires: a single-project *contributor* still wants
  My Work; a multi-project *PM* still wants project context. Project count is the wrong
  proxy for role. **This ADR supersedes ADR-0030 §3.**
- 🟡 **Escape hatch is required.** The default must be user-overridable (Morgan): a
  `default_landing` preference, ideally set by a one-time first-login prompt and editable
  in profile settings. A user-set preference converts a distrusted algorithm into an
  opt-in — the voluntary-adoption path.
- 🟡 **ADR-0104 privacy tension.** My Work is a *cross-program* personal aggregation. The
  signal-privacy model (ADR-0104) guards against exposing a developer's multi-team
  workload without consent. The landing redirect must not itself become a new leak vector
  — but note that `/me/work/` already exists and already returns the user's own
  cross-project tasks (it is *self*-scoped, the canonical low-risk case), so this ADR adds
  no new aggregation; it only changes *who lands there by default*.

### What this ADR does and does not change about ADR-0030

This is **not a reversal of ADR-0030.** Overview remains the canonical **project-level**
landing: `/projects/:id/` still redirects to `/projects/:id/overview`, the view-tab order
still leads with Overview (web-rule 108), and a PM-type user still lands on Overview by
default. What changes is narrow:

- **Superseded:** ADR-0030 §3 (the post-login *app front-door* decision tree keyed on
  edition + portfolio project count) and the `TRUEPPM_PORTFOLIO_LANDING_MIN_PROJECTS`
  threshold. The app front door is now role-resolved, not count-resolved.
- **Preserved:** ADR-0030 §1 (Overview page + route), §2 (Enterprise portfolio route via
  ADR-0029 slot registry), §4–7 (breadcrumb, drill-down drawer, mobile portfolio, widget
  hooks). Overview is still *a* landing — just not the *universal* one.

### P3M layer

The landing **resolution** sits at the Programs-and-Projects / Operations layer (it reads
the user's own per-project roles and own task surface — OSS). The portfolio landing
*target* sits at the Portfolio layer (Enterprise). The OSS core must resolve to an OSS
surface for every user and never hard-depend on the Enterprise portfolio route existing.

## Decision

### 1. Landing is a server-resolved fact on `/auth/me/`

The role→surface resolution runs **server-side** and is exposed as a new field, `landing`,
on the existing `MeSerializer` (`GET /api/v1/auth/me/`). The React `RootRedirect` and
`loginRedirectDest` become *dumb*: they read `me.landing` and navigate to the path it
names. No role→surface policy lives in the router.

This follows the API-first principle (CLAUDE.md): every value a client needs is a server
fact, so an MCP client or the mobile app resolves the same landing without re-implementing
the policy. `MeSerializer` already exposes `max_project_role` / `workspace_role` /
`can_access_admin_settings` for exactly this reason (gating admin chrome without per-project
fan-out, ADR-0122); `landing` is the natural sibling.

The `landing` field is a small object:

```jsonc
// GET /api/v1/auth/me/  →  (additive fields)
{
  // ...existing identity + role fields...
  "default_landing": "auto",        // the user's stored preference (echo of the model field)
  "landing": {
    "intent": "my_work",            // "my_work" | "project_overview" | "portfolio"
    "path": "/me/work",             // the concrete client route to navigate to
    "resolved_by": "role_policy"    // "preference" | "role_policy" | "fallback"
  }
}
```

- `intent` is the *semantic* target (stable across clients; web/mobile map it to their own
  route). `path` is the concrete web route the router navigates to (convenience so the web
  router does zero mapping). `resolved_by` is for explainability/telemetry — it tells the
  UI whether the destination came from the user's own choice, the role policy, or a
  fallback, so the first-login prompt and "why am I here?" affordances are honest.
- The web client navigates to `landing.path`. Mobile maps `intent` to its native route.

### 2. Role→surface resolution policy

Resolution is a pure function of (a) the stored `default_landing` preference, (b) the
user's per-project / per-program role ordinals, (c) the running edition, and (d) whether
the user has any project memberships. RBAC is **per-project** — a user can be OWNER on one
project and MEMBER on another — so there is no single "the user's role". We derive an
**app-level landing intent** as follows:

```
resolve_landing(user, edition):
    pref = user.profile.default_landing            # see §3

    # 1. An explicit preference always wins (the escape hatch, Morgan's 🟡).
    if pref == "my_work":            return ("my_work",          /me/work,                         "preference")
    if pref == "project_overview":   return ("project_overview", overview(recent_project) or /me/work, "preference")
    if pref == "portfolio" and edition == "enterprise" and has_portfolio_access(user):
                                     return ("portfolio",        portfolio_path,                   "preference")
    # pref == "portfolio" without entitlement falls through to role policy (degrade cleanly)

    # 2. No memberships at all → onboarding (brand-new / just-invited user).
    if not user_has_any_project_membership(user) and not user_has_program_membership(user):
        return ("my_work", /me/work, "fallback")   # /me/work renders the empty/onboarding state, not a 404

    # 3. AUTO (pref is the "auto" sentinel) → role policy.
    max_role = max_project_role(user)              # already computed by MeSerializer

    #   PMO / Exec tier → portfolio when entitled, else My Work.
    if edition == "enterprise" and has_portfolio_access(user):
        return ("portfolio", portfolio_path, "role_policy")

    #   PM-type (SCHEDULER / ADMIN / OWNER on ANY project) → most-recently-active Overview.
    if max_role is not None and max_role >= Role.SCHEDULER:        # 200+
        proj = most_recent_project(user)
        if proj is not None:
            return ("project_overview", overview(proj), "role_policy")
        return ("my_work", /me/work, "fallback")   # PM with role but no resolvable project

    #   Contributor-type (MEMBER / VIEWER, and the PO/SM facets) → My Work.
    return ("my_work", /me/work, "role_policy")
```

**Why `max_project_role >= SCHEDULER` is the PM/contributor cut-line.** The 5-role ladder
is VIEWER(0) / MEMBER(100) / SCHEDULER(200) / ADMIN(300) / OWNER(400). MEMBER and VIEWER are
contributor-tier — they edit/read their own assigned work, which is exactly the My Work
job-to-be-done. SCHEDULER and above hold cross-task planning authority (resource assignment,
dependency edit, baselines), which is the project-context job. We use the **max** ordinal
across all memberships, not a primary or per-project role, because the front door must serve
the *most authoritative thing the user does* — a user who is ADMIN on one project and MEMBER
on ten is still a PM and wants project context. (A contributor who is MEMBER everywhere lands
on My Work; a user who is OWNER of even one project lands on Overview.) This matches the
already-shipped `MeSerializer.max_project_role` semantic and `can_access_admin_settings`
(which also keys off "Admin+ in any project").

**Facets (ADR-0078) do not promote to PM.** The PO/SM facets are an orthogonal axis and are
held by people whose role ordinal is typically MEMBER. A Product Owner or Scrum Master is a
contributor-tier collaborator for *landing* purposes (their ideal homes — backlog, sprint
board — are out of scope here; see §7). So facets are deliberately **not** consulted in the
default policy; they would only matter once per-persona surfaces (Jordan→backlog,
Alex→sprint board) ship, at which point the *preference* options expand rather than the role
policy. This keeps the auto-policy a three-bucket function (contributor / PM / PMO) and
honors the panel's "route by role" constraint without over-fitting.

### 3. `default_landing` user preference — model and migration

There is **no custom user model** — the project uses Django's stock `auth.User`. There is
also no existing per-user profile/preferences table (notification preferences live in their
own `notifications_preference` table keyed by user; theme is client-side only). We therefore
add a dedicated **`UserProfile`** model in a new `apps/profiles` app (or, if a profile table
is added concurrently by another wave, a column on it — see Consequences), holding per-user
app preferences with a 1:1 to `auth.User`:

```python
# apps/profiles/models.py
class DefaultLanding(models.TextChoices):
    AUTO = "auto", "Automatic (based on your role)"
    MY_WORK = "my_work", "My Work"
    PROJECT_OVERVIEW = "project_overview", "Project Overview"
    PORTFOLIO = "portfolio", "Portfolio"          # resolves only when Enterprise + entitled

class UserProfile(models.Model):
    # NOT a VersionedModel: this is a personal app-preference, not a synced
    # board-scoped domain entity. It does not participate in the offline delta
    # protocol (no server_version), is never broadcast, and is read only via
    # /auth/me/. Keeping it out of sync avoids polluting the WatermelonDB schema
    # with a non-collaborative singleton.
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile"
    )
    default_landing = models.CharField(
        max_length=20, choices=DefaultLanding.choices, default=DefaultLanding.AUTO
    )
```

Migration safety:

- **UUID PK** per convention. **No `server_version`** — deliberately *not* a synced model
  (justified in the docstring above; the offline story for landing is handled differently,
  see §6).
- **NOT NULL with a default.** `default_landing` is NOT NULL with `default="auto"`, so the
  `AddField`/`CreateModel` migration backfills non-interactively. `"auto"` is the sentinel
  meaning "use the role policy" — it is the safe default that reproduces a sensible
  role-based front door for every existing user with zero data migration of intent.
- **Lazy creation.** A `UserProfile` row is created on demand: `MeSerializer` and the
  preference write endpoint use `UserProfile.objects.get_or_create(user=...)` so existing
  users (and users created by other code paths / invites) never need a backfill of rows —
  absence of a row is read as `default_landing="auto"`. This avoids a data migration that
  inserts a row per existing user and keeps invite/signup flows untouched.

A write endpoint exposes the preference: `PATCH /api/v1/auth/me/profile/`
`{ "default_landing": "my_work" }`. Permission: `IsAuthenticated`, object is always the
requesting user's own profile (no IDOR surface — the user can only ever write their own row;
there is no `:id` in the path).

### 4. Where resolution runs — server, not client (decided)

**Server-side, exposed as `me.landing`.** Justification:

1. **API-first (CLAUDE.md non-negotiable).** Role→surface logic encoded in `RootRedirect`
   would be invisible to MCP and mobile — the exact "domain logic stranded where an agent
   can't reach it" failure the AI-readiness gate guards against. The mobile app and any
   MCP client must resolve the same front door; a server fact gives them that for free.
2. **The inputs already live server-side.** `max_project_role`, edition entitlement, and
   "has any membership" are all server facts (some already on `MeSerializer`). Shipping them
   to the client just to recompute the policy there duplicates the logic and invites drift.
3. **Explainability.** `resolved_by` lets the UI honestly say "we sent you here because of
   your role" vs "because you chose this" — useful for the first-login prompt and trust.
4. **One source of truth for the policy** — the cut-lines (SCHEDULER threshold, portfolio
   entitlement) change in one place, not in parallel TS + Python.

The client keeps only the *navigation* (read `landing.path`, `navigate(...)`) and the
preference *form* (PATCH the field). It never decides the destination.

### 5. OSS / Enterprise boundary

- The role policy, the `my_work` and `project_overview` intents, and the `UserProfile`
  model are **OSS**.
- The `portfolio` intent resolves to a concrete path **only** when `edition == "enterprise"`
  **and** the user is portfolio-entitled. In OSS (community) edition, `has_portfolio_access`
  is always false, so the `portfolio` branch is never taken and a user who somehow has
  `default_landing == "portfolio"` (e.g. downgraded from Enterprise) **degrades cleanly to
  My Work** via the `role_policy`/`fallback` path. The OSS resolver imports nothing from
  `trueppm_enterprise`; `has_portfolio_access` is an OSS function that returns false unless
  the Enterprise overlay has registered a portfolio-access provider against an existing
  extension point (ADR-0029/0030 §2 mechanism) — the same one-way enterprise→core dependency.
- `grep -r "trueppm_enterprise" packages/` must stay at zero after implementation.

### 6. Edge cases

| Case | Resolution |
|------|-----------|
| **Zero memberships** (brand-new / just-invited) | `intent=my_work`, `path=/me/work`, `resolved_by=fallback`. `/me/work` already renders an empty state; it must show an onboarding/empty-state ("you have no assigned work yet"), not a blank list or 404. Never resolve to `/projects/new` here — that was an ADR-0030 behavior we drop; a freshly-invited contributor should not be pushed into project creation. |
| **Preference points at a surface the user can't reach** (e.g. `project_overview` but they've lost access to every project, or `portfolio` after an Enterprise downgrade) | The resolver **falls through** the preference branch when the target is unresolvable (no `most_recent_project`, or not portfolio-entitled) and continues into the role policy / fallback. The preference is honored *when possible*, never producing a dead route. `resolved_by` reports `fallback` so the UI can surface a one-time "your saved home isn't available, showing My Work" notice. |
| **No recently-active project** for a PM-type user | `most_recent_project` is best-effort: it uses the highest-`server_version` `ProjectMembership` (proxy for "most recently touched membership") and falls back to the alphabetically-first project, then to `/me/work` if truly none. **There is no server-side per-user "last visited project" today** — we deliberately do *not* add view-tracking telemetry for this (privacy + scope). The membership-version proxy is good enough for a default that the user can override. (See Open Questions.) |
| **Offline / mobile cold start** (Sarah, no signal) | `landing.intent` + the *last successful* `/auth/me/` payload are cached client-side (web: persisted query cache; mobile: WatermelonDB-adjacent KV). On cold start with no signal, the client navigates to the cached `landing.path`. **A `project_overview` landing caches cleanly** (a single project snapshot is already in the offline store). **A `my_work` landing is harder to cache** because it is a cross-project aggregate — so mobile, when offline and `intent==my_work`, lands on My Work backed by the locally-synced task rows (My Work is computed from tasks the device already has) and shows a "showing offline copy" banner; it never blocks on the network. The intent itself is cached, so the *destination* is deterministic offline even when the *content* is stale. |

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **Server-resolved `me.landing` + role policy + `default_landing` pref (chosen)** | API-first; one policy source; MCP/mobile parity; explainable; preference is a clean escape hatch | Adds a model + migration; resolver must be kept correct as roles/editions evolve |
| Client-side role→surface logic in `RootRedirect` | No backend change; ships fastest | Violates API-first; invisible to MCP/mobile; logic drifts across clients; re-fetches role data the server already has |
| Route by project count (ADR-0030 §3, status quo) | Already specified; no role lookup | **The VoC blocker** — misroutes single-project contributors and multi-project PMs; panel rejected it |
| My Work as universal default (Option A) | Simplest; contributor-friendly | Avg 5.75 < Option C; a PM logging in wants project context, not a task list; ignores the PMO/Exec tier |
| Store preference on `auth.User` via monkey-patch / extra columns | No new table | Can't add columns to stock `auth.User`; swapping to a custom user model mid-project is a high-risk migration out of scope for this change |

## Consequences

**Easier:**
- The front door fits the user; the three personas who rejected the PM-cockpit default
  (Morgan, Marcus, Priya) get a role-appropriate landing.
- The policy is one server function — MCP, mobile, and web agree by construction.
- Future per-persona surfaces (backlog, sprint board, allocation heat map) slot in as new
  `default_landing` preference values without touching the auto role policy.
- `UserProfile` gives the app a home for the *next* per-user app preference (currently
  scattered: theme is client-only, notifications have their own table).

**Harder:**
- A new model + migration + a new tiny app (`profiles`). Migration is additive and safe, but
  it is one more table.
- The resolver's cut-lines (SCHEDULER threshold, portfolio entitlement) are product decisions
  baked into code; changing them is a code change + test update, not config. (Deliberate — a
  configurable threshold is what made ADR-0030 §3 brittle.)
- `most_recent_project` is a proxy (membership `server_version`), not true last-visited
  telemetry; a PM with many projects may land on a not-truly-most-recent one until they set a
  preference. Acceptable for a default; flagged as a follow-up (real last-visited tracking).

**Risks:**
- **Drift between `me.landing` and the actual route table.** If `landing.path` names a route
  the web router doesn't have (typo, renamed segment), the user lands nowhere. Mitigate: the
  web client validates `landing.path` against a known prefix allowlist (`/me/work`,
  `/projects/`) and falls back to `/me/work` on a miss — same defensive posture as
  `loginRedirectDest`'s open-redirect guard. A unit test asserts every `intent` maps to a
  live route.
- **Privacy (ADR-0104).** Defaulting contributors to My Work increases how often the
  cross-project self-aggregate is shown, but it is *self*-scoped (the user's own tasks) — not
  a team or cross-program signal about *others*. No new consent surface is required. The
  resolver must not leak *another* user's landing or memberships (it only ever reads
  `request.user`). Confirmed: no IDOR surface, no team-signal exposure.
- **#1177 (v2 context bar, ADR-0127) already merged.** That work touched the shell —
  `router.tsx` (`RootRedirect`) and the rail/context-bar — and is now on `main` (commit
  `1e25e5056`). This ADR's frontend edits (`RootRedirect` reading `me.landing.path`,
  `loginRedirectDest`) build on top of the merged context bar; no sequencing barrier remains.
  Re-verify the current `RootRedirect` shape before editing. The backend (`MeSerializer`, new
  `profiles` app) is independent of the shell entirely.

## Implementation Notes

- **P3M layer:** Programs and Projects / Operations (resolution + My Work); Portfolio
  (Enterprise) for the `portfolio` target only.
- **Affected packages:** `api` (new `profiles` app + `MeSerializer` field + preference write
  endpoint), `web` (dumb `RootRedirect` + `loginRedirectDest` + a profile-settings control +
  first-login prompt). No `scheduler`, `helm`, or `mobile` change in this MR
  (mobile consumes `intent` when its landing work lands).
- **Migration required:** Yes — one additive migration creating `UserProfile`
  (`apps/profiles/migrations/0001_initial.py`). NOT NULL `default_landing` with
  `default="auto"`; UUID PK; no `server_version`. Lazy `get_or_create`, no per-user backfill.
- **API changes:** Yes.
  - `GET /api/v1/auth/me/` — additive fields `default_landing` (string) and `landing`
    (`{intent, path, resolved_by}`). Backwards-compatible; existing fields unchanged.
  - `PATCH /api/v1/auth/me/profile/` — `{default_landing}`. `IsAuthenticated`; writes only
    the caller's own profile.
  - `docs/api/openapi.json` regenerated (merge `origin/main` first per CLAUDE.md).
- **OSS or Enterprise:** OSS. Enterprise registers a portfolio-access provider against the
  existing extension point; OSS resolves `portfolio` to a path only when present + entitled.
- **OSS boundary verification:** `grep -r "trueppm_enterprise" packages/` returns zero.

### Durable Execution
1. **Broker-down behaviour:** N/A — the resolver is a synchronous read on `/auth/me/` and the
   preference write is a synchronous DB update. No async side effects, no task dispatch.
2. **Drain task:** N/A — no async work, so no drain.
3. **Orphan window:** N/A — no `transaction.on_commit()` dispatch.
4. **Service layer:** A pure `resolve_landing(user, edition)` helper in
   `apps/profiles/services.py` (no Celery), called by `MeSerializer`. Not a dispatch service.
5. **API response on best-effort dispatch:** N/A — the read is synchronous (`200` with the
   `landing` object); the preference write is synchronous (`200` with the updated profile).
6. **Outbox cleanup:** N/A — no outbox rows.
7. **Idempotency:** The preference write is idempotent by nature (PATCH sets a single field to
   a value; repeating it is a no-op). `get_or_create` on the profile is safe under concurrent
   first-write (the OneToOne unique constraint makes a double-insert a caught `IntegrityError`
   → re-fetch).
8. **Dead-letter / failure handling:** N/A — no background task to fail. A resolver exception
   must fail *open* to `my_work` (never 500 the front door); the resolver wraps its logic so
   any unexpected error returns the `("my_work", /me/work, "fallback")` triple.

### Files the implementation will touch

Backend (independent of the merged #1177 shell):
- `packages/api/src/trueppm_api/apps/profiles/__init__.py` *(new app)*
- `packages/api/src/trueppm_api/apps/profiles/apps.py` *(new)*
- `packages/api/src/trueppm_api/apps/profiles/models.py` *(new — `UserProfile`, `DefaultLanding`)*
- `packages/api/src/trueppm_api/apps/profiles/services.py` *(new — `resolve_landing`, `most_recent_project`, `has_portfolio_access` OSS stub)*
- `packages/api/src/trueppm_api/apps/profiles/migrations/0001_initial.py` *(new)*
- `packages/api/src/trueppm_api/settings/base.py` *(register `profiles` in `INSTALLED_APPS`)*
- `packages/api/src/trueppm_api/apps/access/serializers.py` *(`MeSerializer` — add `default_landing` + `landing`)*
- `packages/api/src/trueppm_api/apps/access/views.py` *(profile PATCH endpoint)*
- `packages/api/src/trueppm_api/apps/access/urls.py` *(route for the preference PATCH)*
- `docs/api/openapi.json` *(regenerated)*
- `packages/api/tests/apps/profiles/test_landing_resolution.py` *(new — policy matrix + edge cases)*
- `packages/api/tests/apps/access/test_me.py` *(extend — `me.landing` shape)*

Frontend (builds on the merged #1177 context bar):
- `packages/web/src/router.tsx` *(`RootRedirect` reads `me.landing.path`)*
- `packages/web/src/features/auth/LoginPage.tsx` *(`loginRedirectDest` defers to `me.landing` when `next` is absent)*
- `packages/web/src/hooks/useCurrentUser.ts` *(extend `CurrentUser` with `default_landing` + `landing`)*
- `packages/web/src/features/me/` *(profile-settings control for `default_landing`; first-login prompt component; My Work empty-state v2 refresh; landing-context hint)*
- new vitest for the redirect-from-landing logic
- `packages/web/e2e/landing-redirect.spec.ts` *(new — golden path per role bucket + preference override + zero-membership empty state)*

## Tracking

Tracking: #1181 (filed under epic #1163 — v2 staged adoption).

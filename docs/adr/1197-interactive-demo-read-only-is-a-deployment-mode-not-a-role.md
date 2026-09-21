# ADR-1197: The interactive demo's read-only guarantee is a deployment mode, not a role

## Status

Accepted — status corrected 2026-09-21 as the D3/D4 slice (#3926) landed, matching the
convention established by the #2539 audit (verified: `DemoReadOnlyMiddleware` in
`packages/api/src/trueppm_api/core/demo_read_only.py`, shipped by the D2 child #3924).
Proposed 2026-09-19. Amended 2026-09-20 — see **Amendment 2026-09-20** below. Resolves
#3912. Amends ADR-0658 — which continues to govern the share-link demo **unchanged** — for
one new mode only.

> **Implementation status.** Superseded, 2026-09-21: the paragraph below described the
> tree on 2026-09-19 and is kept because it is why several decisions here read as
> forward-looking. Since then D2 shipped (#3924 — `DemoReadOnlyMiddleware`, the
> deny-by-default method fence), D3/D4 shipped (#3926 — the refusal affordance, the
> preview overlay, the login and shell announcements, and the `demo_read_only` /
> `demo_login_hint` fields on `GET /api/v1/edition/`), and the chart-side
> `demo.interactive` work is #3925. Re-verify against the tree before citing the
> snapshot below as current.
>
> **Implementation status (2026-09-19):** **no code ships with this ADR.** Verified
> 2026-09-19 against `f502f488c` (0.4.0-beta.3, this branch's base): there is no `demo.interactive` values
> key in `packages/helm/values*.yaml`, no read-only middleware anywhere under
> `packages/api/src/trueppm_api/core/`, and `packages/helm/templates/web/configmap.yaml`
> renders two server blocks, not three.

## Context

**P3M layer:** Programs and Projects. This is a deployment shape, not a product feature —
it adds no entity and no user-facing capability to the platform itself.

ADR-0658 gave the hosted demo a security argument with one load-bearing sentence: *the
authenticated API is not protected on the public demo — it is **absent** from it.* D7a
renders an nginx route allowlist under which `/admin/`, `/ws/`, and every `/api/` route
except two anonymous share projections return 404. ADR-0658's own Risks section then
wrote the tripwire this ADR trips:

> Any future change that adds one — persona logins, an anonymous comment box, a writable
> sandbox — invalidates this ADR's reasoning and **must revisit it rather than inherit
> it**.

#3912 adds a persona login. So the premise is deleted, not extended, and nothing in
ADR-0658 carries over by default.

**What is actually wrong with the demo today.** The share-link demo shows a Gantt and a
board as pictures. TruePPM's pitch is that CPM is the engine: you change a duration or a
dependency and the whole downstream schedule moves. A visitor who never sees that has not
seen the product. This is a real problem and the motivation is sound.

**The finding that reshapes the design.** That differentiating interaction is *already
client-side*. `packages/web/src/hooks/useDragCpm.ts` spawns a Web Worker
(`packages/web/src/workers/cpmEngine.ts`, kept in conformance with the Python engine by
`cpmEngine.conformance.test.ts`) that runs incremental CPM forward passes during the
drag; the header states it plainly — *"Spawns a Web Worker for incremental CPM forward
passes … Commits the drop via PATCH on release."* Per ADR-0599 this is one of the three
sanctioned non-API paths: a preview, never persisted, reconciled by the server on commit.

**So for the scheduling pitch, read-only and convincing are not in tension.** A visitor
can drag a task and watch real CPM move every downstream date, with **zero server
writes** — only the commit PATCH needs refusing. For that headline claim the design
question is not "how much do we give up to be safe", it is "how do we refuse the commit
legibly".

**This does not generalize, and the ADR should not pretend it does.** The persona panel
(Consequences) found four personas needing four *different* write-time interactions, and
the local preview only covers the first: the schedule cascade (Sarah) is client-side;
resource over-allocation conflict detection (David), backlog grooming and sprint planning
(Jordan), and completing work to watch burndown and velocity react (Alex) are all
server-side and stay unavailable. This mode therefore demonstrates **the engine**, not
the full product. That is a real and accepted limitation, and it is the honest boundary
of what #1672 would have to solve.

**What the threat model found** (paired document, #3912; findings referenced by id):

- **T1** — `POST /projects/` is open to any authenticated user and mints the creator `Role.OWNER` (`apps/projects/views.py:1424-1457`, `:1698-1712`). This is deliberate and documented; the viewset docstring says *"Any authenticated user can create a project."* A published credential is therefore one request from Owner, and **no choice of seeded role can prevent it**, because the visitor does not stay inside the seeded project.
- **T2** — `login_account` throttles on the submitted **username** at 5/min across all source IPs (`settings/base.py:1492-1503`, added by #1717). One shared published username means a global 5/min login budget for the entire internet.
- **T4** — Owner-on-own-project satisfies the surviving `IsOrgAdmin`/`IsOrgScheduler` derivations (5 call sites remain; #3583, **0.5**, not fixed in 0.4), reaching shared `Calendar` and `Resource` catalog writes.
- **T5/T6** — api/worker egress is deliberately unrestricted (`packages/helm/templates/networkpolicy.yaml:21-25`); per-account throttles and quotas become shared-fate under one identity.
- **T3, corrected** — `/admin/` is already closed in depth by #3557 (`DJANGO_ADMIN_ENABLED` defaults False; `HardenedAdminSite` 404s; `values.yaml:922` sets it false). It does **not** depend on nginx and needed no new decision here.

The through-line: **every serious finding traces to authority being derived from the
account, and the account being a published secret.** Any design that enforces read-only
*through the account's role* is arguing with T1.

## Decision

### D1 — A third mode, a third server block — never a widened allowlist

`demo.interactive` is a new values key, distinct from `demo.enabled`. The share-link demo
is untouched and remains the safe fallback on its own hostname. `templates/web/configmap.yaml`
renders a **third** server block for this mode rather than patching either existing one —
the same reasoning D7a gave for not patching the production block, which applies with
more force here: *the difference that matters is which routes exist*, and a patch-style
diff makes it far too easy to reintroduce a blanket proxy later.

> **Amended 2026-09-20:** a demo that tours the full app reads from essentially every
> `GET` under `/api/v1/`, so the third block cannot be a narrow route list. It becomes a
> **method fence over `/api/`** that mirrors D2 at the edge, and D2, not the route list, is
> the real control. `/admin/` and `/ws/` stay closed. See the Amendment.

`/admin/` stays 404 at the edge (belt-and-braces over #3557's application-level default).
`/ws/` is **closed** in this mode: in a read-only instance the only broadcasts are the
scheduled re-seed's, so the socket carries nothing a visitor would see. Demonstrating
real-time collaboration needs mutually-isolated writable sessions, which is #1672.

The chart must also carry the **#3908** render-time guard, since that defect routes
`/api` and `/ws` straight past the web tier where the allowlist lives. This ADR's edge
decisions are void without it — **#3908 is a hard prerequisite, not a related issue.**

### D2 — Read-only is enforced by request-method middleware, fail-closed, keyed on the deployment mode

When `TRUEPPM_DEMO_READ_ONLY=true`, a middleware in `trueppm_api.core` refuses every
unsafe HTTP method (`POST`/`PUT`/`PATCH`/`DELETE`) reaching `/api/`, except a short,
explicit allowlist:

- `POST /api/v1/auth/token/` — login
- `POST /api/v1/auth/token/refresh/`
- `POST /api/v1/auth/logout/`

Everything else is refused **regardless of role, viewset, or permission class**.

**Why middleware and not a DRF permission class.** The obvious-looking implementation —
appending a `DemoReadOnly` class to `DEFAULT_PERMISSION_CLASSES` — **silently does
nothing on this codebase.** DRF's defaults are *replaced*, not merged, by any view that
sets `permission_classes` explicitly, and effectively every view here does. The guarantee
would be absent precisely where it was most needed, while looking present in settings.
Middleware runs ahead of the view and cannot be overridden per-view.

**Why this is the whole point.** It inverts the default for code that does not exist yet.
A new endpoint added in 0.5 by someone who has never heard of the demo is refused by
construction; under a role-based approach it would be permitted by construction and would
have to be noticed. It also makes T1 a non-event: `POST /projects/` is refused for the
same reason everything else is, with no special case to maintain and nothing to
re-audit when the `IsOrgAdmin` derivations finally move in #3583.

It also makes the acceptance criterion *"the write-path audit checklist passes with a
regression test per finding"* achievable as a **single parametrized test** that walks the
router's route table and asserts a refusal for every unsafe route, rather than a
hand-written list that rots. The route table is already enumerated for
`tests/apps/access/test_route_table_invariants.py`, so the harness exists.

### D3 — The refusal is a designed product surface, not an error

The middleware returns **403** with a stable machine-readable `code: "demo_read_only"`,
and the web app renders an explanatory affordance — *"Demo mode: your change was
calculated but not saved"* — not a generic red error toast.

This is a correctness requirement, not polish. A visitor who hits a silent failure or an
unexplained 403 concludes the product is broken, and a demo that makes the product look
buggy is worse than no demo. Copy is specified at implementation time with `ux-design`;
it is a new interaction pattern, so the frontend work takes the **Frontend-only feature**
fast-path row, not the settings-wiring row.

### D4 — The drag / keyboard CPM preview stays on, and is the demo's centerpiece

`useDragCpm` keeps running. The visitor drags, the worker recomputes, every downstream
bar moves, and only the commit PATCH is refused under D2. The previewed schedule **stays
on screen** with the D3 affordance rather than snapping back — a snap-back reads as a
bug and destroys exactly the impression the feature exists to create.

This is the decision that makes a read-only demo worth building. It should be stated in
the docs as the demo's headline: *change anything you like and watch the schedule
recompute; nothing is saved.*

**Scope it honestly in the copy.** The preview covers the schedule cascade and nothing
else. Do not let marketing generalize it to "try the product" — the panel's second-,
third- and fourth-ranked personas each need a server write the mode refuses, and a
visitor who arrives expecting to groom a backlog and cannot will read D3's refusal as the
product being broken, which is the exact failure D3 exists to prevent.

**Verified: there is enough seeded content to be worth touring.** The panel flagged as
unchecked whether the sample populates the surfaces its personas evaluate. Checked
2026-09-19 against `scripts/seeds/build_atlas_seed.py`: the seed carries `"resource"` +
`"units"` assignment rows (10 occurrences) — which is what capacity and utilization
actually read, rather than `Task.assignee` — plus sprints, epics, velocity and burndown
series. Read-only surfaces for the Resource Manager and Delivery Lead therefore render
populated, even though those personas cannot *act* on them.

### D5 — Exactly one seeded account; `--with-personas` is forbidden in this mode

`load_sample_project --with-personas` gives **every** persona in the sample the same
password (`apps/projects/seed/importer.py::_enable_existing_persona_login`). It refuses
staff and superuser rows, but **not** a persona holding a project or program `OWNER`/
`ADMIN` role — so a published password would be a published Project Admin credential.
This mode seeds one **Member** account (amended 2026-09-20; it was written as a viewer
account) and the chart fails fast if the persona flag is set. The seed scopes project
access by `ProjectMembership`, and a `ProgramMembership` reaches the program rail and no
project, so the account needs a program membership **and** a project membership on each
of the three projects. See the Amendment.

Verified mitigating fact worth recording, because it closes a whole family of abuse: the
seed importer creates **no `WorkspaceMembership`**, so `workspace_role_for_user` resolves
every persona to implicit workspace **MEMBER**. Workspace-admin surfaces are therefore
already refused — including invites (`apps/workspace/views.py:767-772`,
`IsWorkspaceAdminStrict`), which is what keeps the demo from becoming a spam relay.

### D6 — Per-account throttles are the wrong axis for a shared identity; say so and re-aim them

T2 is the finding most likely to take the demo down, and it fires **without an
attacker**: six genuine visitors in one minute exhaust a global 5/min login budget, and
an attacker holds the demo down indefinitely for 5 wrong-password requests a minute.

In this mode `TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE` is raised to a value chosen for
concurrency rather than for credential-stuffing resistance, and the reasoning is recorded
in the values file: **#1717's control protects a secret, and this credential is
published, so there is nothing left for it to protect.** The per-IP `login` scope and
`anon` scope stay at their normal values and become the real limiters, alongside
Cloudflare.

The same applies to `"user": "1000/min"` and to `MAX_PERSONAL_ACCESS_TOKENS`: both are
per-account, and under one shared identity they are shared-fate. They are re-aimed or
accepted explicitly, never left at a default that happens to mean something different
here than everywhere else.

### D7 — Egress is denied at the pod, not only in Python

`assert_url_allowed` (`apps/webhooks/serializers.py:212`) is a good control and stays.
But it is a Python allowlist on one path, and the chart documents the gap itself
(`networkpolicy.yaml:21-25`): *"The API and Celery worker pods are deliberately NOT
egress-restricted here … Restrict their egress at the platform layer if your environment
requires it."* A published login is that environment.

This mode renders an egress NetworkPolicy for api and worker allowing only DNS and the
in-cluster datastores. The demo needs no outbound: no IdP, no SMTP, no object storage, no
OTLP. `scripts/helm-netpol-drill.sh` (CI `helm:netpol`) already asserts egress-deny cases
on Calico, so the assertion extends an existing harness rather than inventing one.

### D8 — Cloudflare Access is bot reduction and an email list. It is not a security control in this design

Stated as a decision because the alternative is that it silently becomes a load-bearing
dependency nobody wrote down. Access is a **hostname** gate, not a route gate, and it is
passed by anyone with any working email address. It mitigates **none** of T1–T7. The
design must be safe with Access switched off, and the threat model was written on that
assumption.

Two consequences follow, and the second is sharper than it first appears.

Access collects visitor email addresses — a PII asset the project did not previously
hold, processed by a third party outside the self-hosted boundary, needing a retention
statement and a privacy-policy line.

And it sits in **direct tension with a positioning commitment the project has already
made**: #3760 establishes the public "no seat count, no feature flags, no telemetry"
self-hosting stance and requires that any demo-side data collection stay confined to the
demo host. The issue frames "yields an email list" as a benefit of Access; against #3760
it is also a cost, and the panel found it read as a credibility problem — *"what else is
collected that I wasn't told about"* — to the self-hosting operator persona who is
precisely the person who would deploy this. That is an owner's product call, not an
architectural one, and this ADR does not settle it. It only insists the trade be made
knowingly and that D8's first paragraph hold either way: **nothing in the security design
may depend on Access being present.**

### D9 — A scheduled reset bounds contamination; it prevents nothing

It caps how long any successful write or vandalism is visible at one reset interval. It is
not a control and must not be cited as mitigation for any finding.

> **Amended 2026-09-20:** the cadence is a values key, not a constant. This ADR was written
> for a nightly reset; the owner's proposal is every 6 hours. With D2 in place there is
> almost nothing to clean up, so the reset's real job is re-anchoring the sample dates (the
> seed anchors them to the import day so the demo reads as a program in flight) as well as
> containment. See the Amendment.

### D10 — Host isolation from CI is an acceptance criterion no gate can enforce

#3912 requires a separate host from CI runners, and it is right to. But per ADR-0658 D10
the instance runbook stays out of this repository, so **no CI job can verify it** — the
fact lives in a private runbook. This ADR names it as a deployment precondition with a
human owner rather than letting a green pipeline imply it was checked. It is the one
requirement here whose failure mode is a real incident and whose verification is
entirely out-of-band.

## Amendment 2026-09-20

Owner decisions and review findings after the ADR merged. They change the tracked children
(#3924 middleware, #3925 chart mode, #3926 web) and are recorded here so this ADR does not
keep asserting properties the design no longer has. Findings below marked *by code reading*
were not run in a browser.

1. **The demo account is a Member, not a Viewer.** A Member shows the comment composer,
   the attach control, the edit forms and Author mode, so the tour feels like the real
   product. **Security does not depend on the role**: D2 refuses by request method
   regardless of role, and T1 is unchanged. The cost is UX, because more surfaces end in a
   refusal. Consequences that follow:
   - **D2 is the only thing between a Member and a write**, so comments and attachments
     are named must-refuse cases in the route-table sweep (task comment, risk comment,
     comment reaction, attachment upload), each with a read counterpart, plus a
     method-override test (#3924).
   - **Attachments are off in this mode.** D2 already refuses the upload. The chart also
     gives the api pod no writable media path and no storage write credentials, so a
     hypothetical D2 hole has nowhere to save a file (#3925).
   - **The comment composer and attachment dropzone are disabled up front** with a reason,
     and any form that is refused keeps the visitor's typed text (#3926).
   - Alternative B (enforce read-only through the seeded role) stays rejected for the
     reason already given; choosing Member does not reopen it.
2. **D1 becomes a method fence.** A full-app demo needs almost every `GET`, so the third
   server block proxies `/api/` with `limit_except GET HEAD OPTIONS` plus explicit `POST`
   for the three D2 auth paths, mirroring the middleware at the edge. The ADR-0658 D7a
   reasoning ("which routes exist") applied to two anonymous projections and does not
   survive a full-app demo; D2 carries the guarantee.
3. **D5 seed shape.** The demo account holds a program membership and a project membership
   on all three projects. `build_atlas_seed.py` declares explicit per-project rosters and a
   test requires every account to reach a project, so a new account otherwise sees
   nothing.
4. **D9 cadence.** Configurable; proposed every 6 hours. It must not log out an active
   visitor. That is **unverified**: reading the importer suggests the account survives a
   re-seed (`create_user` only when missing, memberships `update_or_create`), but this was
   not confirmed. The login page may state the cadence only from the same values key as
   the schedule, phrased as sample data being refreshed, because "resets every N hours"
   implies changes persist until then, which contradicts D3.
5. **The login page needs a runtime mode signal.** The bundle is static and shared with
   production, so the mode cannot be baked in at build time. Two mechanisms are open and
   are decided in #3926 before `ux-design`: a public pre-login discovery call (the pattern
   `LoginPage` already uses for SSO providers; conflicts with "no new endpoint" above) or
   `window.__TRUEPPM_CONFIG__` injected by the chart (a search on 2026-09-20 found a
   reader in `lib/telemetry.ts` and no writer). The signal carries the credential hint
   from a single explicit `demo.loginHint` key, **never derived from the real password
   env var**, and the hint is emitted only when read-only is actually on, so a mis-set
   flag on a real install cannot publish a live credential.
6. **D3 and D4 refined by code reading.** The drag preview does run for a read-only
   reader with no server write, so D4's premise holds for the preview. But the pointer
   drop opens the ADR-0067 confirmation popover and only Confirm sends the PATCH, so a
   visitor confirms before meeting the refusal, and Cancel reverts the bar. D4's "the
   previewed schedule stays on screen" is therefore not current behavior and is work in
   #3926, as are the keyboard-reschedule and resize paths, which reach the refusal by
   different routes. Two candidates go to `ux-design`: relabel the popover and let the
   server refuse, or short-circuit the drop in demo mode.
7. **Deploy-time verification and a render guard (#3925).** The login page cannot detect a
   wrong chart, since a normal chart renders an ordinary login. A post-install hook signs
   in with the hinted login and expects a 200, then attempts `POST /projects/` and expects
   403 `demo_read_only`. The chart refuses to render when `demo.loginHint` is set and
   read-only is off, because that publishes a working login to a writable instance.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **A. Deny-by-default write middleware keyed on deployment mode (chosen)** | Unavoidable per-view; fail-closed for endpoints not yet written; makes T1 a non-event with no special case; testable as one parametrized route-table sweep | A new middleware and a new values key; the auth allowlist must be maintained |
| B. Enforce read-only via the seeded account's `VIEWER` role | No new code | **Defeated by T1** — the visitor creates their own project and is Owner of it. Also permits-by-default for every endpoint added later |
| C. `DemoReadOnly` in `DEFAULT_PERMISSION_CLASSES` | Idiomatic DRF; looks right in settings | **Silently ineffective** — DRF replaces defaults when a view sets `permission_classes`, which effectively every view here does |
| D. Rely on Cloudflare Access + nightly reset | No application change | Access is a hostname gate passed by any email; reset is containment, not prevention. Mitigates nothing in T1–T7 |
| E. Read-only database user / replica | Enforces below the app, impossible to bypass | Breaks the login it must permit: Django's `update_last_login` writes `User.last_login` on every successful authentication. Also breaks session and metering writes. Enforces at a layer that cannot distinguish "the write we need" from "the writes we refuse" |
| F. Writable per-visitor sandboxes (#1672) | The ideal demo | Needs per-visitor isolation; ADR-0658 already ruled the multi-tenancy that would make it safe an Enterprise concern. Out of scope for 0.4 |
| G. Keep share-link-only; add a scripted product video | Zero risk, zero cost | A video is not a product tour; the visitor never touches CPM. Does not address the motivating problem |

## Consequences

**Easier**

- The read-only claim becomes **verifiable** rather than asserted — one route-table sweep covers every current and future endpoint.
- T1 and the #3583 `IsOrgAdmin` residue stop being demo blockers without waiting for 0.5.
- The demo finally shows the engine: drag a task, watch CPM cascade (D4).
- The share-link demo is untouched, so this cannot regress the thing that works today.

**Harder**

- A third nginx block and a new middleware to keep correct; the auth allowlist in D2 is a small surface that must not drift.
- The demo becomes the first deployment shape with a mode-specific throttle posture (D6) — a genuinely new category of values-file reasoning.
- Two demo hostnames to operate and document.

**Risks**

- **The D2 allowlist is the whole guarantee.** One careless addition re-opens a write path. It must be short, commented with why each entry is there, and pinned by a test that fails when it grows.
- **#3908 is a prerequisite.** If the default ingress path shape routes `/api` past the web tier, D1's edge decisions are void. Land it first.
- **The panel's adoption risk is real and is not a security problem** (below). The strongest technical design here can still produce a demo nobody completes.
- **T2's blast radius is availability, and availability of a shop window is a product risk** — if D6's value is mis-set the demo 429s under exactly the traffic a successful launch produces.

### Voice-of-customer

A simulated persona panel was convened per project convention. **This is modeled feedback
from composite personas, not user research — nobody was asked anything.** No real signal
exists to check it against: `persona-calibration.md` records "Pre-0.4 — baseline (no
data)", all personas are grounding tier T0, and the `user-report` label has zero open
issues. Evidence tier reached: **E1 (mixed)** — real tracker and codebase fact, plus weak
category-level external discourse that corroborates nothing. The panel's score is not
recorded here and did not leave the VoC context. Nothing below may be cited anywhere as
customer feedback.

Blockers handed to this architect pass, each with its falsification line:

1. **Read-only forecloses the interaction each persona needs to believe the engine works** — and it recurred across four personas from four different surfaces. Sarah needs the drag→cascade; David needs over-allocation conflict detection *at write time*; Jordan needs to groom a backlog; Alex needs to complete work and watch burndown react. *Falsified if* a prospect who used the demo can describe the cascade afterward without having dragged anything. → **D4 answers Sarah only, and the Context and D4 now say so explicitly.** This is the panel's most valuable contribution: it stopped the ADR from generalizing one genuine win into a claim about the whole product.
2. **"Verified no-write guarantee" is not yet verified, and #3583 lands in 0.5 — after this ships.** *Falsified or confirmed the moment the write-path audit lands.* → **D2 is the structural answer**: a deployment-mode refusal does not wait for #3583, because it does not depend on the permission derivation at all.
3. **Altitude mismatch for the PMO buyer** — a single-project demo never reaches Marcus's portfolio filter. *Moot if the demo is positioned as a single-project technical tour; real if pitched as "see the platform."* Positioning, not architecture.
4. **The friction stack, and specifically "yields an email list", is a credibility problem rather than just clicks** — raised independently by four personas, and in tension with #3760. *Falsified if forward-to-open completion on the gated demo matches the existing share-link demo.* → **D8.** The share-link demo is a ready-made zero-friction control group, which makes this unusually cheap to settle empirically.
5. **Unverified demo-corpus content** — the panel flagged this as a defect in its own run rather than a structural blind spot. → **Checked and resolved favorably in D4**; the seed populates resource/units rows, sprints, epics, velocity and burndown.
6. **Shared-account state collision reads as a product defect** — "the demo showed changes I didn't make." *Confirmed by any such report in the first month.* → **Largely dissolved by D2**: with no server writes at all there is no cross-visitor contamination through the server, and filter/sort/expand state is client-side per browser. This is a real argument for D2 over the "writable with nightly reset" shape the issue implies.
7. **Losing the nginx allowlist for RBAC-only is a defense-in-depth regression, independent of whether the audit passes** (Omar). *Refuted by a documented compensating control — a WAF or ingress-level write-method block layered over RBAC — in the amending ADR; confirmed if RBAC ends up the sole gate.* → **This is D1 + D2, arrived at independently.** The panel reached from product reasoning the same conclusion the threat model reached from reading `permissions.py`, which is the one place in this document where two independent methods agree.
8. **No API/MCP path for the demo account excludes the AI-native evaluator** (Theo). *Confirmed if a request for a token or MCP endpoint against the demo appears within a month.* → Not decided here, but worth recording that it is **cheap under this design**: `trueppm-mcp` is already read-only and Apache 2.0, and D2 refuses only unsafe methods, so an MCP surface over the demo would be permitted by construction rather than needing an exception. A candidate follow-up, not 0.4 scope.

**What the panel could not see:** whether a real security reviewer reads "email OTP in
front of a published shared login" as normal vendor practice or as a phishing pattern
when the link is forwarded internally; actual funnel behavior at the OTP step versus the
zero-friction share link; and the relative veto weight between personas in a real buying
committee. Only real users settle these; two simulated panels agreeing would not.

## Implementation Notes

- **P3M layer**: Programs and Projects.
- **Affected packages**: `helm` (values key, third server block, egress policy, seed job), `api` (one middleware, one settings flag), `web` (D3 refusal affordance, D4 preview-retention), `website` (operator docs).
- **Migration required**: **No.** No model changes.
- **API changes**: No new endpoint or serializer **as decided on 2026-09-19; the login page needs a runtime mode signal, and if a public discovery endpoint is chosen (#3926) this line changes and this ADR is amended again**. One new *refusal* behavior on existing endpoints, gated by deployment mode — must be reflected in `docs/api/` as a documented 403 `demo_read_only`, per the `api-docs` gate.
- **OSS or Enterprise**: **OSS.** Self-hosted deployment shape. No `trueppm_enterprise` import; verified via `make enterprise-boundary-check` at implementation time.

**Gate chain this feature takes** (CLAUDE.md fast-path: this **spans rows, so take the
union**. It is primarily *backend-only feature* — a new middleware, a values key, a chart
template — but D3 and D4 add UI that does not exist today, which pulls in the
*frontend-only feature* row as well):

`voice-of-customer` → `architect` (this ADR) → `threat-model` → `ux-design` (D3/D4 only)
→ implement → batched parallel pre-MR cluster (`regression-check`, `security-review`,
`rbac-check`; **`perf-check`, `broadcast-check` and `migration-check` are `n/a`**) →
`ux-review` → `test-scaffold` → `changelog` → `/mr`. Plus `docs-writer` and `api-docs`.

- **`ux-design` is in scope, which corrects #3912's own scoping.** The issue reasoned that
  the mode "uses the existing login path" and adds no screen. That is true of the *login*,
  and it is why `ux-design` was correctly skipped for the design pass that produced this
  ADR. It stops being true at D3 and D4: a mode-wide refusal affordance and a previewed
  schedule that must **persist** after its commit is refused are both new interaction
  patterns, not a form bound to an existing serializer. Getting this wrong is how the
  demo ships a refusal that reads as a bug — the exact failure D3 exists to prevent.
- **`threat-model` was in scope and ran.** New authentication path on a public surface and
  a changed authorization boundary; two of its findings (T1, T2) changed the decisions.
- **`ai-review` is `n/a`** — the mode adds a *refusal*, not a server-computed value or a
  mutation. Its paired **`enterprise-check` is `n/a`** too: the classification is not
  unclear (see Implementation Notes above), so the pair is recorded rather than
  half-measured.
- **`rbac-check` is in scope even though no permission class changes.** D2's middleware is
  an authorization control; it must be audited as one, and its allowlist is the whole
  guarantee.
- **`migration-check` is `n/a`** — no `models.py` change. **`broadcast-check` is `n/a`** —
  there is no write path, which is the point of the mode.
- **`perf-check` is `n/a` by its stated scope** (no viewset or serializer change), but note
  that D2's middleware sits on *every* request. Worth a deliberate look during
  `security-review` rather than pretending a gate covers it.
- **`docs-writer`** for the operator docs (how to run the mode, why it must not share a
  host with CI, the reset cadence) under `administration/`. **`api-docs`** for the 403
  `demo_read_only` response shape.

### Durable Execution

1. **Broker-down behaviour**: N/A. The mode introduces no async dispatch. The middleware is synchronous and the seed Job is install-time work, unchanged from ADR-0658 D1.
2. **Drain task**: None. No new category of async work.
3. **Orphan window**: N/A — no outbox rows written.
4. **Service layer**: N/A. No new dispatch path. The middleware is request-layer policy, not a service.
5. **API response on best-effort dispatch**: N/A — no async endpoint added. The one new response shape is the synchronous 403 `demo_read_only` (D3).
6. **Outbox cleanup**: N/A — no outbox rows.
7. **Idempotency**: The scheduled re-seed reuses ADR-0658 D1/D5's destructively-idempotent path (`seed_demo_project` deletes and re-seeds inside `@transaction.atomic`; pinned tokens keyed on `token_hash`). Re-running converges to the same state. The middleware is stateless.
8. **Dead-letter / failure handling**: Unchanged from ADR-0658 D3/D8 — Job `backoffLimit: 2`, failure fails the release loudly, the completed Job is retained for `kubectl logs`. If the scheduled reset fails the demo serves stale-but-read-only data, which is degraded, not unsafe — D2 holds independently of seed state.

### On Acceptance

- [ ] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1197`
- [ ] Any issue carrying pre-ADR scope rewritten — **title and body** — led by a dated
      correction note. Record the count, including zero. **#3912 is expected to need
      this**: it was written before this ADR and scopes the guarantee to the seeded
      account's role, which D2 replaces with a deployment-mode control.

## Related

- ADR-0658 — the share-link demo; amended here for one new mode only, otherwise intact
- ADR-0599 — the API-first boundary; D4's local CPM preview is one of its three sanctioned non-API paths
- ADR-0245 / ADR-0265 — the share-link kill switch this mode does not touch
- #3912 — implementing issue
- #3908 — **prerequisite**: ingress bypass of the web-tier allowlist
- #3910, #3911 — share-link demo defects found deploying 0.4.0-beta.3
- #3583 — the surviving `IsOrgAdmin`/`IsOrgScheduler` derivations (0.5); D2 makes this mode independent of it
- #3557 — `/admin/` off by default and hardened; closes T3's admin half
- #1717 — per-account login lockout; D6 re-aims it for a published credential
- #3760 — the public "no seat count, no feature flags, no telemetry" positioning that D8's email collection is in tension with
- #1350 — the fixed-weak-password guard this mode deliberately and knowingly inverts
- #1672 — ephemeral writable trial instances; the demo this one is not

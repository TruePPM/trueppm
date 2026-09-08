# ADR-1120: Auth events — audit rows for policy changes, log lines for sessions

## Status

Accepted (2026-09-07)

## Context

Issue #3552, raised by the first recorded `threat-model` + `ai-review` run against
`features/auth` (2026-09-07). The auth surface records **failures** and records no
successes. Measured against `main`:

| Event | Record on `main` |
|---|---|
| Login refused (password) | `auth.login_failed username_hash=… client_ip=…` on `trueppm.auth` |
| SSO login refused, account deactivated | `sso login refused: account is deactivated (user_id=… …)` on `trueppm.sso` |
| **Login succeeded** (password or SSO) | **nothing** |
| **SSO identity linked to an existing local account** (`resolve_user` branch 3) | **nothing** |
| SSO identity auto-creates an account (`resolve_user` branch 4) | `member_added` row |
| **SSO provider created / updated / enabled / disabled / deleted** | **nothing** |
| **SSO client secret rotated via PUT** | **nothing** |

`AuditEventType` (`apps/workspace/models.py`) carries fourteen verbs and not one of
them is an auth or SSO verb. The gap is not uniform: the *auto-create* branch of
`resolve_user` writes `member_added`, so an SSO identity that mints a new account is
legible, while an SSO identity that binds itself to an **existing** account — the
branch that grants a federated credential over an account that already has one — is
not. `SsoProviderWriteSerializer` already treats an issuer repoint as dangerous
enough to refuse when linked accounts exist (`_refuse_issuer_repoint_with_linked_accounts`),
yet a *successful* issuer change, a domain-allow-list widening, a `default_role`
escalation, or an `auto_create_members` flip leaves no record of who did it or what
the value was before.

SOC 2 CC7.2 (monitor for anomalies) and CC8.1 (authorize and document changes) both
need this material.

**P3M layer:** cross-cutting auth/audit substrate — **OSS**. See "OSS or Enterprise"
in the Implementation Notes: this ADR adds *operational* auth records to the existing
Apache-2.0 `AuditEvent` log, and adds no identity-governance capability.

### The question this ADR settles

Not *whether* to record these events, but **which of the two existing channels each one
goes to** — an `AuditEvent` row (ADR-0157) or a structured line on the `trueppm.auth`
logger. The choice is load-bearing because it is expensive to reverse: `AuditEventType`
is documented as **additive-only** (an existing value is never renamed or removed,
because enterprise receivers and stored rows must stay valid against it), and each verb
costs an `AlterField` migration on a table with no retention policy in OSS.

### Three forces

1. **The OSS `AuditEvent` table is unbounded.** `administration/audit-log.md` states it
   plainly: the community edition applies *no retention or pruning*; rows accumulate for
   the life of the deployment. A verb whose rate is driven by **request traffic** rather
   than by administrative action therefore has no ceiling, and it is the *operator* who
   pays, not the person who chose the verb.

2. **Two of these events fire on an unauthenticated path.** The SSO callback is
   `permission_classes = [AllowAny]`, `authentication_classes = []`. `_require_active`
   already reasoned about exactly this when it chose a log line over a row: *"an audit
   row per attempt would let anyone who can drive the callback write unbounded rows"*.
   An `AuditEvent` also has an `actor` FK and an `actor_label` whose entire point is
   attribution; a row whose actor is "whoever drove this redirect" is a weaker artifact
   than a log line that says the same thing.

3. **You cannot audit from a refusal.** ADR-0902 (#3017) established the mechanism:
   `DATABASES["default"]["ATOMIC_REQUESTS"] = True` wraps every view in a transaction and
   DRF's `exception_handler` calls `set_rollback()` for **every** `APIException`, so any
   row written on a path that ends in a 4xx is executed and then discarded. Nothing
   fails and nothing logs — the write simply does not survive. That ADR's fix
   (`queue_agent_action` + `AgentActionAuditMiddleware`, draining *outside* the view
   transaction) is the only way to make a refusal row durable, and it is a per-request
   middleware hop.

## Decision

**Rows for admin-actioned policy change and for durable identity binding. A structured
`trueppm.auth` log line for session establishment. No row on any refusal path.**

### The rule

An event becomes an `AuditEvent` row when **all three** hold:

- **Bounded volume** — its rate is set by administrative action or by a once-per-subject
  state transition, never by request traffic;
- **State worth diffing** — there is a before and an after, which a log line carries badly;
- **Attributable** — there is a principal the row can name, and naming them answers the
  question the row exists to answer.

Otherwise it is a `trueppm.auth` log line.

### Applying it

| Event | Channel | Why |
|---|---|---|
| `sso_provider_created` | **Row** | Admin-actioned (`IsWorkspaceAdminStrict`), rare, and it is the moment a federated credential path comes into existence. |
| `sso_provider_updated` | **Row** | Admin-actioned, rare, and the *only* event here with a genuine before/after. Carries a per-field diff over the audited field set below. |
| `sso_provider_deleted` | **Row** | Admin-actioned, rare, unrecoverable for members whose only credential is that binding. Carries both impact counts. |
| `sso_secret_rotated` | **Row** | Admin-actioned, rare. A distinct verb rather than a field in the update diff, because the *value* can never appear and so the diff shape does not fit — see "Never the secret" below. |
| `sso_account_linked` | **Row** | The one unauthenticated-path row, and it is bounded by construction — see "Why linking is a row" below. |
| **Login success** (password and SSO) | **Log line** | Volume is per-session and unbounded; there is no before/after and no target; the actor is the subject, which a row would restate. `auth.login_failed` already lives on `trueppm.auth`, so success and failure land on **one** channel — which is what correlating them in a SIEM actually requires. |
| Login refusal, SSO refusal | **Log line** (unchanged) | Already shipped, and see "Refusals" below. |

### The audited field set, and the exact row payloads

Everything a row carries is enumerated here. **A field not named below is not written** —
in particular nothing derived from the IdP's `claims` dict beyond the two keys listed for
`sso_account_linked`. `record_audit_event` truncates `target_label` to 512 characters but
writes `metadata` **verbatim** (`workspace/services.py:161-162`), so an over-broad payload
has no backstop; for an OIDC provider `claims` is whatever the IdP chose to sign
(`groups`, `phone_number`, `at_hash`, the `nonce`, sometimes an embedded token), and
`metadata={"claims": claims}` is the shape a "make the record complete" instinct reaches
for. It is forbidden.

**Audited fields** — the writable surface of `SsoProviderWriteSerializer`, minus the
secret:

`allowed_email_domains`, `auto_create_members`, `client_id`, `default_role`,
`display_name`, `enabled`, `github_org`, `server_url`.

Two are wider than #3552's acceptance criteria asked for, and both were added by a gate:

- **`client_id`** — writable (`sso/serializers.py:139`, persisted at `:364`) and it
  determines *which OAuth client the install presents itself as*. Paired with
  `sso_secret_rotated` it is a complete credential swap, and without it the log would show
  "a secret was rotated" and never that the client identity changed underneath it. It is
  not secret material — the read serializer already exposes it.
- **`display_name`** — cosmetic, included because it is writable and excluding it would
  make the list something other than "the writable surface", which is the only rule that
  survives someone adding a field later.

**`allow_password_signin` is deliberately excluded, and the exclusion is not free.** It is
the OSS/Enterprise enforcement seam: the OSS write serializer *rejects* the field outright
(`sso/serializers.py:179-195`) and the OSS `update()` loop never writes it, so in this
edition it cannot change and a diff entry for it would always be absent. The catch is that
the enumerating test below **cannot** catch this: the field already exists on the model, so
a test written today passes with it unlisted. Whoever makes it writable in Enterprise must
add it to the audited set by hand — it will not fail on its own.

**The enumerating test asserts against the serializer's writable field names, not
`SsoProviderPolicy._meta.fields`.** `server_url`, `client_id` and `display_name` live on
the `SocialApp`, not on the policy, so a model-based enumeration would silently exempt the
three fields that matter most.

| Verb | actor | target | metadata |
|---|---|---|---|
| `sso_provider_created` | request user | `sso_provider` / policy id / slug | `config` (the audited fields' values at creation), `secret_set` (bool), `actor_kind` |
| `sso_provider_updated` | request user | same | `changed` — `{field: {"from": …, "to": …}}` over the audited set only — plus `actor_kind` |
| `sso_secret_rotated` | request user | same | `actor_kind` only. Nothing about the secret: not the plaintext, not the ciphertext, not a length, hash, or prefix |
| `sso_provider_deleted` | request user | same | `linked_accounts`, `locked_out_accounts`, `confirmed_lockout` (bool), `actor_kind` |
| `sso_account_linked` | the linked user | `user` / user pk / email | `via: "sso"`, `provider` (slug), `issuer`, `subject`, `role` |

Four notes on that table, each of which a gate had to argue for:

- **`actor_kind` (`"session"` / `"token"`) is not decoration.** The provider views set
  `permission_classes` but not `authentication_classes`, so they inherit
  `OwnerScopedApiTokenAuthentication` — a workspace Admin's Personal Access Token carrying
  `legacy:full` authenticates and passes `IsWorkspaceAdminStrict`. All three routes are
  listed in the repo's own `tests/apps/access/token_write_surface.txt`, whose header notes
  that none of them writes an `AgentAction` row. Without this key, a machine-driven
  credential-path change is attributed to the token's human owner and is indistinguishable
  from that human sitting at a browser — on the one row that exists to answer *who did
  this*. Derived from `isinstance(request.auth, ApiToken)`; simplejwt puts its own `Token`
  in `request.auth`, so an interactive session correctly reads as `session`. Excluding
  tokens from SSO CRUD outright (`IsNotTokenAuthenticated`, as `me/credentials/` already
  does) is the stronger answer and belongs to #2749, not here.
- **`role` on `sso_account_linked`** is the linked user's *existing* workspace role, or
  `null` when they hold no membership. Branch 3 links to an account that already exists,
  so no role is computed there — but "what access did this federated identity just get?"
  is the question the row exists to answer, and without it the answer requires a second
  lookup against state that may since have changed. The sibling `member_added` row that
  branch 4 writes is missing `role` too, while `administration/audit-log.md` has documented
  it as carrying `role` since the verb shipped; that is corrected in the same change.
- **`linked_accounts` as well as `locked_out_accounts`.** The delete destroys
  `linked_accounts` federated credentials, of which the locked-out set is a strict subset.
  Recording only the smaller number understates the blast radius on the sole record of an
  unrecoverable action. Both stay **counts**, deliberately: naming the affected members in
  an audit row is a privacy decision this ADR does not take.
- **The delete row's payload is captured before the cascade.** `SsoProviderDetailView.delete`
  purges `SocialAccount` rows and then deletes the `SocialApp`, which CASCADEs the policy;
  Django's collector nulls the pk on the instances it was handed, so a row assembled after
  that point reads a half-torn-down object. Snapshot into locals first.

### Bounding the volume

Two mechanisms, because "an admin did it" is not by itself a bound:

- **A write throttle.** The provider views declare no `throttle_classes` today and fall
  back to the global `"user": "1000/min"`. A scripted `enabled` toggle produces a *genuine*
  change per request, so the no-op rule below does not help. `sso_provider_write` (20/min,
  matching `sso_test_connection`) is applied to the mutating methods only — the collection
  GET backs the admin page and must not be throttled at a write rate.
- **A cap on list values in the diff.** `allowed_email_domains` has no length limit on
  either the serializer or the `ArrayField`, and the diff would store it twice. Any list
  value in a diff is truncated to 25 entries with an explicit `"…_truncated"` marker, so a
  single row cannot be made arbitrarily large.

### Why linking is a row, when the caller is unauthenticated

`sso_account_linked` fires on the same `AllowAny` callback as the refusals that force 2
chose a log line — and it is still a row, because the amplification argument does not
reach it:

- The write happens **once per `(provider, subject)`**. On every subsequent login with
  that same subject the identity resolves at `resolve_user` branch 1 (the durable
  `(issuer, subject)` key) and this code is not reached. allauth's `SocialAccount` unique
  key on `(provider, uid)` makes that a database guarantee, not a convention.
- Reaching branch 3 at all requires the IdP to have asserted a **verified** email whose
  domain clears the allow-list and which matches exactly one existing local account.
  An attacker who can satisfy that has already federated an account.

**State the bound precisely, because the loose version is wrong and it is the version
the next reader will reuse.** There is a unique key on `(provider, uid)` and **none** on
`(provider, user)`. Branch 1 short-circuits on `uid=subject`, so a *fresh* subject for the
same verified email misses it, clears branch 2, and creates another binding and another
row against the same local account. "Once per user, ever" is therefore false; two ordinary
things drive it — IdP-side subject re-issue (a realm restored from backup, a user deleted
and recreated, a tenant migration), and TruePPM's own documented remove-and-re-add issuer
migration, whose DELETE purges every binding for the slug so that N accounts re-link and
write N fresh rows on the next sign-in.

The honest bound is **local accounts × IdP-side subject churn, reset by a provider
delete** — still small, still not attacker-driven, and still nothing like request-rate.
The verb stays a row; only the reason is corrected.

Two things this analysis surfaced that are **out of scope here and are not cleared by
this ADR**: the absence of a `(provider, user)` guard means branch 3 grants an
*additional* federated credential over an account that already has one, silently and with
no notification to its owner; and a provider delete followed by a re-add re-links every
affected account automatically. Both are pre-existing SSO behavior. This ADR makes them
*visible* for the first time, which is the point — it does not bless them.

The row is written **inside** `resolve_user`'s existing `@transaction.atomic`, alongside
the `member_added` the auto-create branch writes, so a link that fails later cannot leave
a row claiming it happened. Its **actor is the user being linked**, matching the
`invite_accepted`/`member_added` convention for the unauthenticated join path.

### Never the secret

`SsoProviderPolicy.secret_ciphertext` is Fernet-encrypted (ADR-0049 §3) and the write
serializer's `client_secret` is `write_only`. Neither the plaintext, the ciphertext, nor
any derivative (length, hash, prefix) enters an audit row or a log line. `sso_secret_rotated`
records **that** a rotation happened and nothing about what was rotated to — which is why
it is a separate verb rather than a `client_secret` entry in `sso_provider_updated`'s
diff: a diff whose values must always be redacted is a diff-shaped lie, and the next
person to extend the field list would have to rediscover the exception.

### Refusals: log lines, and this ADR does not change that

No verb added here is written on a path that can end in a 4xx. Every one of the five is
on a success path:

- The four provider verbs are recorded **after** `serializer.save()` returns, so a
  validation refusal (400), a permission refusal (403), a duplicate-slug conflict (409),
  or the lockout-confirmation gate (409) produces no row — correctly, because nothing
  changed.
- `sso_account_linked` is inside `resolve_user`'s transaction; if the link is refused
  (`_require_active`, ambiguous email, domain gate) the transaction never reaches the write.

**This is deliberate and it is the whole reason the set_rollback trap does not bite
here** — not luck. The corollary is a standing rule for whoever extends this next: *an
auth **refusal** must not be recorded as an `AuditEvent` row unless it is routed through
ADR-0902's post-transaction deferral.* Written naively, the row will be issued and
silently discarded, and the log will show a clean record of successes exactly as the
agent-action log did before #3017. Refusals on this surface stay log lines, where
`auth.login_failed` and the SSO refusal lines already are, and where no transaction can
take them back. (They are on two loggers today — login refusals on `trueppm.auth`,
SSO refusals on `trueppm.sso` — which this ADR does not consolidate; only the *success*
lines are unified, because those are the ones being added.)

**Two qualifications on that rule, because the mechanism differs by view and an
implementer who applies it uniformly will be wrong:**

1. **The SSO callback's refusals are 302 redirects, not `APIException`s.** `set_rollback()`
   is never reached there at all. What actually protects `sso_account_linked` is
   `resolve_user`'s own `@transaction.atomic` savepoint unwinding on `OIDCError`. Anyone
   reading the callback looking for the DRF handler this ADR names will not find it, and
   may conclude the hazard does not apply — it does, by a different route. (The DRF views
   are where `set_rollback()` literally applies.)
2. **Never add a query to the duplicate-slug branch of `POST /providers/`.** That branch
   catches `IntegrityError` and returns a plain 409. Under `ATOMIC_REQUESTS` the connection
   is in an aborted-transaction state at that point, so *any* statement issued there — an
   audit row very much included — raises `TransactionManagementError` and turns a correct
   409 into a 500. The 409 is a refusal and writes nothing, which is both correct and, here,
   mandatory.

A second trap worth pinning, from the same threat-model run: a login *identity* refusal
is raised by the **authenticator**, before a principal is bound, so `request.auth` is
still `None`. Any future gate keyed on `request.auth` silently drops the 401 case while
every 403 test stays green.

### Login success: the line

Emitted at `INFO` on `trueppm.auth`, in the key=value shape `auth.login_failed` already
uses, so both records parse under one rule:

```
auth.login_succeeded user_id=<pk> method=password|sso:<slug> client_ip=<ip> remember=<bool>
```

Fields go in the message rather than in `extra=`: the dev console formatter renders only
`%(message)s`, so an `extra=`-only field is invisible in development and appears only in
the production JSON handler — a record whose content depends on the deployment is worse
than one that is uniformly greppable. `TraceContextFilter` stamps `trace_id`, `span_id`
and `request_id` on both handlers regardless.

`user_id` is the primary key, never the email or username — matching
`auth.login_failed`, which hashes the identifier rather than logging it, and
`_require_active`, which logs `user.pk`. `client_ip` is best-effort (left-most
`X-Forwarded-For`, else `REMOTE_ADDR`) and is for correlation only, never a security
decision; the existing `_client_ip` docstring says so and is reused unchanged.

**Both** login paths emit through one helper, `emit_login_success()` in
`core/auth_views.py` — the password view calls it directly and `apps/sso/views.py`
imports it, so the SSO success lands on `trueppm.auth` beside the password success
rather than on `trueppm.sso` beside the SSO *refusals*. Correlating "who got in" must
not require knowing which door they used.

**The call site is part of the decision, not an implementation detail.** "Credentials
validated" is *not* where a login succeeds. `CookieTokenObtainPairView.post` runs the
enterprise `local_login_allowed(serializer.user)` seam **after** validation, and that seam
returns a 403 with no session and no cookie — so a helper called at the validation point
emits `auth.login_succeeded` for a request that was refused, which inverts exactly the
signal CC7.2 wants. The line is therefore emitted as the **last statement before the
response is returned**, after the seam and after `_set_refresh_cookie`. The same rule
applies to the SSO callback: after `_set_refresh_cookie`, not after `resolve_user`.

The design is quietly self-correcting if you notice it — `remember` is not computed until
after the seam, so the only position where the field list this ADR specifies is even
available is the correct one. The test that pins it is the falsifiable one: with
`local_login_allowed` returning `False`, a login with **correct** credentials must produce
**zero** `auth.login_succeeded` lines.

**Level, and where the line is visible.** `INFO`, not `WARNING` — a successful login is
not an anomaly, and putting it at `WARNING` beside `auth.login_failed` would poison
exactly the alerting rule that line exists to feed. `DJANGO_LOG_LEVEL` defaults to
`INFO` and `prod.py` honors it, so the line is visible in a default production deploy.
It is **not** visible under `settings/dev.py`, which replaces `LOGGING` wholesale with a
root handler at `WARNING`; that predates this ADR, applies to every `trueppm.*` INFO
record, and is left alone here rather than widened as a side effect. A test therefore
has to raise the level explicitly (`caplog.set_level(logging.INFO, logger="trueppm.auth")`),
and the docs say which level an operator needs.

### No-op saves write no row

The SSO admin form re-submits every field on every save. `sso_provider_updated` is
recorded only when at least one audited field actually **changed**; a save that changes
nothing writes nothing.

This diverges from `workspace_settings_changed`, which records the *submitted* keys and
therefore does fire on a no-op. The divergence is deliberate: that verb records field
**names** precisely because its values may be large or sensitive (branding blobs) and so
it *cannot* diff. Every audited SSO field is a small scalar or a short list, so a real
before/after is available — and given an unbounded table with no pruning, a row per form
save that answers no question is the wrong thing to accumulate.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A. Rows for policy + linking, log line for login success** (chosen) | Bounds the unbounded table by construction; puts success and failure on one channel a SIEM can correlate; needs no new middleware; every row is on a success path so ADR-0902's trap cannot bite | Login success is not queryable through `GET /workspace/audit-events/`; an operator needs log access for it |
| B. Rows for everything, including login success | One queryable surface; no log/row split for an auditor to learn | Row rate becomes request-driven on a table with no retention — the operator pays for a design choice they did not make. Login success also has no before/after and no target, so the row is `actor` + timestamp: a log line wearing a table's cost |
| C. Log lines for everything, no new verbs | Zero migration; zero table growth | Loses before/after entirely — a `default_role` escalation would be reconstructable only by diffing two log lines nobody kept. Discards the Enterprise `audit_event_created` seam for exactly the events an immutable trail most needs. Contradicts the issue's own AC |
| D. A separate `AuthEvent` model beside `AuditEvent` | Retention could be tuned per model; login success could be a row cheaply | A second audit table with a second read endpoint, a second permission surface, and a second thing for the Enterprise receiver to subscribe to — for events ADR-0157's model already fits. Two logs is the failure mode ADR-0157 exists to prevent |
| E. Rows for refusals too, via ADR-0902's deferral middleware | Refused logins would be queryable | An unauthenticated, attacker-drivable endpoint writing rows into an unpruned table is a denial-of-service on the operator's disk. `_require_active` already rejected this shape for the same reason. The refusal record exists today as a log line and is not lost |

## Consequences

**Easier**

- "Who widened the allowed domains, and to what?" and "who rotated that secret, and
  when?" become one `GET /workspace/audit-events/?event_type=sso_provider_updated`.
- The Enterprise immutable-trail receiver gets the five new verbs for free — it
  subscribes to `audit_event_created`, and `record_audit_event` is the single choke
  point every new emission site goes through.
- Correlating a login burst is one channel: `auth.login_failed` and
  `auth.login_succeeded` share a logger, a shape, and a `client_ip` field.

**Harder**

- Two channels means an auditor must know which is which. Mitigated by documenting the
  split on `administration/audit-log.md` and `administration/security.md` rather than
  leaving it as tribal knowledge.
- Login success is not retained by TruePPM at all — it is stdout, and its durability is
  the operator's log pipeline. Called out explicitly in the docs.

**Risks**

- **`AuditEventType` is additive-only.** Getting a verb name wrong is permanent. The five
  names follow the existing `<subject>_<past-participle>` convention and the `sso_`
  prefix groups them for the `?event_type=` filter.
- **The empty-diff rule can hide a change** if a future field is added to the model but
  not to the audited field list. The field list is asserted in a test that enumerates it,
  so adding a policy field without deciding its audit treatment fails.
- **`client_ip` is spoofable** behind a proxy that does not normalize `X-Forwarded-For`.
  Unchanged from `auth.login_failed`, and stated in the docs.
- **`auth.login_succeeded` attaches an IP to every *successful* session.** Until now
  `trueppm.auth` carried a client IP only for failures. This is a new class of personal
  data in a stream TruePPM does not own, cannot prune, and cannot honor an erasure request
  against — the operator's log pipeline owns its lifetime. Recorded in
  `administration/audit-log.md` beside the existing spoofability note, because the
  Consequences above cover the *durability* of that stream and not its inverse.
- **`sso_secret_rotated` detection rests on a frontend coupling nothing binds.** The
  rotation test is `"client_secret" in serializer.validated_data`, which is correct only
  because the field is `write_only` with `allow_blank=False` *and* the admin panel omits
  the key unless the admin typed a value. If the panel is ever changed to round-trip the
  field, every save mints a spurious rotation row **and** silently re-encrypts the stored
  secret — and because Fernet is non-deterministic, no ciphertext comparison can detect
  that no-op afterwards. A test asserts the omit-unless-typed behavior so the coupling is
  no longer implicit.

## Implementation Notes

- **P3M layer:** Programs and Projects / cross-cutting operations substrate.
- **Affected packages:** `api` (workspace model + SSO views/services + core auth view),
  `website` (docs). No `web`, no `mobile`, no `scheduler`, no `helm`.
- **Migration required:** yes — one `AlterField` on `workspace.AuditEvent.event_type`
  (choices only; `max_length=40` already admits the longest new value,
  `sso_provider_created`, at 20 characters). Migration `workspace/0027`, reserved via
  `scripts/wt reserve migration workspace`. No constraint is added, so
  `api:migration-constraint-safety` does not apply.
- **API changes:** no new endpoint, no new field, no changed request or response shape.
  The `?event_type=` filter on `GET /workspace/audit-events/` validates against
  `AuditEventType`, so the five new values become accepted filter inputs automatically —
  which is a widened input domain, not a changed contract. The audit verbs do not appear
  anywhere in `docs/api/openapi.json` today (the serializer exposes `event_type` as a
  plain string), so the schema is unchanged. One behavioral change to an existing
  endpoint: the SSO provider **write** methods gain a 20/min scoped throttle and can now
  return 429; reads are unaffected.
- **Not built, and deliberately:** no MCP tool and no web viewer for the audit log. There
  is neither today — `packages/mcp` registers no audit tool and `packages/web/src`
  contains no `audit-events` reader — so #3552's acceptance line about "the web audit
  viewer" has no subject. Exposing an Owner/Admin workspace log through a personal
  `mcp:read` token is a scope decision belonging to #2661/#2749, not to this issue.
  Recorded as a gap, not proposed here.
- **Decision memory is out of scope.** These are administrative facts, not plan decisions
  (rebaseline reason, scope change, slip cause), and the tree has no decision store to put
  them in. A deliberate non-goal rather than an oversight.
- **OSS or Enterprise:** **OSS**, and the line is not close. CLAUDE.md's auth carve-out
  puts *basic OIDC/OAuth login* in OSS and *org identity governance* — SAML, SCIM,
  LDAP/AD directory sync, enforced org-wide SSO, group→role mapping with an auth-event
  audit trail — in Enterprise. What is added here is the **record of an OSS-owned
  administrative action on an OSS-owned surface**: the SSO provider config is an OSS
  admin page, the `AuditEvent` log is an Apache-2.0 model (ADR-0157), and every one of
  the five verbs describes a change to a capability a self-hoster already has. Nothing
  here provisions, deprovisions, or governs an account from a directory, and nothing
  makes the trail immutable, signed, retained, or exportable for an auditor — those
  remain Enterprise, layered on the same `audit_event_created` signal that the new rows
  fan out through unchanged. The decisive text is `apps/sso/extensions.py`, which reserves
  *"group→role mapping … with an auth-event audit trail"* for the Enterprise identity
  mapper: the Enterprise trail is the trail over **directory-governed identity events**,
  not over an admin editing their own OIDC client config. None of the five verbs touches
  `_IDENTITY_MAPPER` or `_LOCAL_LOGIN_POLICY`.

  **Two published pages assert the opposite and are corrected in the same MR; a third is
  correct and must be left alone.**
  - `administration/security.md` — "the auth-event audit trail are Enterprise
    capabilities", in a paragraph about lockout *policy*. Falsified; corrected.
  - `administration/single-sign-on.md` — an edition table row listing "auth-event audit
    trail" unqualified beside SCIM/LDAP/SAML. Falsified; narrowed to the *immutable,
    retained, evidence-exporting* trail.
  - `overview/sso-is-not-enterprise.md` — "Group → role mapping with an auth-event audit
    trail | Enterprise". That **composite** genuinely stays Enterprise. Not touched, and
    named here so a later reader does not "fix" a correct line. (It also carries no
    `documentedFor` and is hash-baselined, so editing it would red `docs:version-accuracy`
    for no gain.)

### Durable Execution

1. **Broker-down behaviour:** N/A. Every write is a synchronous `INSERT` in the caller's
   own transaction or a synchronous log emit. No Celery task is dispatched, no `.delay()`
   is called, and no feature here has an async side effect.
2. **Drain task:** N/A — no async work, therefore no queue to drain. (Note the near
   miss: ADR-0902's `AgentActionAuditMiddleware` *is* a drain, and it exists because
   refusal rows must escape the request transaction. This ADR routes refusals to log
   lines instead, so no drain is needed. If a future change makes an auth refusal a row,
   it must reuse that mechanism rather than inventing a second one.)
3. **Orphan window:** N/A — no outbox rows.
4. **Service layer:** `trueppm_api.apps.workspace.services.record_audit_event` — the
   existing single choke point for the OSS audit log. No new service function is
   introduced; the SSO views call it directly, as `workspace/views.py` already does —
   but through a **function-level** import, matching `sso/services.py`'s existing
   `record_audit_event` call and `projects/views.py::_record_project_audit_event`. The
   dependency is one-way (`sso` → `workspace`) at module level and stays that way. The
   before/after diff is computed by a new private helper in `apps/sso/views.py`
   (`_provider_audit_snapshot` / `_audit_provider_change`), which is view-local because
   the write serializer is constructed without a `context`, so no actor is reachable
   from inside it — and because DELETE has no serializer at all.
5. **API response on best-effort dispatch:** N/A — every response is synchronous and
   unchanged.
6. **Outbox cleanup:** N/A. Retention of `AuditEvent` itself is out of scope and remains
   as ADR-0157 left it: none in OSS, an Enterprise concern.
7. **Idempotency:** Each row is written exactly once per successful mutating request,
   inside that request's transaction, so a rollback removes it and a client retry that
   re-performs the change legitimately records a second change.
   `sso_account_linked` is additionally idempotent by database constraint: allauth's
   unique `(provider, uid)` means the binding — and therefore the row — can only be
   created once per identity. Log lines are not deduplicated and are not expected to be;
   one line per login attempt is the intended cardinality.
8. **Dead-letter / failure handling:** A failing `record_audit_event` raises inside the
   caller's transaction and rolls the whole action back — the log never claims an action
   that did not happen, which is ADR-0157's stated property and is preserved. The
   Enterprise fan-out is already contained: `dispatch_extension_signal` uses
   `send_robust` from `transaction.on_commit`, so a raising receiver is logged and cannot
   break the OSS write path. A failing *log emit* is swallowed by `logging` itself and is
   not made fatal — a broken log handler must not refuse a valid login.

### On Acceptance

- [x] Open issues naming this ADR re-read against the settled decision:
      `python3 scripts/adr-accepted-issue-sweep.py --adr 1120` — **0 open issues**
      (the ADR is authored in the same branch as its implementation, so no issue
      predates it; #3552 itself proposed the split this ADR adopts unchanged).
- [x] Any issue carrying pre-ADR scope rewritten — **0 rewritten**, for the same reason.
      #3552's acceptance criteria are adopted verbatim, with two clarifications recorded
      here rather than in the issue: enable/disable is a `sso_provider_updated` diff
      rather than its own verb (the AC's verb list already implies this), and login
      success lands on the log line, which the AC left to this decision.

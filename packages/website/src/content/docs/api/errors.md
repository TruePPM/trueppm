---
title: Errors and status codes
description: The two error response shapes, the stable machine-readable code values you can branch on, and what the API stability contract guarantees about them.
---

TruePPM returns errors in **two different shapes**, and the difference decides
whether you get a machine-readable `code` to branch on. Knowing which is which is
the whole point of this page — it is the thing you would otherwise have to
reverse-engineer.

For what a version bump may and may not change, see
[API stability](/api/stability/). For webhook delivery failures — a separate
surface with its own retry semantics — see
[Webhooks](/features/webhooks/#delivery-retries).

## Shape 1 — field validation errors (no `code`)

Serializer validation failures return a map of **field name → list of messages**,
with the HTTP status `400`:

```json
{
  "planned_start": ["This field is required."],
  "duration_days": ["Ensure this value is greater than or equal to 0."]
}
```

There is **no `code` key** in this shape, and the individual messages are not
stable. Internally these errors do carry a code, but Django REST Framework
serializes each one to its message string alone, so it never reaches the wire.

**Branch on the field key. Never match on the message text.** The strings come
from DRF and Django validators and can change with a framework upgrade.

Non-field validation errors arrive under the `non_field_errors` key, and
authentication or permission failures arrive as a bare `detail`:

```json
{"detail": "You do not have permission to perform this action."}
```

## Shape 2 — structured errors (with a stable `code`)

Failures that a client is expected to *handle differently* — not merely report —
return a flat object carrying a stable `code`:

```json
{
  "detail": "Cannot set progress on a task with no start date.",
  "code": "progress_requires_anchor"
}
```

`detail` is for humans and may be reworded at any time. `code` is the contract.
Some codes carry extra keys; those are noted in the tables below.

The codes on this page are the complete set of values that appear in this shape.
If an endpoint returns a bare `detail` with no `code`, treat it as a generic
failure of its HTTP status class.

## Structured error codes

### 400 — refused writes

| Code | Meaning | Extra keys |
|------|---------|-----------|
| `progress_requires_anchor` | Progress was set on a task with no date to anchor it to | — |
| `milestone_rollup_locked` | The value is rolled up to the milestone and cannot be set directly | — |
| `child_of_milestone` | A milestone is a zero-duration gate and cannot be given children | — |
| `zero_duration_not_milestone` | A write set an existing, non-zero duration to `0` on a task that is not a milestone — removing the estimate without saying what the row became. Send `is_milestone: true` (or `delivery_mode: "milestone"`) to make it a gate, or a duration of at least `1` to keep it as work. Creating a task at `duration: 0`, or re-writing a `0` that is already `0`, is **not** refused — an unestimated row is legal | `suggested_action` |
| `guardrail_blocked` | A configured guardrail refused the write | `rule`, `suggested_action` |
| `base_url_not_allowed` | The supplied integration base URL is not permitted | — |
| `invalid_token` | The password-reset uid+token pair is bad, unknown, or expired | — |
| `weak_password` | The new password failed validation | `messages` |
| `pin_limit_reached` | Pinning this project/program would exceed the account's configured pin cap | — |
| `invalid_graph_input` | The submitted dependency graph is malformed and cannot be interpreted | — |
| `self_reference` | A task in the graph depends on itself | `offending` |
| `cyclic_dependency` | The dependencies form a cycle | `offending` |
| `subtree_too_large` | The targeted subtree exceeds the per-request cascade cap | `matched`, `max` |

`invalid_graph_input` is refused as a **whole batch**: a malformed graph has no
identified cycle path, so there is no principled subset of edges to reject.

`self_reference` and `cyclic_dependency` carry `offending` — the node ids
implicated. For `self_reference` that is the single offending id; for
`cyclic_dependency` it is the ordered cycle path with the first id repeated at
the end:

```json
{
  "code": "cyclic_dependency",
  "detail": "The dependency graph contains a cycle.",
  "offending": ["A", "B", "A"]
}
```

`subtree_too_large` carries `matched` (how many descendants the request would
have touched) and `max` (the cap), so a client can say how far over the limit it
is without parsing the sentence in `detail`. Both are **strings**, not numbers —
DRF renders a validation detail through `ErrorDetail`, a `str` subclass.

### 403 — refused by policy

| Code | Meaning |
|------|---------|
| `scope_accept_forbidden` | The caller may not accept this scope-injection request |

### 404 / 409 — conflicts and protected references

Refused deletes carry a count of the rows still pointing at the target, and —
only where the endpoint's permission gate authorizes the caller to see them — a
capped sample naming them:

```json
{
  "detail": "This calendar is still referenced and cannot be deleted.",
  "code": "calendar_in_use",
  "reference_count": 3,
  "references": [{"type": "project", "name": "Harbor Fit-out"}]
}
```

| Code | Status | Meaning | Extra keys |
|------|--------|---------|-----------|
| `protected_reference` | `409` | Generic refused delete — other rows still reference this one | `reference_count`, `references`? |
| `calendar_in_use` | `409` | The working calendar is still referenced | `reference_count`, `references`? |
| `skill_in_use` | `409` | The skill is still referenced | `reference_count`, `references`? |
| `sprint_already_bound` | `409` | The milestone is already bound to a sprint | — |
| `sync_conflict` | `409` | A stale write overlapped a concurrent writer | see below |
| `proposal_closed` | `409` | The ceiling proposal is no longer open | — |
| `not_open` | `409` | The planning-poker round is not open for votes | — |
| `not_live` | `409` | The planning-poker session is not live | — |
| `not_revealed` | `409` | The planning-poker round has not been revealed yet | — |
| `sprint_not_planned` | `409` | The sprint is not in the PLANNED state | — |
| `seed_replace_required` | `409` | A live program you own already uses this seed's slug as its code, and the import did not confirm the replacement | `conflict` |
| `seed_replace_mismatch` | `409` | `expected_program_id` does not name the program that would actually be replaced | `conflict` |
| `not_found` | `404` | The targeted poker round or ceiling proposal does not exist | — |

A `sync_conflict` carries the field-level divergence so the client can render a
merge rather than guess:

```json
{
  "code": "sync_conflict",
  "conflict_fields": ["name"],
  "server_value": {"name": "..."},
  "client_value": {"name": "..."},
  "server_version": 41
}
```

Both `seed_replace_*` codes carry a `conflict` object describing the program the
import would replace, so a client can render a confirmation naming a number and
not just a name:

```json
{
  "detail": "A program you own already uses the code \"atlas\". Re-importing moves its projects to Trash. Confirm to continue.",
  "code": "seed_replace_required",
  "conflict": {
    "program_id": "9c2d…",
    "name": "Atlas Platform Launch",
    "code": "atlas",
    "project_count": 3,
    "task_count": 214
  }
}
```

Re-send with `replace=true` to confirm, optionally pinned to
`expected_program_id`. The replaced program's projects move to project Trash,
where each can be restored individually as a standalone project — the program
shell itself is **not** recoverable, and a restored project does not return to
it. See [Programs](/api/reference/#programs).

### 422 — well-formed but unprocessable

| Code | Meaning | Extra keys |
|------|---------|-----------|
| `program_schedule_invalid_input` | A task in the program has data the schedule engine cannot compute | `reason`?, `project`?, `task`? |
| `program_schedule_too_large` | The program exceeds the schedule-computation size limit | — |
| `credential_required` | The connection needs a credential that was not supplied | — |
| `provider_verification_failed` | The external provider rejected the supplied credential | — |
| `source_verification_failed` | The configured external source could not be verified | — |

### 429 — throttled

| Code | Meaning | Extra keys |
|------|---------|-----------|
| `sync_cooldown` | The connection was refreshed too recently to sync again | `retry_after` (seconds) |

The **general** rate limiter is different: it returns a bare `detail` with **no
`code`**, plus a `Retry-After` header. See
[rate limiting](/api/reference/#rate-limiting).

## Codes that exist in code but not on the wire

The codes on this page are the complete set that a client can actually branch
on. A separate, larger family of `code="..."` values exists **only** as an
internal annotation on a Django REST Framework `ErrorDetail` object — task
comments, attachments, notes, reactions, signed download URLs, idempotency-key
reuse, the sync id-collision conflict, and the phase-rollup-lock family
(`summary_rollup_locked`, `phase_status_rollup_locked`,
`phase_estimate_rollup_locked`, `assignee_on_phase`, `time_log_on_phase`,
`phase_in_sprint_forbidden`, `subtask_on_phase`) all pass a `code` keyword when
raising a `ValidationError` or a custom `APIException`.

**That `code` never reaches the response body.** Verified by invoking DRF's own
`exception_handler` against the exact raise sites: when `detail` is a plain
string (or a dict whose value is a string), `code` stays attached to the
`ErrorDetail` string subclass as a Python-side attribute — DRF's JSON encoder
renders an `ErrorDetail` as its plain string, so the wire body is just
`{"detail": "..."}` (or a field-keyed message, for the phase-rollup family),
with no sibling `code` key at all. This is a different code path from every
structured code on this page, which is built as a literal
`Response({"code": "...", "detail": "...", ...}, status=...)` — a real dict
with `code` as its own key.

**Do not rely on any of the codes named above as a wire contract.** They read
like the structured codes elsewhere on this page, but a client that
`if error.code === "attachment_too_large"` will never match — only the
`detail` prose changes, and this page tells you elsewhere never to match on
that. Whether this is a bug (the raise sites should build a flat body like the
rest of Shape 2) or intentional (these were meant to stay internal) is an open
question, tracked in
[issue #2550](https://gitlab.com/trueppm/trueppm/-/issues/2550) — not resolved
here.

## SSO error codes

SSO failures are a third shape again. The login and callback endpoints are
**browser redirects**, so the code arrives as an `?error=` query parameter on the
SPA completion URL — not in a response body:

```
https://ppm.example.com/auth/complete?error=invalid_state
```

| Code | Equivalent status | Meaning |
|------|-------------------|---------|
| `oidc_error` | `400` | Generic SSO failure (the base code) |
| `sso_not_configured` | `400` | No enabled provider matched the request |
| `invalid_state` | `400` | The state parameter was missing, unknown, or did not match the cookie |
| `token_exchange_failed` | `400` | The provider rejected the authorization-code exchange |
| `invalid_id_token` | `400` | The ID token failed signature or claim validation |
| `email_unverified` | `403` | The provider reports the account's email as unverified |
| `sso_no_member` | `403` | The authenticated identity maps to no workspace member |
| `sso_account_disabled` | `403` | The identity maps to a member whose account has been deactivated. Distinct from `sso_no_member`: the account exists and is a member, so the remedy is reactivation, not an invite |
| `provider_unreachable` | `502` | The provider's discovery or JWKS endpoint could not be reached |

These codes never carry token material or PII.

The admin provider-configuration endpoints under `/api/v1/workspace/sso/providers/`
are ordinary JSON APIs, not redirects, and add two conflicts:

| Code / status | Meaning |
|---------------|---------|
| `409` on `POST …/providers/` | A provider of that type is already configured. The provider type is its identity, so each type can be configured only once |
| `409` with `code: sso_removal_locks_out_members` on `DELETE …/providers/{slug}/` | Removing the provider would leave members with no way to sign in at all — no password and no other configured provider. The body carries `locked_out_account_count`. Re-send with `?confirm_lockout=true` to proceed anyway |

## Warning codes are not errors

A few `code` values appear on **successful** `2xx` responses, inside a `warnings`
array or a `warning` field. The write succeeded — these are advisories. Do not
treat them as failures:

| Code | Appears on | Meaning |
|------|-----------|---------|
| `resource_overallocated` | assignment writes | The resource is now allocated beyond its capacity |
| `skill_mismatch` | assignment writes | The resource lacks a skill the task requires |
| `has_assignments` | task restructure | A task became a summary task while still carrying assignments |
| `scope_pending_on_close` | sprint close | Scope-injection requests were still pending at close |

## What the stability contract covers

The [API stability contract](/api/stability/) applies as follows.

**Within a minor release, TruePPM will not:**

- change the spelling of any `code` on this page;
- change the HTTP status a listed `code` accompanies;
- remove a listed `code`, or move one between the error and warning categories;
- remove a documented extra key (`retry_after`, `conflict_fields`, `rule`, …)
  from a body that carries it.

**Within a minor release, TruePPM may:**

- **add** new `code` values, including on endpoints that previously returned a
  bare `detail`;
- promote an endpoint from Shape 1 to Shape 2 by introducing a `code`;
- reword any `detail` string — `detail` is never part of the contract;
- add new keys alongside `code`.

**Not covered at all:** the message strings in Shape 1 field errors, and the
`detail` text everywhere. Match on the field key or on `code`, never on prose.

Because new codes may appear in a minor release, treat an unrecognized `code` as
a generic failure of its HTTP status class rather than raising on it. That single
rule is what keeps a client forward-compatible.

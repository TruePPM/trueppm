# Membership live-floor gate (`scripts/check-membership-live-floor.py`, #3458, #4599)

Run with `make membership-live-floor-check` (part of `make pre-push`; CI check `api:membership-live-floor`
in `api:static`). `--self-test` runs first and pins a must-match and must-not-match case per rule.

## Rule 1: the membership row (#3458)

A read through `ProjectMembership.objects` / `ProgramMembership.objects` must be floored by
`.live()` or an `is_deleted` term. Modules that must see revoked rows are in `ALLOWLIST`.

## Rule 2: the project axis (#4599)

Trashing a project soft-deletes the `Project` only; its membership rows stay live. A
`ProjectMembership` read keyed on `project_id` therefore still answers for a trashed project, and a
recipient set built from it fans notifications, digests and @-group mentions out to a project in
Trash. The rule requires a `project__is_deleted` term in a `filter`/`exclude`/`get` (a `Q()` counts).
`.live()` does not satisfy it: it floors the membership row, not the project.

- `PROJECT_AXIS_ALLOWLIST` (in the script) names modules that must see a trashed project, each with its
  reason: `access/minter_role.py`, `webhooks/dispatch.py` (delivers the trash event itself),
  `sync/views.py` (tombstone stream), `access/signals.py` (prior-row read by pk).
- `packages/api/membership-project-floor-baseline.txt` counts the remaining unfloored reads per module.
  It is a ratchet: a higher count or an unlisted module fails; a lower count also fails until
  `scripts/check-membership-live-floor.py --update-baseline` locks the fix in, which refuses to raise a count.

### Baselined sites and why they are not floored here

A baselined read is not an audited-safe one. The 23 seeded sites fall in these groups:

- Correlated `OuterRef` / `project__in` / user-keyed lookups (`program_views`, `program_label_views`,
  `key_views`, `notifications/serializers`, `teams/services`, `webhooks/views`, `workspace/services`) where
  the project is already filtered by the outer query or the read is a "which projects am I in" list.
- `notifications/tasks._current_project_membership_exists`: the project floor is applied deliberately and
  conditionally (`live_project_only`, #4587); the retirement pass must not discard mail a restore would owe.
- RBAC write core and permission machinery (`access/views`, `access/serializers`, `access/permissions`),
  whose project is resolved and floored by the permission class or `get_object` before the read.
- Seed export, `load_sample_project` and `revoke_api_tokens` (management/offline tooling).
- A few serializer/view lookups behind an already-floored project fetch.

## What it cannot do

It is AST-only: it cannot see that a project was floored earlier in the function or by a permission class,
and it does not see join filters, reverse traversals (`project.memberships`) or `Project`-side queries.

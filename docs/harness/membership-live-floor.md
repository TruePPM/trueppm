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

Measured totals on this branch (`ProjectMembership` read chains outside migrations, writes and lock
acquisitions excluded): 92 floored on the project axis, 5 in allowlisted modules, 3 opted out at the site,
19 baselined, 119 in all. The gate prints these on every run.

There are three ways a read is not flagged, in decreasing order of preference:

- **Floor it**: add `project__is_deleted=False` to the `filter` / `exclude` / `get`.
- **Opt the site out** with `# project-axis-ok: <reason>` on the read's own line or the line directly
  above it. The reason is required; a bare marker is ignored and the read still counts. Used for reads that
  must see a trashed project: the Trash list (`projects/views.py` `_trashed_queryset`, and the Trash `my_role`
  lookup that Restore needs) and `teams/services.live_project_membership_exists`, whose floor is applied
  through its `live_project_only` kwarg, which the AST cannot see.
- **Allowlist the module** in `PROJECT_AXIS_ALLOWLIST` (in the script, each with its reason):
  `access/minter_role.py`, `webhooks/dispatch.py` (it gates the delivery of every event the project fires,
  so a floor would drop the trash event itself; the accepted limit is that an Admin+ registrant keeps
  receiving events fired on a trashed project until it is hard-deleted), `sync/views.py` (tombstone
  stream), `access/signals.py` (the prior-row read by pk, and `evict_all_live_project_sockets`, which must
  list trashed projects so sockets opened before the trash are closed).

The gate checks that a `project__is_deleted` term is present, not its value. A read written
`project__is_deleted=True` satisfies it, which is how `_trashed_project_role` passes; that is intended there
and is not evidence the read is floored.

## The baseline ratchet

`packages/api/membership-project-floor-baseline.txt` counts the remaining unfloored reads per module (19).
The gate checks it two ways:

- **Against the source**: a higher count or an unlisted module fails; a lower count also fails until
  `scripts/check-membership-live-floor.py --update-baseline` locks the fix in.
- **Against the merge-base copy** (`git show <merge-base>:<path>`): a count higher than at the base, or a
  new module, fails unless a reasoned `# raise-ok: <reason>` sits on the line directly above the entry. The
  marker is honored only while new relative to the base. It is a self-grant in the file it guards, so a
  reviewer has to read it in the diff. When the file does not exist at the merge base (this change creates
  it) or the run is on `main`, there is nothing to compare against: that check is skipped with a printed
  note, so the first merge of this file is not ratcheted.

`--update-baseline` refuses to raise a count or add a module, measured against both the committed file and
the merge-base copy, and refuses when the file is missing or empty.

### Baselined sites and why they are not floored here

A baselined read is not an audited-safe one. The 19 baselined sites fall in these groups:

- Correlated `OuterRef` / `project__in` / user-keyed lookups (`program_views`, `program_label_views`,
  `key_views`, `notifications/serializers`, `webhooks/views`, `workspace/services`) where the project may be
  filtered by the outer query or the read is a "which projects am I in" list. Nobody has verified, site by
  site, that the outer query floors the project.
- `notifications/tasks._current_project_membership_exists`: the project floor is applied deliberately and
  conditionally (`live_project_only`, #4587); the retirement pass must not discard mail a restore would owe.
- RBAC write core and permission machinery (`access/views`, `access/serializers`, `access/permissions`),
  whose project is expected to be resolved and floored by the permission class or `get_object` before the
  read. Not verified per site.
- Seed export, `load_sample_project` and `revoke_api_tokens` (management/offline tooling).
- `projects/serializers`: one lookup that was not reviewed for the project axis.

## What it cannot do

- It is AST-only: it cannot see that a project was floored earlier in the function or by a permission class,
  and it does not see join filters, reverse traversals (`project.memberships`) or `Project`-side queries.
- `ProgramMembership` is not checked against `program__is_deleted`. There are about 43 reads and they were
  not reviewed one by one; the project-axis rule does not apply to them.
- `TeamMembership` is not checked on the project axis. `facet_holder_user_ids` and
  `live_project_membership_exists` now floor it by hand (`project__is_deleted=False`), but no rule keeps a
  new `TeamMembership` read honest, and the facet-holder batch read
  (`facet_holder_user_ids_by_project`) does not floor it itself; its one caller,
  `surface_recipient_ids_by_project`, intersects it with a project-floored membership map.
- It cannot tell whether a baselined or allowlisted read is correct, only that it is counted.

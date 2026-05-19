- **BREAKING — Role ordinals re-spaced for Enterprise extension point** (ADR-0072,
  issue #508): the 5 OSS role ordinals are now `VIEWER=0`, `MEMBER=100`,
  `SCHEDULER=200`, `ADMIN=300`, `OWNER=400` (previously `0/1/2/3/4`). The OSS edition
  continues to ship the same 5 named roles with identical user-visible behavior —
  the re-spacing opens 99-unit slot bands between OSS tiers so the Enterprise
  edition can register custom roles (e.g., a "Senior Scheduler" at `250`) without
  forcing an OSS renumber.

  **External API consumers must migrate.** The `role` and `my_role` fields on
  `/api/v1/projects/{id}/members/*`, `/api/v1/programs/{id}/members/*`, and the
  membership sync payload return the new numeric values. Hardcoded comparisons
  like `role >= 3` (Admin-or-above) must become `role >= 300`. The recommended
  migration is to compare against band ordinals, not equality on intermediate
  values — see ADR-0072 §"The band-boundary contract" for the contract that
  governs how custom roles inherit OSS-tier capabilities.

  The data migration multiplies existing rows by 100 atomically across
  `ProjectMembership.role` and `ProgramMembership.role` in a single transaction
  (`apps/access/migrations/0006_role_ordinal_spacing.py`) and is reversible.
  Two raw-integer permission checks (`role < 1` in the WebSocket sync and
  workshop consumers) have been migrated to symbolic `< Role.MEMBER` form so
  the gates stay correct under any future renumber. A new shared module
  `packages/web/src/lib/roles.ts` exposes named constants
  (`ROLE_VIEWER`, `ROLE_MEMBER`, `ROLE_SCHEDULER`, `ROLE_ADMIN`, `ROLE_OWNER`)
  — frontend code should import these instead of writing numeric literals.

  **Deployment guidance**: this is a breaking-change migration that updates
  every membership row. The recommended deployment order is migrate-before-
  traffic (the default in our Helm chart's pre-install hook): run
  `python manage.py migrate` to commit `access/0006_role_ordinal_spacing.py`
  before routing traffic to the new code. Operators on simpler setups (single-
  pod docker-compose) should schedule a brief maintenance window — the
  migration itself takes seconds, but mixing old-code/new-data or new-code/
  old-data during the rollout window can produce transient permission errors
  on active WebSocket sessions and admin API calls.

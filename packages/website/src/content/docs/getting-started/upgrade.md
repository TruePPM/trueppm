---
title: Upgrading
description: How to upgrade TruePPM — Docker Compose, single-server, and Helm paths.
documentedFor: "0.4"
---

## Before you upgrade

1. **Read the changelog** for the target version — check `CHANGELOG.md` or the [release notes](https://gitlab.com/trueppm/trueppm/-/releases) for breaking changes and migration notes.
2. **Back up PostgreSQL** with `scripts/backup.sh`. Valkey state is ephemeral (broker + cache); PostgreSQL is the only stateful service.
   ```bash
   ./scripts/backup.sh --output-dir ./backups
   ```
   Use this rather than a hand-rolled `pg_dump > file.sql`. The runbook's restore
   tooling reads `--format=custom` archives, so a plain-SQL dump is an artifact
   `scripts/restore.sh` cannot consume — you would discover that during a
   rollback, which is the worst moment to discover it. The custom format also
   preserves `CREATE EXTENSION` ordering, which the `ltree` / `pg_trgm` /
   `btree_gist` objects depend on; see
   [Backup & restore](/administration/backup-restore/#why-the-ltree--pg_trgm--btree_gist-extension-ordering-matters).
3. **Note your current version** before starting.
   ```bash
   docker inspect registry.gitlab.com/trueppm/trueppm/api:latest --format '{{.Config.Labels}}'
   # Or: helm list -n trueppm
   ```

:::note[Where images come from]
Release images publish to the **GitLab Container Registry**
(`registry.gitlab.com/trueppm/trueppm/{api,web}`) today. GHCR mirrors
(`ghcr.io/trueppm/…`) and public OCI chart publication are planned with the 0.4
beta supply-chain work (#939); until GHCR is live, the `oci://ghcr.io/trueppm/…`
paths below apply once you have configured GHCR, otherwise upgrade from the chart
source (see [Deployment](/administration/deployment/#kubernetes-with-helm)).
:::

---

## Per-release operational change notes

Every release carries a short **operational change note** answering one question:
*what does an operator have to check or change before and after this upgrade?*
This is distinct from the changelog (user-facing changes) — it is the operator's
pre-flight. Each release's note appears in a versioned section on this page (see
[Upgrading to 0.3](#upgrading-to-03) below for the shape); the template used to
write one is:

```markdown
## Upgrading to <version>

**Migration behavior:** <additive-only / includes destructive ops / data backfill>.
Downtime: <none beyond the migrate run / brief write pause / maintenance window>.

**New or changed env vars / Helm values:**
- `NEW_VAR` — <what it does, default, whether action is required>
- `changed.helm.value` — <old → new default, action required?>

**Breaking config:** <none / describe what an existing config must change>.

**New migrations operators will see:**
- `<app>.<NNNN_name>` — <one line: what schema it adds/changes>

**Pre-upgrade action:** <back up (always) / rotate a credential / set a new value>.
**Post-upgrade verification:** <what "green" looks like — see the checklist below>.
**Rollback notes:** <forward-only? safe to roll back? migration-reversibility caveat>.
```

Fill this in from the release's changelog fragments, the diff of
`packages/helm/values.yaml`, and the new files under
`packages/api/**/migrations/`. Even an all-additive release gets a note so the
operator has a complete picture rather than inferring "nothing changed."

:::note[Where the values reference lives]
When a release changes a Helm default, link the affected knob to the
[Helm values reference](/administration/helm-values/) rather than restating it,
so the operational note stays short and the reference stays the single source of
truth.
:::

---

## Upgrading to 0.3

0.3 adds new database tables and columns for the agile-team feature set. All of
the migrations are **additive** (new models and nullable columns — no destructive
operations), so the upgrade is a standard `migrate` with no manual data steps and
no downtime beyond the migration run. Apply them the usual way for your deploy
path (the `migrate` step shown in each section below). The new schema:

- **Forecast snapshots** (`scheduling.0007_projectforecastsnapshot`) — a new
  `ProjectForecastSnapshot` table that persists each project's P50/P80/P95
  Monte Carlo forecast over time, so the Schedule view can show a forecast
  history. Retention is bounded by `MC_HISTORY_CAP` (see
  [configuration](/administration/configuration/)).
- **Sprint outcomes** (`projects.0064_sprinttaskoutcome`,
  `projects.0065_historicalsprint_goal_outcome_sprint_goal_outcome`) — a new
  `SprintTaskOutcome` table plus a `goal_outcome` column on `Sprint` (MET /
  PARTIAL / MISSED), capturing the sprint close-out snapshot.
- **Scope-change audit** (`projects.0054_sprintscopechange_goal_impact_and_more`)
  — a `goal_impact` column on `SprintScopeChange`, recording whether a
  post-activation scope change affected the sprint goal.

If you maintain a fork, note that 0.3 also collapses each app's migration history
into a `0001_squashed_…` migration via Django's `replaces=` (issue #1286). Because
the original migrations remain on disk and applyable, an existing database records
the squashed migration as already-applied and upgrades as a **no-op** — there is no
drop, recreate, or data step.

---

## Docker Compose (development)

```bash
git pull origin main
docker compose build
docker compose up -d
```

`build`, not `pull` (#3189). The dev stack's `api` and `web` services are
`build:`-based, and `celery` references `image: trueppm-api:local` with no
`build:` of its own — so `docker compose pull` has nothing to fetch for the
services that changed, and reports success. Building is what actually picks up
the new code.

Migrations run automatically when the `api` container starts.

---

## Single-server with Docker Compose

```bash
cd /opt/trueppm
git pull origin main

# Update the target version in .env:
# APP_VERSION=0.2.0

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The `api-init` service runs `migrate --noinput` before the API starts. Watch it complete:

```bash
docker compose -f docker-compose.prod.yml logs -f api-init
# Should end with: "0 unapplied migration(s)." or a list of applied migrations.
```

---

## Helm / Kubernetes

```bash
helm upgrade trueppm oci://ghcr.io/trueppm/charts/trueppm \
  --version 0.2.0 \
  --namespace trueppm \
  -f my-values.yaml
```

Migrations run in a `migrate` init container of the api Deployment before the new pods start serving. Check its logs:

```bash
kubectl logs -n trueppm deployment/trueppm-api -c migrate
```

---

## Upgrading to the hardened Helm chart

The Helm chart now installs secure by default: it generates the PostgreSQL and
Valkey passwords and stores them in a chart-owned **connection Secret**
(`<release>-trueppm-connection`, annotated `helm.sh/resource-policy: keep`),
injects `DATABASE_URL` / `REDIS_URL` via `secretKeyRef`, enables Valkey auth by
default, and applies restricted container security contexts. A few notes when
upgrading **from a pre-hardening release**:

- **Rotate the old default password.** Earlier chart versions shipped a default
  database/cache password of `trueppm`. If you ran with that default, rotate it.
  The simplest path is to set explicit, strong passwords on the upgrade so the
  chart writes them into the connection Secret and the bundled datastores pick
  them up:
  ```bash
  helm upgrade trueppm oci://ghcr.io/trueppm/charts/trueppm \
    --namespace trueppm \
    -f my-values.yaml \
    --set postgresql.auth.password="<new-strong-password>" \
    --set valkey.auth.password="<new-strong-password>"
  ```
  Prefer supplying these through an external Secret over `--set`. After the
  rollout settles you can clear the explicit values and let the chart manage the
  password from the connection Secret going forward.
- **Leave the passwords blank to keep the generated ones.** On an upgrade where a
  connection Secret already exists, leaving `postgresql.auth.password` /
  `valkey.auth.password` empty makes the chart **read the existing password back**
  rather than minting a new one — so re-running `helm upgrade` never churns the
  credential or orphans the database PVC.
- **The connection Secret survives `helm uninstall`.** The `resource-policy: keep`
  annotation means an accidental uninstall/reinstall reuses the same password and
  keeps the existing data reachable. If you intend a clean wipe, delete the Secret
  and the PersistentVolumeClaims explicitly.
- **Using managed datastores?** When `postgresql.enabled` / `valkey.enabled` are
  `false`, `env.DATABASE_URL` and `env.REDIS_URL` are now **required** — the chart
  fails the render if either is missing. Add them (ideally via an external Secret)
  before upgrading.
- **App-side auth/CSP defaults.** The refresh token now rides an httpOnly Secure
  cookie and a strict CSP header is sent on every response. A standard deploy needs
  no changes: TruePPM is served from a single origin, which is what these
  defaults assume. Splitting the SPA and API across hostnames is not supported —
  see [Split-origin deploys](/administration/configuration/#split-origin-deploys).

## Rollback

:::caution
Rolling back database migrations is risky and should be a last resort. Prefer rolling forward with a fix unless data integrity is at immediate risk.
:::

### Migration reversibility — read this first

The safe rollback path depends entirely on **what the upgrade's migrations did**,
so classify them before you touch anything (the release's [operational change
note](#per-release-operational-change-notes) states this):

- **Additive-only** (new tables, new nullable columns, new indexes — the common
  case, and every 0.3 migration). The new schema is a **superset** of the old, so
  the previous image runs against it unchanged. **Roll back the image/chart
  revision only — do not reverse the migrations and do not restore the database.**
  The extra tables/columns sit unused until you roll forward again. The readiness
  probe cannot verify "additive-only" for you, so it holds the rolled-back pods
  out of the Service until you confirm that classification — see the caution
  below for the one-line opt-out.
- **Destructive or transforming** (a column drop/rename, a type change, or a data
  backfill that rewrites rows). The old code cannot run against the new schema,
  and reversing the migration **loses the data the new schema captured**. Here a
  clean rollback means **restore the pre-upgrade backup** — a `migrate` reverse is
  not a substitute, because Django's reverse operations recreate structure but
  cannot recover dropped or transformed data. This is why the [pre-upgrade
  backup](#before-you-upgrade) is mandatory, not optional.

:::caution[The readiness probe is not a rollback safety net]
The API readiness probe (`/api/v1/readyz`) reports the pod's **migration drift**,
in one of four states — but it is a *schema-presence* check, not a
*data-compatibility* one, and it cannot make a downgrade safe:

- `behind` — this image ships migrations the database has not applied. The
  rolling-*forward* guard: a mid-upgrade pod stays out of the Service.
- `ahead` — the database records migrations this image does not ship. Two very
  different things produce that: a pod **booted** against a newer schema (an
  image rolled back without restoring it), or a pod that booted in sync and
  **drifted** there because a newer pod's `migrate` ran while it kept serving.
  Only the first is gated — pods report `Ready: false`, so an image-only
  rollback across a schema change stalls loudly instead of silently serving old
  code against a new schema. The second is the ordinary forward rolling upgrade
  and stays ready, because pulling the old pods out while the new ones are not
  Ready yet would take the whole Service down. Both are reported as `ahead`.
- `in_sync` / `unknown` — ready, and not-ready-because-the-check-failed.

**`ahead` telling you the schema is newer is not the same as the old code being
able to run against it.** The probe cannot tell an additive migration from a
destructive one, so it assumes the worse case and gates the pods. For a
**destructive or transforming** release that assumption is correct and the fix is
the restore-from-backup path above — restore the old schema, *then* roll the
image back. No probe can recover data a migration already dropped or rewrote.

For a release you have classified as **additive-only**, the gate is the thing
standing between you and the image-only rollback recommended above. Re-open it
deliberately, after reading the release's migrations:

```bash
# API pods only; survives until you roll forward again.
TRUEPPM_READYZ_ALLOW_DB_AHEAD=true
```

It changes readiness, not the diagnosis — `migration_state` still reports
`ahead`, so the drift stays visible in monitoring, and each pod logs a WARNING
once at the first suppressed probe. That log line matters: with the flag set,
`status` and `checks` both read green, so an override left in `values.yaml`
after one incident would silently cover the *next* rollback, which may be the
destructive one. It has no effect on `behind`: nothing makes a half-migrated pod
safe to serve. Roll it back to the default (`false`) once you have rolled
forward.

Three limits worth knowing before you lean on `ahead`: it only *gates* a pod
that booted into it (a pod that drifted there mid-rollout keeps serving by
design), it is only evaluated for apps this image installs (so a downgrade whose
only difference is a removed app reads as `in_sync`), and it is a coarse enum —
it never names the migration.
:::

:::note[Ships in 0.4]
The `ahead` state, the `migration_state` field, and
`TRUEPPM_READYZ_ALLOW_DB_AHEAD` ship in **TruePPM 0.4**, the first beta. In
`v0.3.0-alpha.3`, the latest release, `/api/v1/readyz` detects only the `behind`
direction: it compares the migrations *this image ships* against what is applied,
so a database carrying migrations the image does not know about is invisible to
it and the pods report **ready**. On 0.3 an image-only downgrade is unguarded —
nothing stops old code serving a newer schema — so classify the migrations
yourself and go straight to the restore-from-backup path if they are anything but
additive.
:::

### Docker Compose rollback

```bash
# Restore the previous APP_VERSION in .env, then:
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

If the migration applied schema changes, restore from the pre-upgrade backup:

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up db -d
./scripts/restore.sh --artifact ./backups/trueppm-backup-<timestamp>.tar.gz --yes
# Then bring up the full stack at the previous version.
```

:::danger[Do not `docker volume rm` to make room for the restore]
`restore.sh` drops and recreates the *database*, which is all a restore needs.
Deleting the volume destroys PostgreSQL's entire data directory — every
database on that instance, not just TruePPM's — and it is unrecoverable if the
artifact you are about to restore turns out to be incomplete. Verify the
artifact first (`tar -tzf <artifact>` should list `db.dump` and a `MANIFEST`),
and keep the volume until the restore has succeeded.
:::

### Helm rollback

```bash
helm rollback trueppm -n trueppm
```

This restores the previous chart revision. If the migration applied schema changes, restore from backup and trigger a fresh `migrate` run.

---

## Post-upgrade verification

```bash
# Check all containers are healthy
docker compose -f docker-compose.prod.yml ps
# or
kubectl get pods -n trueppm

# Hit the health endpoint
curl https://trueppm.example.com/api/v1/health/
# → {"status": "ok"}

# Confirm the expected version is running — check the deployed image tag
kubectl get deployment -n trueppm trueppm-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
# or: helm list -n trueppm
```

---

## Common issues

**Migrations fail on startup**

Check that `DATABASE_URL` is correct and the database is reachable. Run migrations manually to see the full traceback:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py migrate --noinput
```

**Static files not updating**

Trigger a `collectstatic` run:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py collectstatic --noinput --clear
```

**WebSocket connections drop after upgrade**

Expected — clients reconnect automatically within a few seconds. The Channels layer (Valkey) is not drained between upgrades; in-flight messages are lost but clients recover via the reconnect loop.

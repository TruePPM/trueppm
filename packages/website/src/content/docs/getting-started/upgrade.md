---
title: Upgrading
description: How to upgrade TruePPM — Docker Compose, single-server, and Helm paths.
---

## Before you upgrade

1. **Read the changelog** for the target version — check `CHANGELOG.md` or the [release notes](https://gitlab.com/trueppm/trueppm/-/releases) for breaking changes and migration notes.
2. **Back up PostgreSQL.** Valkey state is ephemeral (broker + cache); PostgreSQL is the only stateful service.
   ```bash
   pg_dump -U trueppm trueppm > trueppm-backup-$(date +%F).sql
   # Or via Docker:
   docker exec trueppm-db-1 pg_dump -U trueppm trueppm \
     > trueppm-backup-$(date +%F).sql
   ```
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
source (see [Installation](/getting-started/installation/#helm--kubernetes)).
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
docker compose pull
docker compose up -d
```

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
  cookie and a strict CSP header is sent on every response. A standard same-origin
  deploy needs no changes. Split-origin deploys must set
  `AUTH_REFRESH_COOKIE_SAMESITE` and `CSP_CONNECT_SRC` — see
  [Configuration](/administration/configuration/#split-origin-deploys).

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
  The extra tables/columns sit unused until you roll forward again.
- **Destructive or transforming** (a column drop/rename, a type change, or a data
  backfill that rewrites rows). The old code cannot run against the new schema,
  and reversing the migration **loses the data the new schema captured**. Here a
  clean rollback means **restore the pre-upgrade backup** — a `migrate` reverse is
  not a substitute, because Django's reverse operations recreate structure but
  cannot recover dropped or transformed data. This is why the [pre-upgrade
  backup](#before-you-upgrade) is mandatory, not optional.

:::caution[The migration-aware readiness probe interacts with rollback]
The API readiness probe (`/api/v1/readyz`) reports **not-ready** whenever the
connected database has migrations the running image has not applied — its design
guard for rolling *forward*. On a **downgrade to an image older than the applied
schema**, that same check keeps the older pods out of the Service until the schema
matches their code. So an image-only rollback across a schema change will leave
pods `Ready: false`; the correct move for a schema-changing release is the
restore-from-backup path above (restore the old schema, *then* roll the image
back), not an image-only downgrade.
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
docker volume rm trueppm_postgres_data
docker compose -f docker-compose.prod.yml up db -d
docker exec -i trueppm-db-1 psql -U trueppm trueppm < trueppm-backup-<date>.sql
# Then bring up the full stack at the previous version.
```

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

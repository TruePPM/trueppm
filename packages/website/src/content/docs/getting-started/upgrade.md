---
title: Upgrading
description: How to upgrade TruePPM — Docker Compose, single-server, and Helm paths.
documentedFor: "0.4"
---

This page walks through moving an existing TruePPM instance to a newer version, safely, for whichever way you run it — Docker Compose, a single server, or Helm/Kubernetes. If you are standing up TruePPM for the first time rather than upgrading one, see [Installation](/getting-started/installation/) instead.

## Before you upgrade

1. **Read the changelog** for the target version — check `CHANGELOG.md` or the [release notes](https://gitlab.com/trueppm/trueppm/-/releases) for breaking changes and migration notes.
2. **Back up PostgreSQL** with `scripts/backup.sh`. Valkey state is ephemeral (broker + cache); PostgreSQL is the only stateful service.
   The exact invocation differs by how you run TruePPM — a bare
   `./scripts/backup.sh --output-dir ./backups` only works when `DATABASE_URL`
   is already exported and `pg_dump` is on the host's `PATH`, which is true for
   neither the production Compose stack (no host database port, no `pg_dump` in
   the application images) nor a fresh shell against Helm. See
   [Backup & Restore](/administration/backup-restore/#manual-backup) for the
   command for your stack — Compose (development), Compose (production), or
   Kubernetes/Helm.

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
(`registry.gitlab.com/trueppm/trueppm/{api,web}`, tagged `v<version>`) and, since
the 0.4 beta, to **GHCR** (`ghcr.io/trueppm/{api,web}`, tagged with the bare
`<version>`). The Helm chart is published at `oci://ghcr.io/trueppm/charts/trueppm`;
you can also upgrade from the chart source (see
[Deployment](/administration/deployment/#kubernetes-with-helm)).
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

## Upgrading to 0.4

**Migration behavior:** includes destructive ops (see below). Downtime: none beyond
the migrate run, plus the transient-500 rollout windows described per-migration below
on multi-replica installs.

0.4 (tagged `v0.4.0-beta.1` on 2026-09-15) carries **five** migrations with a
`RemoveField`, `DeleteModel`, or raw `DROP TABLE` — four of them are destructive
in a way an operator needs to plan around, not just a schema-hygiene detail. If
you are upgrading from 0.3, read all four before you run `migrate`, in
particular the workshop-data warning:

:::danger[Upgrading from 0.3 destroys workshop data]
`projects.0149_drop_workshops_tables` drops `workshops_participant` and
`workshops_session` outright, with `reverse_sql=noop` — this is **irreversible**.
If you have Board Workshop Mode sessions you want to keep, export them (or check
out [`v0.3.0-alpha.3`](https://gitlab.com/trueppm/trueppm/-/tree/v0.3.0-alpha.3)
and read the tables directly) **before** you upgrade. There is no dump/export
tooling for this data — the feature was removed in 0.4 (#3301; see [API
stability §current deprecations](/api/stability/#deprecation-window--notice)
for the full removal analysis), and the migration's own docstring says a
database that needs the tables back should "restore from a backup." Once you
have run this migration, the data is gone; there is no post-hoc remediation.
:::

**Known transient-500 windows on multi-replica installs.** Three of the five
migrations drop a column or table outright, with no intervening
`null=True`-then-remove deprecation release, so an old pod's code still names
what the new schema no longer has. If you run the API at `replicaCount` >= 2
(the posture [`values-prod.yaml`](/administration/helm-values/) sets by
default, and the posture 0.4's basic-HA carve-out encourages), Kubernetes'
default RollingUpdate keeps an old pod serving while the new pod's migration
applies — for the duration of that rollout, each of the following reads or
writes will get a transient `500` from any request landing on an old pod:

- `profiles.0008_remove_userprofile_schedule_in_deliver` — drops the retired
  `schedule_in_deliver` column outright (ADR-0942 §3, #3137). Affects the old
  pod's `get_profile_prefs()` read, used by `/auth/me/` (the web shell's
  bootstrap call). See #3782 for the full analysis.
- `webhooks.0009_encrypt_webhook_secret_and_failure_counters` — encrypts
  `Webhook.secret` into a new `secret_ciphertext` column and drops the
  plaintext `secret` column in the same migration (#2885). On the old pod,
  `webhooks/models.py` still declares `secret` as a concrete, non-deferred
  `CharField`, so Django selects it on every `Webhook` query — every webhook
  read **and every outbound delivery attempt** from an old pod fails with
  `ProgrammingError: column webhooks_webhook.secret does not exist` for the
  duration of the window. This silently stops the entire outbound-webhook
  subsystem with no operator-facing warning; if you depend on webhook
  deliveries during the rollout, scale to a single replica for the upgrade
  (see the mitigation below).
- `projects.0123_remove_historicalproject_agile_features_and_more` — drops
  `Project.agile_features` / `HistoricalProject.agile_features` outright
  (#2025), with no deprecation window and no migration docstring. `Project`
  and `HistoricalProject` reads happen on nearly every authenticated request
  path, so this has the broadest blast radius of the three — but no data-loss
  concern: the field is re-exposed as a derived, read-only
  `SerializerMethodField` (`ProjectSerializer.get_agile_features`), so this is
  dead-column removal, not a feature regression. What is missing is purely the
  HA-safety disclosure this entry now provides.

This is a known, bounded, and accepted trade-off for each of the three, not a
regression to report: no crash-loop, no data loss beyond what each entry
states, and every window closes as soon as the rollout finishes.
**Single-replica installs never see any of this.** If you are on
`replicaCount` >= 2 and want to avoid the windows entirely, scale to one
replica (`kubectl scale deployment/trueppm-api -n trueppm --replicas=1`)
before the upgrade and scale back up once the rollout completes.

**Already running `v0.4.0-beta.1` or later?** These migrations already ran —
there is nothing to re-run and no remediation for the schema changes
themselves. The one exception is workshop data: if you upgraded from 0.3
without exporting it first, it is already gone (see the danger box above) —
this section exists so the next self-hoster upgrading from 0.3 does not lose
theirs the same way.

**New migrations operators will see:**
- `profiles.0008_remove_userprofile_schedule_in_deliver` — drops the retired
  `schedule_in_deliver` boolean preference. See above.
- `webhooks.0009_encrypt_webhook_secret_and_failure_counters` — encrypts
  webhook signing secrets and adds failure-tracking columns. See above.
- `projects.0149_drop_workshops_tables` — drops the two tables backing the
  removed Board Workshop Mode. **Destructive, irreversible.** See above.
- `projects.0123_remove_historicalproject_agile_features_and_more` — drops the
  dead `agile_features` column (now derived). See above.
- `sso.0002_remove_oidcprovider_workspace_ssoproviderpolicy_and_more` — migrates
  any `OIDCProvider`/`OIDCIdentity` rows to `allauth`'s `SocialApp` /
  `SocialAccount` (ADR-0517), then drops the bespoke `OIDCProvider` and
  `OIDCIdentity` models. Benign: SSO never shipped in a tagged 0.3 release, so
  no installation has rows to migrate or lose — no disclosure needed beyond
  this line.

**Breaking API changes:** 0.4 also removes several `/api/v1/` paths that
appeared in the published `v0.3.0-alpha.3` schema. These are documented as
deliberate deprecation-window exceptions in [API Stability & Deprecation
Policy](/api/stability/#deprecation-window--notice) — check there for the full
reasoning and migration guidance for each. If you have an integration calling
`/api/v1/projects/{id}/workshop/*`, `/api/v1/tasks/{id}/scope/`,
`/api/v1/teams/{id}/`, or `/api/v1/projects/{id}/history/summary/`, read that
section before upgrading.

**Pre-upgrade action:** back up PostgreSQL (always — see [Before you
upgrade](#before-you-upgrade)); if you have workshop data, export or preserve
it before running `migrate` (see the danger box above); if you cannot tolerate
a transient-500 window on webhook deliveries or `/auth/me/`/project reads
during rollout, scale to one replica first.
**Post-upgrade verification:** see the [checklist below](#post-upgrade-verification).
**Rollback notes:** all five migrations are destructive or table-dropping —
per [migration reversibility](#migration-reversibility--read-this-first), a
clean rollback means restoring the pre-upgrade backup, not a `migrate` reverse.
`projects.0149` in particular cannot be reversed by any means other than
restore — its `reverse_sql` is a no-op by design.

### Helm: the api and web pods get a default-deny ingress NetworkPolicy

Upgrading the Helm chart from `0.4.0-beta.3` or earlier adds default-deny
ingress NetworkPolicies to the `api`, `web`, `celery-worker`, and `celery-beat`
pods. The `api` and `web` policies admit traffic only from the ingress controller
named by `networkPolicy.ingressControllerSelector`. By default, that is a
namespace called `ingress-nginx`.

If your controller runs anywhere else and your CNI enforces NetworkPolicy, those
policies would cut off all traffic to the site, and every pod would still report
Ready. k3s (Traefik) and RKE2 (`rke2-ingress-nginx`) both run their controller in
`kube-system` and enforce policies out of the box — and a **tunnel** such as
Cloudflare Tunnel is not an ingress controller at all, so it never matches the
default no matter which namespace it runs in. To prevent a silent outage, **the
first upgrade that adds these policies refuses to render** until you choose one
of the following:

```bash
# Your controller really is in the ingress-nginx namespace:
helm upgrade trueppm ... --set networkPolicy.ingressControllerConfirmed=true

# It runs elsewhere, for example kube-system (or wherever your tunnel client runs):
helm upgrade trueppm ... --set-json \
  'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"kube-system"}},"podSelector":{}}'

# Defer the policies (you can enable them later):
helm upgrade trueppm ... --set networkPolicy.enabled=false
```

The check above runs only on the upgrade that introduces the policies — fresh
installs and later upgrades skip it, because it compares against a policy that
must already exist for there to be a "transition" at all. A **separate** check
fires on a fresh install too, for the two paths that bypass any in-cluster
ingress controller entirely: `demo.enabled` (the documented Cloudflare Tunnel
exposure) and `web.service.type: LoadBalancer`/`NodePort`. Neither has a prior
policy to compare against, so the render simply refuses while the selector is
still the default — see [Public read-only demo
mode](/administration/helm-values/#public-read-only-demo-mode). A cloud load
balancer that sends traffic from outside the cluster needs an `ipBlock` peer
instead; see
[`networkPolicy.ingressControllerSelector`](/administration/helm-values/).

Three more things to check for this upgrade:

- **In-cluster monitoring.** If Prometheus or a Blackbox exporter in another
  namespace scrapes the api Service directly (the health endpoints described in
  [Observability](/administration/observability/)), set
  `networkPolicy.monitoringSelector` to that namespace. Otherwise the new policy
  drops those scrapes, and the dead-letter and beat-staleness alerts go quiet
  instead of firing. Scrapes that go through your public hostname pass through
  the ingress controller and are unaffected.
- **Previews.** A client-side `helm upgrade --dry-run` cannot see the cluster, so
  it always reports this refusal. Use `--dry-run=server` to preview the upgrade
  accurately.
- **GitOps.** Tools that render the chart with `helm template` and apply the
  result themselves, such as Argo CD, never run this check. Set the selector
  before you sync.

:::caution[Known issue: tunnels and LoadBalancer/NodePort exposure (#4003)]
The web pod's policy admits only the ingress-controller peer. It therefore also
blocks two other ways of exposing the site:

- **A tunnel pointed at the web Service**, such as Cloudflare Tunnel. This is
  the documented way to expose the demo.
- **`web.service.type: LoadBalancer` or `NodePort`.**

On a CNI that enforces NetworkPolicy, such an install is unreachable even though
every pod is Ready and `helm test` passes. A **fresh** install gets no warning,
because the check above only runs on upgrade. Until #4003 ships, do one of the
following:

- Set `networkPolicy.ingressControllerSelector` to the namespace your tunnel runs
  in. For example, for `cloudflared`:

  ```bash
  --set-json 'networkPolicy.ingressControllerSelector={"namespaceSelector":{"matchLabels":{"kubernetes.io/metadata.name":"cloudflared"}},"podSelector":{}}'
  ```

- Use an `ipBlock` peer naming the LoadBalancer or client source ranges.
- Set `networkPolicy.enabled=false`.

If the tunnel runs on the host rather than as a pod, whether its traffic is
admitted depends on your CNI. Disabling the policy is the safe choice. Check the
public URL after installing or upgrading.
:::

---

## Upgrading to 0.3

0.3 adds new database tables and columns for the agile-team feature set. A
**migration** is a script that changes TruePPM's database structure to match a
new version of the code (adding a table or column, for example) — TruePPM ships
them, so you never write or edit one yourself. All of the migrations in 0.3 are
**additive** (new tables and nullable columns — no destructive operations), so
the upgrade is a standard `migrate` run with no manual data steps and no downtime
beyond that run. Every deploy path runs that step for you on startup — the
Compose `api` / `api-init` service, or the Helm chart's `migrate` init container
— and each section below shows how to watch it complete. The new schema:

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
# APP_VERSION=0.4.0-beta.3

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
  --version <version> \
  --namespace trueppm \
  -f my-values.yaml
```

`<version>` is the release version without a leading `v`, for example
`0.4.0-beta.3`. Always pass it: Helm skips pre-release chart versions unless you
name one, so while 0.4 is in beta a bare `helm upgrade` fails with `could not locate
a version matching provided version string`. `--devel` selects the newest beta.

:::caution[Installed from chart `0.4.0`? Move to a later beta]
The first beta cut published a chart as `0.4.0`. It defaults to an image tag
(`v0.4.0`) that was never published, so a release installed from it cannot pull its
images, and it was unsigned. That chart has been removed from the registry, but a
release installed from it keeps running it (`helm list` shows `trueppm-0.4.0`). Run
the command above with `--version
0.4.0-beta.2` or later, keeping your existing `-f` values. If you set `image.tag`
explicitly you were not affected by the tag problem, but the chart is still unsigned.
:::

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
  see [Split-origin deploys](/administration/configuration/storage-and-networking/#split-origin-deploys).

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

### Concurrent migrations at `replicaCount >= 2`

`migrate` runs as a **per-pod init container**, not as a `pre-upgrade` hook Job,
so at two or more API replicas every pod runs it concurrently against one
database. Django has no concurrency control of its own: each process reads
`django_migrations`, decides the same migration is unapplied, and both run it.

From 0.4 the chart runs `manage.py migrate_locked`, which serializes them behind
a PostgreSQL advisory lock. The losers block rather than fail, and by the time
they acquire the lock the winner has finished, so their own `migrate` is a
no-op. Advisory locks release automatically when the holder's connection dies,
so a killed init container cannot wedge the next rollout.

Nothing to configure. If a migration legitimately runs longer than ten minutes,
raise the wait with `--lock-timeout` in the init container's command, or scale
the API to one replica for that upgrade.

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

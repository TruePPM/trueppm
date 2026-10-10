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

**Migration behavior:** includes destructive ops (see below). Downtime: a
maintenance window sized to your task count, because `projects.0148` blocks all
reads and writes on the task table while it builds a constraint (see the
`projects.0148` caution below), plus the rest of the migrate run and the
transient-500 rollout windows described per-migration below on multi-replica
installs.

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

:::caution[projects.0148 locks the task table and needs the btree_gist extension]
`projects.0148_task_unique_task_wbs_path_per_project_live` adds a database
constraint that guarantees no two live tasks in a project share a WBS path.
Three things about it are operator-visible:

- **Table lock.** Building the constraint takes an `ACCESS EXCLUSIVE` lock on
  `projects_task`, so **reads and writes on tasks block** for the whole build.
  PostgreSQL cannot build this kind of constraint concurrently, and the duration
  grows with the number of task rows. Schedule a maintenance window proportional
  to your task count; a large install should not run this migration on live
  traffic.
- **New extension: `btree_gist`.** The migration runs
  `CREATE EXTENSION IF NOT EXISTS btree_gist`, which 0.3 did not require. On a
  managed or external PostgreSQL that restricts extensions (an extension
  allow-list) or where the migration's database role cannot create extensions,
  that statement fails with a permission-class error, and because migrations run
  on container start this shows up as a crash-loop. Before upgrading, allow-list
  the extension if your provider requires it and pre-create it as a privileged
  role with `CREATE EXTENSION IF NOT EXISTS btree_gist;`. See [Backup &
  restore](/administration/backup-restore/#why-the-ltree--pg_trgm--btree_gist-extension-ordering-matters)
  for why the extensions must exist up front.
- **Duplicate WBS paths are renumbered.** Before adding the constraint, the
  migration moves any duplicate live `(project, wbs_path)` rows onto free paths
  and logs a `WARNING` naming each task it moved. This is **irreversible**: the
  original duplicate state is not restored on rollback. If your WBS held
  duplicates, expect some tasks to appear under different WBS codes afterward.
:::

:::caution[Four 0.4 index builds and one constraint lock `projects_task` for their duration]
Several migrations new or changed in 0.4 add an index or a constraint to the
task table with a non-concurrent statement. Each of these takes a lock on
`projects_task` for as long as it runs. The index builds below hold a lock that
**blocks writes** (inserts, updates and deletes; reads continue). The constraint
below holds a lock that **blocks reads as well**.

- `projects.0104_historicalproject_stale_task_threshold_days_and_more` builds
  `task_status_changed_idx` with a plain `CREATE INDEX`.
- `projects.0128_acceptancecriterion_sync_seq_apitoken_sync_seq_and_more` builds
  `task_proj_syncseq_idx` with a plain `CREATE INDEX`.
- `projects.0134_task_edited_at_task_seeded_at_task_source_id_and_more` builds
  `task_untouched_seeded_idx` with a plain `CREATE INDEX`.
- `projects.0152_aggregate_task_wbs_name_idx` builds `task_proj_wbs_name_idx`
  with a plain `CREATE INDEX`.
- `projects.0121_task_three_point_estimate_ordered` adds the CHECK constraint
  `task_three_point_estimate_ordered` with a plain `ADD CONSTRAINT`, which
  validates every row. The migration runs a repair step first that clears
  mis-ordered three-point estimates, so the risk here is lock time, not a
  crash loop.

The build time grows with the number of task rows, so on a large install,
task writes (and, for the constraint, reads) pause for that long on each step.
Writes from an old pod during a rolling deploy also wait on the lock. We have
not measured a per-million-rows figure for these operations; to size the window,
time one on a restored copy of your database before you upgrade, and schedule
the upgrade for a quiet period when task traffic is low.
:::

**Blank pages during an upgrade of the web tier.** Each release's `index.html`
names that release's content-hashed `/assets/` files, so a browser tab opened
before an upgrade asks the new pods for the old release's files the next time
it opens a page it has not loaded yet. Releases after 0.4.0-beta.7 keep the
previous release's `/assets/` files in the web image, so those tabs keep
working on any number of web replicas. The limits:

- **One release back.** Covered: an upgrade from the immediately previous
  published release, not counting a withdrawn one. 0.4.0-beta.7 was withdrawn,
  so an upgrade from 0.4.0-beta.6 is covered. Not covered: an upgrade that
  skips a release. Tabs opened before it reload once, automatically, when they
  next need a file.
- **During the rollout, the other direction.** With two or more web replicas,
  old and new pods serve together until the rollout finishes, and a browser
  that got the new `index.html` can ask an old pod for a new file. The app
  retries that file twice, over about two seconds, before it reloads, and does
  not retry while the browser is offline.
- **Upgrading to 0.4.0-beta.7 or earlier** has neither; a browser can show a
  blank page until it reloads.
- **Upgrading from 0.4.0-beta.7, specifically.** This one hop is not covered
  by either mitigation above, even on a release that ships both: a beta.7 web
  pod predates the nginx rule that answers a missing hashed asset with a
  clean `404` and the client-side `vite:preloadError` reload handler, so
  during the rollout it answers a request for the new release's chunk with
  its SPA fallback page instead — and a browser that already has the new
  `index.html` gets no clean error to retry on. If your web tier runs more
  than one replica, scale it to 1 before starting an upgrade **from**
  0.4.0-beta.7 (`helm upgrade … --set replicas.web=1` with your other `-f`/
  `--set` flags unchanged, or `kubectl scale deployment/<release>-trueppm-web
  --replicas=1`), wait for the rollout to finish, then scale back up. Every
  later `beta.N` → `beta.(N+1)` hop is covered automatically once both tags
  carry the fix; this is the one upgrade where it is not.

See cause 4 under
[The browser shows a blank page](/administration/troubleshooting/#the-browser-shows-a-blank-page)
and [#4341](https://gitlab.com/trueppm/trueppm/-/issues/4341).

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
exposure) and `service.web.type: LoadBalancer`/`NodePort`. Neither has a prior
policy to compare against, so the render simply refuses while the selector is
still the default — see [Public read-only demo
mode](/administration/helm-values/#public-read-only-demo-mode). A cloud load
balancer that sends traffic from outside the cluster needs an `ipBlock` peer
instead; see
[`networkPolicy.ingressControllerSelector`](/administration/helm-values/).

:::caution[0.4.0-beta.4 and earlier: a settings-only upgrade does not restart the web pod]
Through `0.4.0-beta.4`, the chart gives the web pod no signal that its nginx
configuration changed. An upgrade that changes the image version restarts every
pod and is unaffected. An upgrade that changes **only settings** that land in the
web tier's nginx config (turning on `demo.interactive`, a new `demo.baseUrl` or
share token, a changed allowlist) updates the ConfigMap but leaves the running
web pod serving the old configuration. After such an upgrade, restart it (`trueppm-web` assumes the release is named `trueppm`, as in the install commands; under another name the Deployment is `<release>-trueppm-web`):

```bash
kubectl -n <namespace> rollout restart deploy/trueppm-web
```

Later chart versions restart the pod automatically (#4047).
:::

To upgrade a release you installed with `--set` flags without retyping them,
start from what Helm recorded at install time:

```bash
helm -n <namespace> get values <release> -o yaml > current-values.yaml
helm upgrade <release> oci://ghcr.io/trueppm/charts/trueppm --version <version> \
  -n <namespace> -f current-values.yaml
```

This keeps your own settings and picks up the new chart's defaults.
`--reuse-values` does not: it also freezes the previous chart's defaults.

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

### Helm: seven values keys moved into the concern-first maps

Upgrading the Helm chart from `0.4.0-beta.6` or earlier moves seven values keys
that 0.4 prereleases introduced. The chart lays out its values concern first, then
tier (`resources.api`, `probes.worker`, `lifecycle.web`), and these seven went the
other way. They move before 0.4.0, because the schema rejects unknown keys and any
later rename would break `helm upgrade` for everyone who had set them
([ADR-1248](https://gitlab.com/trueppm/trueppm/-/blob/main/docs/adr/1248-helm-values-are-concern-first-keyed-by-tier.md)).

| Old key (0.4 prereleases) | New key |
|---|---|
| `web.replicaCount` | `replicas.web` |
| `web.service.type` | `service.web.type` |
| `web.service.port` | `service.web.port` |
| `api.workers` | `processes.api.workers` |
| `celeryWorker.concurrency` | `processes.worker.concurrency` |
| `celeryWorker.maxTasksPerChild` | `processes.worker.maxTasksPerChild` |
| `celeryWorker.extraArgs` | `processes.worker.extraArgs` |

The defaults and the behavior do not change, only where the key lives. If your
values file or `--set` flags still use an old key, the render refuses and names
it. The wording depends on your Helm version:

```
# Helm 3.14 and similar
(root): Additional property celeryWorker is not allowed
web: Additional property replicaCount is not allowed

# Newer Helm releases
- at '': additional properties 'celeryWorker' not allowed
- at '/web': additional properties 'replicaCount' not allowed
```

Nothing is silently dropped. Rename the key and run the upgrade again. As a
YAML diff:

```yaml
# Before (0.4.0-beta.6 and earlier)        # After
api:                                       processes:
  workers: 4                                 api:
celeryWorker:                                  workers: 4
  concurrency: 4                             worker:
web:                                           concurrency: 4
  replicaCount: 2                          replicas:
  service:                                   web: 2
    type: LoadBalancer                     service:
                                             web:
                                               type: LoadBalancer
```

Every 0.3 key keeps its name and meaning. The top-level `replicaCount` still
sets the API and worker replicas, `service.type`/`service.port` still describe
the API Service, and a values file written for 0.3 renders unchanged. Keys that
exist only for the web tier's nginx stay under `web:`: `web.enabled`,
`web.containerPort`, `web.maxBodySize`, `web.adminAccess.*`, and
`web.securityHeaders.*`. The `api:` and `celeryWorker:` roots no longer exist.

### Milestone date shift after recalculation

Upgrading from `0.4.0-beta.4` or earlier changes how the scheduler places
zero-duration milestones (#4079). No migration runs and no stored date changes
during the upgrade itself; the new dates appear the next time each project's
schedule recalculates, which happens on the next edit that affects the schedule.

Earlier versions gave every milestone a working day of its own, so each milestone
on a path pushed everything after it back by one working day. The scheduler now
follows the MS Project and Primavera P6 convention: a milestone is a point in
time. A milestone that follows work sits on the day that work finishes, and the
next task starts on the following working day, exactly as if the milestone were
not there. A milestone with no predecessor, such as a project-start milestone,
sits at the start of its day and does not delay the work after it.

What you will see after recalculation:

- **Dates move earlier.** Downstream tasks, forecasts, and the project finish move
  earlier by one working day for every milestone on their path. A milestone that
  follows work is now shown on its predecessor's finish day rather than the day
  after it.
- **Float and the critical path can change.** A milestone no longer adds a day to
  the paths it sits on, so float on parallel paths is recomputed against the
  shorter path.
- **Monte Carlo forecasts move with the schedule.** P50/P80/P95 use the same
  convention, so a plan with fixed durations still simulates to its CPM finish.
- **Imported MS Project plans now match their source file.** Recalculated dates
  for an imported plan no longer drift one day per milestone from the dates in
  the `.xml` file.

Baselines captured before the upgrade keep the old dates, so the first comparison
after recalculation can show milestone-driven variance that reflects the
convention change, not a schedule change. To compare like with like, capture a new
baseline after the project recalculates.

### Project and program keys (`projects.0154`)

Upgrading from `0.4.0-beta.4` or earlier makes every project and program **key**
(the `code` field; see [Project and program keys](/api/reference/projects/#project-and-program-keys))
unique across the workspace, compared case-insensitively. Migration
`projects.0154_object_keys` repairs existing data before it adds the uniqueness
constraint:

- A project or program with **no code** gets one derived from its name. Platform
  Migration becomes `PM`, and a program called Office Move becomes `office-move`.
- When several projects (or several programs) share a code, **the oldest keeps
  it** and each of the others gets a numeric suffix: `PLAT2`, `PLAT3` for projects,
  `atlas-2` for programs.
- Every other code is kept exactly as it is, including an existing hyphenated
  project code such as `GA-SEC`. New project keys can't contain hyphens, but
  existing ones are never rewritten.

Each code the migration changed is logged at `WARNING` during `migrate` with the
prefix `key repair (ADR-1237)`. The log is optional: the database records every
rewrite too. To list them later, run this in `python manage.py shell`:

```python
from trueppm_api.apps.projects.models import ObjectKey

for row in ObjectKey.objects.filter(source="backfill").select_related("project", "program"):
    owner = row.project or row.program
    print(row.kind, row.key, owner.name if owner else "(deleted)")
```

If a rewritten key isn't what your team wants, rename it on the project's or
program's **General** settings page. The old key keeps working in links and
now opens the renamed project.

**Rolling upgrades.** The constraint excludes blank codes for this release. While
an older API pod is still running during a rolling update, it can create a
project with an empty code without failing. The new version gives that project a
key the next time it is edited. The exclusion is planned to be removed in 0.5.

### `created_by` is an integer user id on share links, stakeholders, and saved board views

Upgrading from `0.4.0-beta.6` or earlier changes one response field on three API
surfaces. This affects only API clients and scripts; the web UI is updated with
the server, and no data or migration is involved.

- **Share links** (`/api/v1/projects/{id}/share-links/`) and **external
  stakeholders** (`/api/v1/programs/{id}/external-stakeholders/`): `created_by`
  was the creator's display name. It is now the creator's integer user id, and the
  name moves to a new `created_by_name` field.
- **Saved board views** (`/api/v1/projects/{id}/board-views/`): `created_by` was
  the creator's user id as a string, such as `"7"`. It is now the integer `7`.

If a script reads either field, update it before upgrading. See the
[API stability policy](/api/stability/#deprecation-window--notice) for why this
change ships between betas.

### Dead-letter and observability scrape credentials now require superuser

Upgrading from `0.4.0-beta.4` or earlier changes who can reach these endpoints.
Through `0.4.0-beta.4`, `FailedTaskViewSet` (dead-letter requeue/drop/list) and
the observability app's System Health, Prometheus metrics
(`/api/v1/health/beat/`, `/api/v1/health/dead-letter/`, `/api/v1/health/email/`),
retention policy, and telemetry-export endpoints were gated with Django's
`IsAdminUser`, which passes for **any** `is_staff=True` account — including one
that is not a superuser. They now use `IsWorkspaceOperator`, which checks
`is_superuser` directly (#4009). Superusers are unaffected; a `WorkspaceRole.ADMIN`
membership was never sufficient for these endpoints and still is not.

This is a **least-privilege regression for anyone who provisioned a staff-only
service account** for scraping or automation against these endpoints — it now
gets `403 Forbidden`. Before upgrading:

- Identify any Prometheus scrape job, alerting script, or automation that calls
  `/api/v1/health/{beat,dead-letter,email}/`, the retention endpoints, or the
  dead-letter queue admin API.
- Confirm the JWT it uses belongs to a superuser account (`is_superuser=True`),
  not merely a Django-admin (`is_staff=True`) account. `create_admin` produces a
  superuser and is unaffected.
- If it does not, mint a new token from a superuser account before or
  immediately after the upgrade, or the scrape/automation starts failing
  silently (a gauge that stops updating, not a loud error) the moment the new
  code is live.

See [Dead-letter Alerting](/administration/dead-letter-alerting/#wiring-it-into-prometheus)
and [Beat Liveness](/administration/beat-liveness/#wiring-it-into-kubernetes--monitoring)
for the affected scrape configs.

### Program exports and program and project webhooks honor project membership

**Behavior change, no migration.** Upgrading from `0.4.0-beta.6` or earlier: a program
export, the program webhooks of a Program Admin, and a program-scoped API token used to
reach every member project regardless of the minting admin's own project membership, and
a project webhook kept delivering after its creator lost access to that project. What
changed:

- **Program export (JSON seed and async bundle).** Only member projects the requesting
  user holds project membership on are included. A Program Admin who is not a member of a
  project no longer receives that project's tasks, attachments, time entries, history, or
  MS Project XML from a program export. Program-level content (roster, program backlog,
  ceremonies) is still exported. A scheduled or queued bundle is evaluated when it is
  built, not when it was requested. A bundle can be downloaded only by the admin who
  requested it, and an admin's export request no longer returns another admin's job that
  is still in flight.
- **Program-scoped webhooks.** A program webhook receives a member project's events only
  while its creator (`created_by`) holds **Project Manager or above** on the specific
  project the event fires from — a program grant has never been a project-read grant
  (#4310) — **and** holds **Program Manager or above** on the program itself (#4330). The
  second check matches the delivery-log read gate exactly (`IsProgramAdmin` plus the
  creator-only check), which is keyed on the registrant's *program* role, not their
  project role; the first check has no equivalent in the read gate and exists purely
  because dispatch, unlike reading the log, hands a specific member project's data to
  someone who may hold no role on that project at all. A creator demoted to Resource
  Manager, Team Member, or Viewer **on the firing project**, or to anything below Program
  Manager **on the program**, stops receiving events even though they are still a live
  member in both places — either demotion alone is enough to stop delivery. Removing
  either membership entirely has the same effect. Events already queued, or retrying, are
  still delivered. A webhook whose creator account was deleted, or is deactivated,
  delivers no member-project events. Editing (`PATCH`/`PUT`) requires the caller to
  currently hold Program Manager or above **and** be the webhook's creator **and** still
  hold live membership (any role — presence, not role, is what this leg checks) on every
  project the program covers; deleting requires only that the caller currently hold
  Program Manager or above, with no creator or project-membership check at all, so any
  current Program Admin can delete it, not only its creator. The practical consequence: a
  creator demoted below Program Manager on the program loses the ability to edit **or**
  delete the webhook themselves — the same demotion that stops dispatch on the program
  axis also removes their only path to self-service disable it, and only a *different*
  Program Admin can intervene (by deleting it; nobody but the original creator can ever
  `PATCH` it, since editing's creator check cannot be satisfied by anyone else). A
  demotion on the *project* axis alone — the creator stays Program Manager+ but drops
  below Project Manager on a covered project while remaining a live member there — does
  not block edit or delete at all, because neither checks project *role*, only project
  membership *presence* for edit and nothing for delete; it only stops that project's
  deliveries. Only a **full removal** from a covered project (not a demotion) blocks
  editing, via the presence check — deleting still works even then, since delete does not
  consult project membership. If the creator has been fully removed from any project in
  the program, including one added later, nobody can edit the webhook, but any Program
  Admin can still delete it and it can be re-created under a qualifying account. Only the
  creator can read its delivery log.
- **Program-scoped API tokens (task-sync and acceptance-results).** These two write
  endpoints — inbound task-sync and CI acceptance-result ingest — now also require the
  token's minter (`created_by`) to hold project membership on the target project, checked
  on every request, not just at mint time. Revoking the minter's membership stops the
  token from writing into that project on the very next request, with no re-mint needed. A
  token whose minter was deleted (and so carries no `created_by`) can no longer write into
  any project through this path. **Not yet released:** a further role floor on top of this
  membership check — the minter will also need to hold Member or above, not merely live
  membership, so a Viewer-minted program token will be refused on both write endpoints.
  Until that lands, a minter who is a live member but Viewer-only can still use a
  program-scoped token to write into the project (#4331).
- **Project-scoped API tokens (task-sync and acceptance-results).** Today these two
  write endpoints do not re-check a project-scoped token's minter — the token keeps full
  write authority after its minter is demoted or removed from the project, because
  project-scoped tokens are documented org assets that survive their minter's
  off-boarding. (A token whose minter's account was *deleted* is a different case: both
  endpoints already refuse it, because it is left with no user to act as. That does not
  change.) **Not yet released:** a request-time floor on the minter's *last recorded
  role* on the token's project, live or removed. Once it ships, a minter demoted to
  Viewer will lose write authority on the token's very next request. A minter removed
  from the project while still Member or above keeps a working token, so the org-asset
  guarantee holds for a removal in good standing. A minter demoted below Member and then
  removed, including one who removes themselves, stays refused (#4334).
- **Project-scoped webhooks.** A project webhook receives that project's events only while
  its creator holds **Project Manager or above** there, checked on the same schedule as
  program webhooks above. Removing the creator's membership, demoting it below Project
  Manager, or deleting or deactivating their account, all stop new deliveries; events
  already queued, or retrying, are still delivered. Editing a project webhook, deleting
  it, and reading its delivery log were not affected — those already require Project
  Manager or above and re-check the *caller's* current membership and role on every
  request, so a removed or demoted creator already lost those abilities today.

**Operator check after the upgrade.** Program webhooks now showing no deliveries for a
member project usually belong to a creator without membership there, or one demoted
below Project Manager on that project while remaining a member (Resource Manager, Team
Member, or Viewer) — or, independently, one demoted below Program Manager on the program
itself while still Project Manager on every covered project. Either restore the
creator's role (project-level, program-level, or both, depending on which check failed),
or re-create the subscription under a current qualifying account. **Whether the creator
can self-service it depends on which axis demoted them.** If only the *project* role
dropped (the creator is still Program Manager+), they can still edit or delete the
webhook themselves — editing's project-membership leg checks live presence, not role,
so a demotion (as opposed to a full removal) on the project side never blocks it, and
deleting does not consult project membership at all. If the *program* role dropped below
Program Manager, the creator loses **both** abilities at once: editing and deleting a
program-scoped webhook both require the caller to currently hold Program Manager or
above on the program, with no exception for the webhook's own creator. In that case the
creator cannot disable it themselves at all — restoring their program role, or having a
**different** current Program Admin delete the subscription (delete has no creator
check, unlike edit), is the only remedy; nobody but the original creator can ever edit
it, since editing's creator check cannot be satisfied by anyone else, demoted or not. A
full **removal** from a covered project (not merely a demotion) blocks editing via the
presence check even with Program Manager intact, but a still-Program-Manager creator can
still delete it in that case too, since delete never checks project membership. A project webhook showing
no deliveries belongs to a creator removed from that project, or demoted below Project
Manager on it; re-add or re-promote them, or have a **different, still-qualifying** Project
Manager/Admin disable or re-create the subscription — unlike the program case, a project
webhook's own edit/delete already requires Project Manager or above (matching the
dispatch and delivery-log gates), so a demoted creator loses the ability to disable their
own stale webhook too, and cannot self-service it back to health. A **test ping** is not a
reliable health check here: it is gated on the caller's own current role, not the
registrant's membership or role, so a current Admin's test ping still succeeds against a
dormant webhook and shows up in the delivery log looking healthy while real events
are silently dropped. A program-scoped integration token that starts returning `401` on
task-sync or acceptance-results usually means its minter lost project membership; add
them back or re-mint the token under a member account. The
`manage.py export_program` command is unaffected: it runs as the operator with shell
access and exports every member project.

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
# APP_VERSION=0.4.0-beta.4

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
`0.4.0-beta.4`. Always pass it: Helm skips pre-release chart versions unless you
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
helm rollback trueppm -n trueppm --wait --timeout 10m
```

Always pass `--wait`. Without it, `helm rollback` patches the three Deployments
and returns **exit 0** immediately — before the web rollout finishes, before the
api tier's readiness probe has run even once, and well before any of the
sequence below is visible. A bare `helm rollback` exiting 0 is not evidence the
rollback finished; `--wait` makes the command itself fail (timeout or error)
when a target Deployment never becomes ready, instead of reporting success on a
rollback that is still stuck.

**Across a release that added migrations, the three tiers do not roll back
together — read this before you run it:**

- **Web rolls back immediately.** The web tier's readiness probe only checks `/`
  (`packages/helm/templates/web/deployment.yaml`); it does not gate on the api's
  version. At `replicaCount` >= 2 the rollback is an ordinary rolling update in
  reverse, so old- and new-release web pods serve together for the few seconds
  the rollout takes — the same mixed-asset mechanism as a forward upgrade (see
  [cause 4](/administration/troubleshooting/#the-browser-shows-a-blank-page) and
  [#4341](https://gitlab.com/trueppm/trueppm/-/issues/4341)), just now serving
  the **older** bundle once it settles.
- **The api tier stalls, by design, and stays on the newer version.** Each
  rolled-back api pod still runs the `migrate` init container
  (`migrate_locked`) first. Because the init container's migration graph is the
  *old* image's — it has no record of migrations the newer release added — it
  finds nothing to apply and exits 0; this is not a crash loop. The api
  container then starts and `/api/v1/readyz` reports
  `"migration_state": "ahead"` (the database records migrations this image
  does not ship) and gates the pod `Ready: false`, because
  `TRUEPPM_READYZ_ALLOW_DB_AHEAD` defaults to `false`
  (`packages/api/src/trueppm_api/settings/base.py`). The chart sets no explicit
  `strategy:` on the api Deployment, so Kubernetes' default RollingUpdate
  (25%/25%, rounded) gives `maxUnavailable: 0` at the 2–3 replica posture
  `values-prod.yaml` ships — the rollout cannot scale down the still-`Ready`
  newer-version pods until the rolled-back replacement passes readiness, which
  it never does. The api tier is therefore left running the **newer** version
  indefinitely, with the rolled-back replica stuck `NotReady` beside it; the
  Deployment's `progressDeadlineSeconds` (the chart does not override it, so
  Kubernetes' default of 600 s applies) only flips the `Progressing` condition
  to `False` after ten minutes — it does not stop anything or roll back
  further on its own.
- **The worker has no migration gate at all and rolls back immediately.** The
  Celery worker's readiness probe is a heartbeat-freshness check
  (`packages/helm/templates/celery-worker/deployment.yaml`,
  `trueppm.celeryProbe` with `mode: heartbeat-fresh`) — it never reads
  `migration_state`. The rolled-back worker starts consuming tasks against the
  newer schema with nothing holding it back, which is the least visible leg of
  the split: nothing reports it as degraded.

**The result is `web` on the old release, `api` on the new one, and `worker` on
the old one running against the new schema — not a transient skew window, but
a stable split state that `--wait` will time out on.** Resolve it deliberately:

1. **Classify the release's migrations** using the [migration
   reversibility](#migration-reversibility--read-this-first) rule above, from
   its [operational change note](#per-release-operational-change-notes).
2. **Confirm the api pod is gated on `ahead`, not `behind`**, before touching
   the override — `kubectl logs` on the stuck pod shows the one-time
   `TRUEPPM_READYZ_ALLOW_DB_AHEAD` WARNING, or query the probe directly:
   ```bash
   kubectl exec -n trueppm deploy/trueppm-api -- \
     curl -s localhost:8000/api/v1/readyz
   # → {"status": "fail", "checks": {...}, "migration_state": "ahead"}
   ```
3. **Additive-only:** re-open the gate and let the stalled rollout complete.
   `helm rollback` takes no `--set`, so apply the override with `helm upgrade`
   against the **same, explicit previous chart version** — an unpinned
   `--reuse-values` can silently resolve back to the newest chart and undo the
   rollback instead of completing it:
   ```bash
   helm upgrade trueppm oci://ghcr.io/trueppm/charts/trueppm \
     --version <previous-chart-version> -n trueppm \
     --reuse-values --set env.TRUEPPM_READYZ_ALLOW_DB_AHEAD=true \
     --wait --timeout 10m
   ```
   Once the api tier is healthy and you are ready to roll forward again, remove
   the override (`--set env.TRUEPPM_READYZ_ALLOW_DB_AHEAD=false`, or drop the
   key and `helm upgrade --reuse-values`) — leaving it set hides the next
   rollback's drift behind the same green `status`/`checks` it hides this one
   behind.
4. **Destructive or transforming:** do not set the override — forcing the api
   pod ready only makes it serve code that no longer matches the schema it
   just rejected. Follow [migration reversibility](#migration-reversibility--read-this-first)
   above: restore the pre-upgrade backup, then roll the image back onto the
   restored schema. Scale the worker to zero replicas first (`kubectl scale
   deployment/trueppm-celery-worker --replicas=0 -n trueppm`) — it has no gate
   of its own and will otherwise keep consuming tasks against the schema you
   are about to replace underneath it.
5. **Verify the fleet agrees on one version** before calling the rollback
   done — nothing in `kubectl get pods` summarizes the split for you today, so
   check the image tag per tier directly:
   ```bash
   kubectl get pods -n trueppm -o jsonpath='{range .items[*]}{.metadata.labels.app\.kubernetes\.io\/component}{"\t"}{.spec.containers[0].image}{"\n"}{end}' | sort -u
   ```

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

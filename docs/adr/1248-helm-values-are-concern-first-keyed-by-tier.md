# ADR-1248: Helm values are concern-first, keyed by tier

## Status

Accepted (2026-10-06)

> **Implementation status (2026-10-06, #4299):** implemented by the #4299 MR, ahead of
> 0.4.0. The moves are in `packages/helm/values.yaml`, `values.schema.json`, the
> templates under `packages/helm/templates/`, and `values-prod.yaml`. The executable
> form of this decision is section 12b of `scripts/helm-structure-check.sh`. It
> checks that every moved key is refused, that a values file in the 0.3 shape still
> renders, and that the new paths are wired.

## Context

P3M layer: none. This is deployment packaging for the OSS Helm chart (Apache 2.0).
The decision governs the chart's public values API, not the application.

The 0.3 chart laid its values out **concern first, then component**:
`resources.{api,worker}`. 0.4 extended that axis with `probes.<tier>`,
`lifecycle.<tier>`, `autoscaling.<tier>` and `podDisruptionBudget.<tier>`. But 0.4
also added roots that went the other way, **component first, then concern**:
`web.{replicaCount,service,…}`, `api.workers` and `celeryWorker.{concurrency,…}`.
There was no rule, so each key went wherever its author first needed it. #4092
then proposed `celeryWorker.replicaCount`, which would have deepened the split while
the top-level `replicaCount` still drives both the API and the worker.

`values.schema.json` closes the root (`additionalProperties: false`, #2879). That
is deliberate: an unknown key is a hard error, not a silent no-op. It also means
any rename after operators have written values files against 0.4.0 fails their
`helm upgrade`. The layout therefore has to be decided before 0.4.0. Afterwards
every move costs a deprecation cycle with schema aliases.

Two constraints bound the answer:

- **No key that shipped in a 0.3 tag may be renamed.** `v0.3.0-alpha.3`'s
  `values.yaml` has 36 leaf keys, among them `replicaCount`, `service.type`,
  `service.port`, `image.*` and `resources.{api,worker}.*`. A 0.3 values file must
  still `helm template` cleanly against the 0.4.0 chart.
- **0.4 prerelease keys may move.** They shipped only in `v0.4.0-beta.*` tags, and
  the beta exists to shake out exactly this. Users who wrote them get a named schema
  error and an upgrade note, not silent breakage.

## Decision

Option (a) from #4299: **concern first, keyed by tier.** The maintainer chose it on
2026-10-06.

### The rule

1. **A knob that more than one tier has lives in a concern map keyed by tier.** The
   tier keys are exactly `api`, `worker` (Celery worker), `beat` (Celery Beat) and
   `web`. The concern maps are `resources`, `probes`, `lifecycle`, `replicas`,
   `processes`, `autoscaling`, `podDisruptionBudget` and `service`.
2. **A tier-named root holds only what exists for that tier and no other.** Today
   that is only `web:`: its on/off switch (`web.enabled`) and its nginx
   configuration (`containerPort`, `maxBodySize`, `adminAccess.*`,
   `securityHeaders.*`). Nothing in it has a counterpart on another tier. The
   API's equivalents of `adminAccess` and `securityHeaders` are Django settings
   reached through `env`.
3. **Optional add-ons are self-contained blocks.** `backup`, `demo`, `persistence`,
   `tests`, `otelCollector`, and the bundled `postgresql`/`valkey` subcharts keep
   any `image`, `resources` or `persistence` settings of their own under their own
   root. So one
   root turns the add-on on or off and holds all of its settings. They are not
   tiers: no concern map gains a `backup` or `demo` key. The subcharts follow
   Helm's subchart convention in any case.
4. **The 0.3 shape is frozen, and the API keeps the bare keys.** `replicaCount`
   stays a scalar: the fleet-wide default that sets the API and worker replicas,
   and the fallback for every `replicas.<tier>` entry. `service.type`/`port` stay
   the API Service. A tier added later gets a named entry (`service.web`,
   `replicas.web`). `service.api.*` and `replicas.api` will not be added as
   aliases. Two keys for one knob is the failure mode the closed schema exists to
   prevent.
5. **Leaf names inside a concern map may be tier-specific when they are the flag
   of the binary they set.** `processes.api.workers` is `uvicorn --workers` and
   `processes.worker.concurrency` is `celery worker --concurrency`. A single
   synthetic leaf such as `processes.<tier>.concurrency` would collide with
   uvicorn's unrelated `--limit-concurrency`. It would also break the one-to-one
   lookup an operator does against the upstream docs.
6. **Beat never gets a `replicas` or `podDisruptionBudget` entry.** It is a pinned
   singleton (ADR-0081). A second Beat double-fires every periodic task, and a
   PDB on it only blocks node drains.

### The mapping (0.4 prerelease → 0.4.0)

| Old key (`v0.4.0-beta.1`…`beta.6`) | New key | Why |
|---|---|---|
| `web.replicaCount` | `replicas.web` | Replicas apply to several tiers. `replicaCount` is the frozen 0.3 scalar, so per-tier overrides need a map beside it. |
| `web.service.type` | `service.web.type` | The Service concern already has a root (`service`, 0.3). |
| `web.service.port` | `service.web.port` | Same. |
| `api.workers` | `processes.api.workers` | Processes per pod apply to the API and the worker, and are sized together with `resources.<tier>`. Every extra process comes out of that tier's memory limit and holds its own DB connection. |
| `celeryWorker.concurrency` | `processes.worker.concurrency` | Same concern. The `celeryWorker` root also used a tier name (`celeryWorker`) that no concern map uses (`worker`). |
| `celeryWorker.maxTasksPerChild` | `processes.worker.maxTasksPerChild` | Process recycling is part of the per-pod process model. |
| `celeryWorker.extraArgs` | `processes.worker.extraArgs` | The worker's command-line escape hatch belongs with the flags it extends. |

The `api:` and `celeryWorker:` roots are removed. Defaults are unchanged, and so is
the rendered output for any values file that sets the same values at the new paths.

### What stays, and why

| Key | Stays because |
|---|---|
| `replicaCount`, `service.type`, `service.port`, `image.repository`, `image.tag`, `image.pullPolicy`, `resources.api`, `resources.worker` | Shipped in a 0.3 tag (rule 4). |
| `image.webRepository` | Already inside the `image` concern map, so it is on the right axis. A `image.web.repository` reshape would move the one key every air-gapped beta operator sets, and would gain nothing structural. |
| `web.enabled` | A tier's on/off switch. This is the universal Helm idiom, and the shape 0.3 already used for `postgresql.enabled`/`valkey.enabled`. |
| `web.containerPort` | nginx's `listen`. The API's container port is fixed at 8000 by the image's command, so there is no cross-tier knob. Its consumers are the nginx config, the container port, and the probes, not the Service, so it is not `service.web.targetPort`. |
| `web.maxBodySize`, `web.adminAccess.*`, `web.securityHeaders.*` | nginx-only configuration with no counterpart on another tier (rule 2). |
| `observability`, `otelCollector`, `logging`, `dashboards`, `alerts` | See below. |

### The five observability roots stay separate

#4299 offered grouping them under one key as optional. They stay separate because
they are not one concern split by tier. They are five independent switches with
different consumers and different prerequisites:

- `observability.otlp` configures the application's own OTLP exporter (env on the
  app containers).
- `otelCollector` is documentation only and renders no objects. The Collector runs
  as a sibling release.
- `logging.level` sets `DJANGO_LOG_LEVEL` on the api, worker and beat containers.
- `dashboards` renders a labeled ConfigMap that only a Grafana sidecar consumes.
- `alerts` renders a `PrometheusRule`, which needs the Prometheus Operator CRDs.

An operator enables these independently, and usually only some of them. None of
them is keyed by tier, so rule 1 does not apply. A wrapper root would only rename
keys that 0.4 prereleases already ship and create upgrade churn, and it would add
no structure.

### #4092, re-scoped

#4092's `celeryWorker.replicaCount` becomes **`replicas.worker`**. It is empty by
default and falls back to `replicaCount`, exactly like `replicas.web`. It is an
additive key in an existing map, so it can land in 0.5 without breaking anyone. If
the API ever needs an override distinct from the fleet default, it would be
`replicas.api`, with the same additive shape. That is not needed today, because
`replicaCount` is the API's count.

## Alternatives Considered

| Option | Pros | Cons |
|---|---|---|
| **(a) Concern-first, keyed by tier (chosen)** | Matches the 0.3 shape and the four concern maps 0.4 already added, so the moves are few (7 keys). It keeps every 0.3 key. One rule says where any future knob goes. | `service.type` (API) next to `service.web.type` is asymmetric, and so is `replicaCount` next to `replicas.web`. The cost of not renaming 0.3 keys is documented, not hidden. |
| (b) Component-first roots, with `replicaCount`/`resources.*` documented as legacy aliases | Every tier's settings are in one place, which is the common Helm community layout. | It inverts four 0.4 concern maps (`probes`, `lifecycle`, `autoscaling`, `podDisruptionBudget`) as well as the 0.3 keys, so the churn is much larger. It also leaves two keys for every resource and replica knob, which is the duplicate-control failure the closed schema exists to stop. |
| `replicaCount` polymorphic (an integer **or** a `{api,worker,web}` map) | One key name. | `--set replicaCount.web=3` against a scalar default discards the scalar and leaves api/worker unset. The schema needs a `oneOf` that `helm lint` explains poorly, and templates have to branch on type everywhere. |
| A uniform leaf, `processes.<tier>.concurrency` | Leaf names are symmetric across tiers. | It collides with uvicorn's `--limit-concurrency` (a different knob), and the lookup from chart key to upstream flag stops being one-to-one. |
| Keep the old keys as schema-accepted aliases for one release | 0.4 beta users would not have to edit anything. | Two keys would claim one knob, and the templates would need precedence rules. Betas exist to absorb this, and the schema error already names the key that needs to move. |
| Group the observability roots under `observability.*` | Fewer top-level roots. | It is a rename with no structural gain, for the reasons above. |

## Consequences

- **Easier.** The location of any new knob follows from the rule: a cross-tier
  concern goes into the concern map, and a single-tier nginx setting goes under
  `web`. #4092 and the datastore keys #3408 adds have a defined home.
- **Easier.** A values file in the wrong shape fails `helm upgrade` with
  `additional properties '<key>' not allowed`, at the path of the old key.
  `scripts/helm-structure-check.sh` §12b asserts that refusal for each of the seven
  moved keys. If a moved key is re-admitted to the schema, the gate fails.
- **Harder.** 0.4 beta operators who set any of the seven keys must edit their
  values files before upgrading to 0.4.0. `getting-started/upgrade.md` carries the
  table and a before/after YAML diff.
- **Harder.** The bare API keys (`replicaCount`, `service.type`/`port`) are a
  permanent asymmetry. The reference page (`administration/helm-values.md`, "How
  the values are laid out") explains it so that a later contributor does not
  "fix" it by adding aliases.

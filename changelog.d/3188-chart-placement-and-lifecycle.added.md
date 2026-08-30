**The chart gains placement, lifecycle, and private-registry knobs.**
`nodeSelector`, `tolerations`, `affinity`, `topologySpreadConstraints`,
`imagePullSecrets`, and `priorityClassName` did not exist — and because
`values.schema.json` closes the root, they were *rejected* rather than ignored,
so an operator mirroring the images into a private registry could not install
the chart at all. Omit a spread constraint's `labelSelector` and the chart fills
it in per tier, so one constraint written once applies correctly to api, worker,
beat, and web. Without it, `replicaCount: 2` plus a PodDisruptionBudget
protected nothing: both pods could land on one node.

**Fixes to the chart's redundancy ceiling.** The API and worker Deployments set
`replicas` unconditionally, so with an HPA enabled every `helm upgrade` reset
the count and the HPA scaled it back — a scale-down flap per release; the field
is now omitted while an HPA owns the tier. `web.replicaCount` shipped as a
truthy `1`, so its documented fallback to the top-level `replicaCount` could
never fire and a `values-prod` deploy rendered api=2, worker=2, **web=1** with
no PDBs; the web tier now follows `replicaCount` and has a PDB of its own.

**Graceful shutdown**, absent from all six workloads: per-tier
`terminationGracePeriodSeconds` and `preStop` hooks, an optional API startup
probe, and a bounded `visibility_timeout` (900s, was Kombu's 3600s default) so a
worker killed mid-task is redelivered in minutes rather than an hour.

**`migrate` is now serialized behind a PostgreSQL advisory lock.** It runs as a
per-pod init container, so at `replicaCount >= 2` every pod ran it concurrently
against one database with no concurrency control anywhere.

**`values-prod.yaml` is a real template.** The 14-line stub rendered an Ingress
on the literal placeholder host with no TLS block and no ingressClassName — it
neither routed nor encrypted — and gave no hint of the eight other things a
production operator had to supply. Also: the chart declares `kubeVersion:
">= 1.23.0-0"`; the bundled Valkey sets `maxmemory` with `noeviction` (it is the
Celery broker and Channels layer, so LRU eviction silently discards queued tasks);
and the bundled PostgreSQL gains a PDB, a priority class hook, and a checkpoint-
sized grace period. Closes #3188.

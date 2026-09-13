---
title: OpenShift Deployment
description: Running the TruePPM Helm chart on OpenShift — what already satisfies the restricted-v2 SCC, the values you must override, Ingress-to-Route conversion, and what does not work today.
documentedFor: "0.4"
---

This page audits the TruePPM Helm chart (`packages/helm/`) against OpenShift's
default `restricted-v2` Security Context Constraint (SCC) and its Ingress→Route
conversion, and says plainly which parts work, which need a values override, and
which do not work today. It assumes you already know OpenShift; for the rest of
the install (secrets, ingress/TLS, sizing, probes) see
[Deployment](/administration/deployment/), [Networking](/administration/networking/),
and [Helm Values](/administration/helm-values/) — this page only covers what is
different on OpenShift.

:::note[Ships in 0.4]
The `ingress.*` Ingress template, `autoscaling.*`, `podDisruptionBudget.*`, and the
Celery worker's `probes.worker.startup` block referenced below do not exist in the
latest release (`v0.3.0-alpha.3`) — they land with the 0.4 beta. `podSecurityContext`
and `containerSecurityContext`, which is what this page is mostly about, have shipped
since 0.1 and are unchanged for OpenShift purposes. See [Helm
Values](/administration/helm-values/#unknown-keys-are-rejected) for the full
released-vs-0.4 split.
:::

:::caution[Audited, not cluster-verified]
This guidance comes from reading `packages/helm/templates/**`, the vendored
`postgresql`/`valkey` subcharts, the application Dockerfiles, and `helm template`
renders of the values below — checked against the published `restricted-v2` SCC
rules (arbitrary non-root UID, GID 0 supplemental group, no host namespaces, no
privileged ports, `RuntimeDefault`/`Localhost` seccomp, all capabilities dropped).
It has **not** been run against a live OpenShift or CRC cluster: the chart's CI
drills (`helm:install`, `helm:netpol`) run on plain `kind`, which does not enforce
SCCs at all. Treat "works today" below as "should pass admission and boot," not as
a tested guarantee, and see [Proposed follow-up](#proposed-follow-up) for adding
real cluster coverage.
:::

## What works today

### The API, web, worker, and beat tiers satisfy `restricted-v2` with one override

`containerSecurityContext` already matches every `restricted-v2` requirement:
`allowPrivilegeEscalation: false`, all capabilities dropped, `seccompProfile:
RuntimeDefault`, `runAsNonRoot: true`. The one line that does not is
`podSecurityContext.runAsUser: 1000` — a **fixed** UID, where `restricted-v2` uses
`MustRunAsRange` and requires the runtime to assign an arbitrary UID from the
namespace's allocated range. Set it to `null` in your values to drop the field
entirely, letting OpenShift assign the UID:

```yaml
# openshift-values.yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: null # let restricted-v2 assign a UID from the namespace's range
```

This was verified with `helm template packages/helm -f openshift-values.yaml`: a
values key set to `null` deletes it from the merged map (rather than being
skipped, which would leave the chart default in place), so the rendered
`securityContext` carries `runAsNonRoot: true` only. No `containerSecurityContext`
change is needed — it never sets a `runAsUser` of its own.

This override applies fleet-wide, because `templates/api/deployment.yaml`,
`templates/web/deployment.yaml`, `templates/celery-worker/deployment.yaml`,
`templates/celery-beat/deployment.yaml`, `templates/cronjob-backup.yaml`,
`templates/demo-seed-job.yaml`, and `templates/tests/api-connection.yaml` all
render the same `.Values.podSecurityContext` / `.Values.containerSecurityContext`
verbatim — one override, every pod. `values.schema.json` leaves both keys as an
open `object` (they are rendered wholesale with `toYaml`), so this is not
rejected by schema validation either.

**Why the images themselves do not block this.** The API image
(`packages/api/Dockerfile`) bakes `USER trueppm` (a named uid-1000 account) and
the web image uses `nginxinc/nginx-unprivileged` (`USER 101`), but neither
Dockerfile's `USER` line matters once OpenShift injects a pod-level
`runAsUser`: Kubernetes' `securityContext.runAsUser` always overrides an image's
`USER` directive. What the arbitrary UID actually needs is **read** access to
`/app` and the venv (world-readable from the image build) and **write** access
only to the mounted volumes — `/tmp`, `/app/staticfiles`, `/run/trueppm`, and
`persistence.media` when it is enabled — every one of which is an `emptyDir` or a
`PersistentVolumeClaim`, not a path baked into the image. `emptyDir` volumes are
created world-writable by the kubelet regardless of which UID the container
runs as, so no `fsGroup` is required for those. Nothing in either Dockerfile
`mkdir`s or `chown`s a path the arbitrary UID would need and not get.

### No privileged ports

The API listens on `8000`, the web tier's unprivileged nginx on `8080`
(`web.containerPort`, matching the base image's own unprivileged default) — see
`templates/api/deployment.yaml` and `templates/web/deployment.yaml`. Nothing in
the chart binds a container port below `1024`, so `restricted-v2`'s port
restriction (which only matters for `hostPort`/`hostNetwork`, both absent here
anyway) is a non-issue.

### `Ingress` converts to `Route` with no chart changes

The chart renders a plain `networking.k8s.io/v1` Ingress
(`templates/ingress.yaml`) — there is no OpenShift-specific object. OpenShift's
built-in ingress-to-route controller watches every namespace and mirrors each
Ingress into one or more `Route` objects automatically; no cluster-admin action
and no `ingressClassName` are required for this to happen. Set
`ingress.className: ""` (the default) so the chart does not stamp an
`ingressClassName` that names a controller OpenShift's router is not:

```yaml
ingress:
  enabled: true
  className: ""
  hosts:
    - host: trueppm.apps.example-cluster.example.com
      paths:
        - path: /api
          pathType: Prefix
          service: api
        - path: /ws
          pathType: Prefix
          service: api
        - path: /
          pathType: Prefix
          service: web
  tls:
    - secretName: trueppm-tls
      hosts:
        - trueppm.apps.example-cluster.example.com
```

Two behaviors worth knowing before you rely on them:

- **One path, one Route.** The sync controller creates a separate `Route` per
  `(host, path)` pair, so the three paths above become three Route objects. Each
  carries its own `path` field, and the router selects the longest matching path
  the same way `ingress-nginx` does — the chart's "list `/api` and `/ws` before
  `/`" ordering advice in [Helm Values](/administration/helm-values/#ingress)
  still applies conceptually, but path length (not list order) is what the
  OpenShift router actually matches on.
- **TLS Secrets convert to edge-terminated Routes.** A `secretName` under
  `ingress.tls` becomes a Route with `tls.termination: edge`, sourcing the
  certificate and key from that Secret. If you run cert-manager on the cluster
  (installed as an Operator or manually — it is not bundled with OpenShift), it
  populates the named Secret exactly as on any other Kubernetes cluster, and the
  sync controller picks up the result. Leaving `ingress.tls` empty renders an
  HTTP-only Ingress and an HTTP-only Route — fine for a dev/demo project, never
  for production, same as on vanilla Kubernetes.
- **Ingress annotations are copied onto the generated Routes.** The controller
  copies the Ingress's annotations verbatim, so OpenShift router annotations set
  under `ingress.annotations` — for example
  `haproxy.router.openshift.io/timeout` for long uploads, or
  `route.openshift.io/termination: reencrypt` / `passthrough` instead of the
  default edge termination — reach the Route without a Route template.

`ingress.annotations`' shipped default,
`nginx.ingress.kubernetes.io/proxy-body-size: "110m"`
(see [Upload size limits](/administration/helm-values/#upload-size-limits)), is
harmless but inert on OpenShift — it is an `ingress-nginx` annotation, and the
generated Route ignores it. The application's own upload caps
(`MAX_ATTACHMENT_SIZE_BYTES`, `MSPROJECT_MAX_UPLOAD_MB`, and friends — see
[Configuration](/administration/configuration/)) still apply and are what
actually rejects an oversized file; the OpenShift HAProxy router imposes no
default body-size ceiling of its own, so you do not need a replacement
annotation for the common case. If you need a router-side cap anyway, that is a
customization of the router's own HAProxy template, outside anything this chart
renders.

### `NetworkPolicy` is enforced under OVN-Kubernetes

`networkPolicy.enabled: true` (the default) restricts ingress to the bundled
datastores to the tiers that need it — see [Network and pod
security](/administration/helm-values/#network-and-pod-security). OVN-Kubernetes
is OpenShift's default network plugin and, from 4.15, the only option for new
installations (OpenShift SDN was deprecated in 4.14). It fully enforces standard
`networking.k8s.io/v1` NetworkPolicy — the same object this chart renders — so no
OpenShift-specific change is needed. A cluster upgraded from an older release may
still run the deprecated OpenShift SDN plugin. To check which plugin your cluster
runs:

```bash
oc get network.config cluster -o jsonpath='{.spec.networkType}{"\n"}'
```

### Private / mirrored registries

`imagePullSecrets` (see [Placement and
scheduling](/administration/helm-values/#placement-and-scheduling)) is the same
air-gapped path on OpenShift as anywhere else: mirror
`registry.gitlab.com/trueppm/trueppm/{api,web}` into a registry your cluster can
reach, point `image.repository` / `image.webRepository` there, and name a pull
secret. OpenShift's own internal registry (`image-registry.openshift-image-registry.svc:5000`)
is one option for that mirror but is not required — any registry reachable from
the cluster works, exactly as on plain Kubernetes.

## Values to set for OpenShift

```yaml
# openshift-values.yaml — layer on top of values-prod.yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: null # let restricted-v2 assign the UID; do not set fsGroup either

ingress:
  enabled: true
  className: "" # empty — do not name an ingress controller that isn't OpenShift's router
  hosts:
    - host: trueppm.apps.example-cluster.example.com
      paths:
        - path: /api
          pathType: Prefix
          service: api
        - path: /ws
          pathType: Prefix
          service: api
        - path: /
          pathType: Prefix
          service: web
  tls:
    - secretName: trueppm-tls
      hosts:
        - trueppm.apps.example-cluster.example.com

# Bundled dev/demo datastores do not satisfy restricted-v2 — see below.
postgresql:
  enabled: false
valkey:
  enabled: false
```

Everything else — `env.DATABASE_URL` / `env.REDIS_URL`, the `envFrom` Secret
carrying `SECRET_KEY` / `ALLOWED_HOSTS` / `INTEGRATION_ENCRYPTION_KEY`, resource
sizing, probes — follows the same rules as any other Kubernetes install; see
[Deployment → Production install walkthrough](/administration/deployment/#production-install-walkthrough).

Create the project and install the same way you would `kubectl create
namespace` + `helm install` anywhere else, substituting the OpenShift CLI's
project verb:

```bash
oc new-project trueppm
helm install trueppm packages/helm \
  -f packages/helm/values-prod.yaml \
  -f openshift-values.yaml \
  -f my-values.yaml
```

No `oc adm policy add-scc-to-user` call is needed for the api/web/worker/beat
tiers — every service account in a normal OpenShift project already has
`restricted-v2` available, and the chart never creates or references a custom
`ServiceAccount` (`automountServiceAccountToken: false` on every pod; all tiers
run as the project's default account with its token unmounted).

### Verifying it

```bash
oc get scc restricted-v2 -o yaml
oc get project trueppm -o jsonpath='{.metadata.annotations.openshift\.io/sa\.scc\.uid-range}'
oc get pods -n trueppm
oc get routes -n trueppm
```

A pod stuck in `CreateContainerConfigError` or rejected at admission with a
message naming `runAsUser` means a values file upstream of `openshift-values.yaml`
re-introduced a fixed UID — check for a values file loaded **after** this one
that also sets `podSecurityContext`, since a later `-f` file's keys win.

## What does not work today

### The bundled dev/demo `postgresql` and `valkey` subcharts

`packages/helm/charts/postgresql/templates/statefulset.yaml` and
`charts/valkey/templates/statefulset.yaml` each hardcode
`runAsUser: 999` / `runAsGroup: 999` / `fsGroup: 999` directly in the template —
not read from any values key, so there is **no override available** from the
parent chart's `values.yaml`. `restricted-v2`'s `MustRunAsRange` strategy
rejects a pod that requests a specific UID outside the namespace's assigned
range, so **`postgresql.enabled: true` / `valkey.enabled: true` will not admit
on a stock OpenShift project.**

Two ways around it, neither of which this chart can do for you:

- **Use external managed PostgreSQL/Valkey** (`postgresql.enabled: false`,
  `valkey.enabled: false`, `env.DATABASE_URL` / `env.REDIS_URL`) — already the
  chart's documented production recommendation regardless of platform (see
  [Bundled datastores](/administration/helm-values/#bundled-datastores)), and
  the only path this page can currently recommend for OpenShift.
- **Grant a permissive SCC** (`anyuid`, or a custom SCC scoped to uid 999) to the
  project — requires a cluster-admin, is a real security downgrade for what is
  meant to be a dev/demo workload, and is not something the chart or these docs
  configure for you.

Making the subcharts' UID/GID configurable is tracked in
[#3731](https://gitlab.com/trueppm/trueppm/-/issues/3731); until it ships, treat
the bundled datastores as **unsupported on OpenShift**, on any project running
the default SCC set.

### No native `Route` object

The chart renders `Ingress` only. Because the ingress-to-route controller copies
Ingress annotations onto each Route it generates (see
[above](#ingress-converts-to-route-with-no-chart-changes)), per-Route router
annotations such as timeouts work through `ingress.annotations`. What the
conversion cannot express is Route *spec* that has no Ingress equivalent —
weighted `alternateBackends` for blue/green traffic splitting, or a
re-encrypt destination CA managed alongside the Route. If you need those, create
the `Route` objects yourself outside the chart; an optional native Route template
is tracked in [#3732](https://gitlab.com/trueppm/trueppm/-/issues/3732).

### No CI coverage against a real OpenShift SCC

`helm:install` and `helm:netpol` (the chart's install and NetworkPolicy
enforcement drills) run on plain `kind`, which admits any pod regardless of UID
— it has no SCC concept at all. Nothing in CI currently re-runs either drill
under an SCC-enforcing cluster, so a future change to `podSecurityContext`,
`containerSecurityContext`, or either subchart's `statefulset.yaml` could
silently reintroduce an OpenShift regression with every existing gate still
green.

## Proposed follow-up

The gaps above are tracked as chart issues:

- [#3731](https://gitlab.com/trueppm/trueppm/-/issues/3731) — **make the bundled
  `postgresql`/`valkey` subcharts' `securityContext` configurable** (expose
  `runAsUser`/`runAsGroup`/`fsGroup` as subchart values, defaulting to today's
  `999` so nothing changes for existing installs) so a project with a
  permissive-enough SCC — or a future `restricted-v2`-compatible image — can run
  them. Today there is no override at all.
- [#3732](https://gitlab.com/trueppm/trueppm/-/issues/3732) — **an optional native
  `Route` template** (`route.enabled`, gated off by default) for operators who need
  Route spec the Ingress conversion cannot express, such as weighted backends.
- [#3733](https://gitlab.com/trueppm/trueppm/-/issues/3733) — **an
  OpenShift/CRC-equivalent CI drill** alongside `helm:install` / `helm:netpol` so
  a `restricted-v2` regression fails a pipeline instead of waiting for an
  operator to hit it — the gap this page's own "audited, not cluster-verified"
  caveat exists to name.

## Related

- [Deployment](/administration/deployment/) — the full Compose / Helm / systemd install paths
- [Networking](/administration/networking/) — DNS, TLS topologies, and the ports/firewall matrix this page does not repeat
- [Helm Values Reference](/administration/helm-values/) — every chart key, including `podSecurityContext`, `containerSecurityContext`, and `ingress.*`
- [Deployment Sizing](/administration/sizing/) — replica counts and resource profiles, unchanged on OpenShift

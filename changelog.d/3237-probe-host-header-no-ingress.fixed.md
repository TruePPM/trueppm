**The Helm chart's API probes no longer stamp an example hostname onto a
no-Ingress install.** `trueppm.probeHostHeader` resolved the probe `Host` header
from `ingress.hosts` without ever testing `ingress.enabled` — and
`ingress.enabled: false` is the chart default while `ingress.hosts` ships
populated with the placeholder `trueppm.example.com`. Every install without an
Ingress therefore sent `Host: trueppm.example.com` on both the readiness and
liveness probes, a name no `ALLOWED_HOSTS` contains. Django answers
400 DisallowedHost from `get_host()` before any view runs, so `/readyz` never
passed, the pod never turned Ready, the Service never got an endpoint, and
`/health/` failed liveness into a restart loop — with nothing in the output
naming `ALLOWED_HOSTS`. The chart's own `values-demo.yaml` install was affected.

The header now resolves to the first ingress host only when `ingress.enabled` is
true, and otherwise to the api Service's own DNS name `<release>-trueppm-api` —
the name the `helm test` connection probe already curls and that the deployment
guide already tells you to allow, so the default install needs no
`probes.api.hostHeader` value at all. An explicit `probes.api.hostHeader` still
beats both branches.

Operator note: if you worked around this by setting `probes.api.hostHeader`
explicitly, that setting still wins and nothing changes for you. If you had not,
add `<release>-trueppm-api` to `ALLOWED_HOSTS` (`trueppm-api` when your release
name already contains "trueppm") — `values-demo.yaml` and the Helm README now
document it in the `ALLOWED_HOSTS` they prescribe.

`scripts/helm-structure-check.sh` asserted the old behavior and passed for the
wrong reason: it rendered with defaults, where no Ingress exists, then required
the header to equal `ingress.hosts[0].host`. It now checks both branches, the
release-scoped Service name, that the fallback matches what `helm test` resolves,
and that an explicit override beats each branch.

Closes #3237

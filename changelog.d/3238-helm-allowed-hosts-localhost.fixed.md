**The Helm quickstart's `ALLOWED_HOSTS` now covers the port-forward path.** With
`ingress.enabled: false` — the chart default — `NOTES.txt` tells the operator to
`kubectl port-forward` to the web Service, and that is the only route into the
app. The web tier's nginx proxies `/api/` with `proxy_set_header Host $host`, so
Django receives `Host: localhost`. Every documented `ALLOWED_HOSTS` omitted it.

The failure was deceptively partial: nginx serves the SPA document and its JS
bundles off disk without ever touching Django, so the app **rendered**, and then
every `/api/v1/...` XHR answered 400 DisallowedHost. It read as a broken build,
with nothing anywhere naming `ALLOWED_HOSTS`. The Compose side of this was fixed
in #3183; the Helm side was not.

`packages/helm/README.md`, the deployment guide, and `NOTES.txt` now agree on an
`ALLOWED_HOSTS` that includes `localhost` and `127.0.0.1`, and `NOTES.txt` prints
the requirement next to the port-forward command it is a precondition for. The
"Host names you must include" table in the configuration reference gains the
port-forward row — the only reachable caller on a default chart install, and the
one it was missing.

**Also corrected: `trueppm-api` is not the Service name for every release.** The
docs told operators to add `trueppm-api` for `helm test`, which is right only for
a release literally named `trueppm`. `trueppm.fullname` collapses the duplicate
segment only when the release name already contains the chart name, so
`helm install ppm ...` produces `ppm-trueppm-api` and `helm test` failed with a
400 that named nothing. Both the Helm README and the deployment guide now say so.

Guarded by `scripts/helm-structure-check.sh`, which asserts the notice fires for
both `web.enabled` topologies and that every `ALLOWED_HOSTS` the chart README and
deployment guide prescribe contains `localhost` — the chart and the docs are
checked against each other, because the defect was that they disagreed.

Closes #3238

---
title: Networking
description: DNS, TLS termination, WebSockets through a proxy, load balancing, health checks, and the ports and firewall rules a TruePPM install needs.
documentedFor: "0.4"
---

Everything between your users and the API: the DNS records to create, where TLS
terminates, what a proxy has to forward for real-time collaboration to work,
where a load balancer sits when you scale past one replica, which health-check
path to point it at, and the full ingress/egress port matrix.

:::note[Ships in 0.4]
The Kubernetes half of this page describes chart objects that ship in **0.4**,
the first beta, and are **not** in `v0.3.0-alpha.3`, the latest release. On 0.3
the chart renders no `Ingress`, no web tier, and no HTTP probes — you front the
`ClusterIP` API Service with your own ingress object. Specifically unreleased:

- the chart-managed **`Ingress`** template and its `ingress.hosts[].paths[].service`
  routing (`ingress.enabled` exists as a value on 0.3 but renders nothing);
- the **web tier** (`web.*`) and its nginx config, including `web.securityHeaders.*`
  and `web.adminAccess.*`;
- the **`probes.*`** block, including `probes.api.hostHeader`;
- the optional **`PodDisruptionBudget`** and **`HorizontalPodAutoscaler`**.

The Docker Compose and single-server material — DNS, `TLS_MODE`, the shipped
nginx templates, the health-check endpoints, and the port matrix — describes the
current release.
:::

## One origin, four variables

**TruePPM runs on a single hostname.** The SPA, the REST API, and the WebSocket
endpoint are all served from the same origin, and every shipped topology routes
them by path on one host:

| Path prefix | Served by |
|---|---|
| `/` | the compiled React SPA (nginx) |
| `/api/` | the Django API |
| `/ws/` | the Django Channels WebSocket endpoint (`/ws/v1/projects/<uuid>/`) |
| `/static/` | Django's collected static files (admin CSS, Swagger UI) |

Four settings all name that one origin. They are read by different subsystems
and nothing cross-checks them, so a mismatch surfaces later as a 400, a broken
email link, or an OIDC `redirect_uri` your identity provider rejects — never as
a startup error:

| Variable | Format | Read by | If it disagrees |
|---|---|---|---|
| `DOMAIN` | bare hostname, no scheme — `trueppm.example.com` | Docker Compose only: `envsubst` into the nginx `server_name` and the certificate paths, and `certbot -d` | nginx serves the default server or fails to find the certificate; ACME issues for the wrong name |
| `ALLOWED_HOSTS` | comma-separated bare hostnames | Django, on every request | **HTTP 400** on every request whose `Host` header is not listed — including health checks that connect by IP (see [Health checks](#health-checks-for-an-external-load-balancer)) |
| `TRUEPPM_FRONTEND_BASE_URL` | full origin with scheme, no trailing slash, no path — `https://trueppm.example.com` | notification email deep-links | emails link to the wrong host, or omit links entirely when unset |
| `TRUEPPM_PUBLIC_API_BASE_URL` | full origin with scheme, no trailing slash — same origin as above | OIDC only: builds `{base}/api/v1/auth/oidc/callback/` | your IdP refuses the login with a `redirect_uri` mismatch |

`TRUEPPM_PUBLIC_API_BASE_URL` is empty by default, which falls back to the
incoming request's absolute URL. That is correct for local dev and wrong behind
a proxy, where the value then depends on forwarded headers rather than on
anything you set. **Set it explicitly on any proxied deploy** so the value your
IdP allow-lists is deterministic. See [Single sign-on](/administration/single-sign-on/).

### Split hostnames are not supported

Serving the SPA at `app.example.com` and the API at `api.example.com` **does not
work**. TruePPM ships no CORS support — there is no `django-cors-headers`
dependency and no `CORS_*` setting, so Django never emits an
`Access-Control-Allow-Origin` header and the browser blocks every cross-origin
XHR and WebSocket upgrade from the SPA. `CSRF_TRUSTED_ORIGINS`,
`CSP_CONNECT_SRC`, and `AUTH_REFRESH_COOKIE_SAMESITE` address CSRF, CSP, and
cookie scope — three different layers, none of them CORS — so relaxing them
changes nothing about the block. Use one hostname.

A **wildcard certificate and a wildcard DNS record are not required.** One name
is enough.

## DNS

### Records to create

One `A` record (and one `AAAA` if you serve IPv6) pointing at whatever
terminates TLS — the Compose host's public IP, your load balancer, or the
ingress controller's external address:

```dns
; example.com zone file
$ORIGIN example.com.
$TTL 300

trueppm     IN  A       203.0.113.42
trueppm     IN  AAAA    2001:db8::2a

; Optional but recommended: pin which CAs may issue for this name.
; Required if you use ACME (Let's Encrypt) — issuance fails if a CAA
; record exists and does not list the CA.
trueppm     IN  CAA 0 issue "letsencrypt.org"
trueppm     IN  CAA 0 iodef "mailto:ops@example.com"
```

Keep the TTL low (300s) until the install is verified, then raise it.

On Kubernetes, do not hand-maintain the record if you can avoid it — point
`external-dns` at the same hostname you put in `ingress.hosts[0].host`, so the
record and the Ingress cannot drift.

**Verify before installing.** `ALLOWED_HOSTS` rejects anything else, and ACME
HTTP-01 validation needs the name to already resolve:

```bash
dig +short trueppm.example.com A
dig +short trueppm.example.com AAAA
```

### Split-horizon and internal-only names

If TruePPM resolves to a private address on the inside and a public one on the
outside, nothing in the app cares — it only ever sees the `Host` header. But
TruePPM's **outbound** SSRF guard does care: every host TruePPM connects to must
resolve to a globally routable address, or the request is refused. That blocks
an in-cluster identity provider (`keycloak.sso.svc`), an internal SMTP relay, or
a MinIO endpoint on a private VIP.

`TRUEPPM_EGRESS_ALLOWLISTED_HOSTS` is the escape hatch — a comma-separated list
of exact, case-insensitive hostnames exempted from that check:

```bash
TRUEPPM_EGRESS_ALLOWLISTED_HOSTS=keycloak.sso.svc.cluster.local,smtp.internal.example.com
```

No wildcards. The allow-list is consulted by **every** egress caller (SSO,
webhooks, SMTP, integration credential verification), so only list a host you
trust at least as much as your identity provider. See
[Outbound requests](/administration/security/#outbound-requests-ssrf-boundary).

### Internal (cluster) DNS

The Helm web tier's nginx proxies `/api/` and `/ws/` to the API Service by name.
The chart's fullname helper collapses the release name when it already contains
`trueppm`, so `helm install trueppm ...` yields `trueppm-api` and
`helm install foo ...` yields `foo-trueppm-api`:

| Object | In-cluster name | Port |
|---|---|---|
| API Service | `<release>-api` (or `<release>-trueppm-api`) | `8000` (`service.port`) |
| Web Service | `<release>-web` (or `<release>-trueppm-web`) | `80` (`web.service.port`), container `8080` |

:::caution[nginx resolves upstreams once, at startup]
nginx resolves a `proxy_pass` hostname when it parses the config, not per
request. If the name does not resolve at that moment, **nginx exits** — the pod
crash-loops with `host not found in upstream`, and no request is ever served.

Two consequences:

1. **Never reuse the Compose nginx config on Kubernetes.** `nginx/app.conf.template`
   proxies to `http://api:8000` — a Compose network alias that does not exist in
   a cluster. The chart's own config uses the release-scoped Service name, which
   is why it works and a copied compose config does not.
2. If you replace the web tier with your own nginx, the API Service must exist
   before that nginx starts. A `helm upgrade` that recreates both at once can
   lose the race; give your nginx a `resolver` directive and a variable
   `proxy_pass` if you need it to tolerate a missing upstream at boot.
:::

## TLS

TruePPM never terminates TLS itself. The API container speaks plain HTTP on
`:8000`, always. Something in front of it — the bundled nginx, an ingress
controller, or a cloud load balancer — owns the certificate.

### Topologies

| Topology | TLS terminates at | Must forward | `TRUEPPM_SECURE_SSL_REDIRECT` | HSTS owner |
|---|---|---|---|---|
| **Compose + bundled nginx** (`TLS_MODE=letsencrypt` / `selfsigned`) | the stack's nginx, on `:443` | nothing to configure — `nginx/app.conf.template` already sets `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` and the WebSocket upgrade headers | leave `false` — nginx already 301s `:80` → `:443` | the nginx template (`max-age=63072000; includeSubDomains`) |
| **Compose behind an external LB** (`TLS_MODE=none`) | your load balancer | LB → nginx: `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, `Upgrade`, `Connection`. **See the caveat below** — the HTTP template overwrites `X-Forwarded-Proto` | leave `false` — the LB does the redirect | the load balancer |
| **Helm + ingress-nginx** | the `Ingress` (`ingress.tls[].secretName`) | ingress-nginx sets `X-Forwarded-For` / `X-Forwarded-Proto` itself; add the WebSocket timeout annotations from [WebSockets](#websockets-behind-a-proxy) | leave `false` — set `nginx.ingress.kubernetes.io/ssl-redirect: "true"` instead (it is the controller default when a TLS block exists) | ingress-nginx (`hsts: true` in its ConfigMap) and `web.securityHeaders.strictTransportSecurity` for the SPA document |
| **Helm behind a cloud LB** (ALB / GCLB), Ingress in HTTP mode | the cloud load balancer | the LB must send `X-Forwarded-Proto: https`. ALB and GCLB both do. Keep the backend protocol on **HTTP/1.1** so the WebSocket upgrade survives | leave `false` | the cloud LB, plus `web.securityHeaders.strictTransportSecurity` |
| **Helm + cert-manager** | the `Ingress`, with the Secret provisioned automatically | as ingress-nginx above | leave `false` | as ingress-nginx above |

`TRUEPPM_SECURE_SSL_REDIRECT` stays `false` in every supported topology. Turn it
on only when TruePPM receives the original scheme reliably *and* nothing in
front of it already redirects — otherwise you get a redirect loop. The probe
paths (`/api/v1/health/`, `/api/v1/readyz`, `/api/v1/edition/`) are exempt from
the redirect regardless, so enabling it never breaks a health check. See
[TLS redirect posture](/administration/configuration/#tls-redirect-posture).

:::caution[Two ways `X-Forwarded-Proto` goes wrong]
`settings.prod` sets `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")`
and trusts that header **unconditionally** — it does not check who sent it. Two
consequences:

**1. The API Service must not be reachable directly.** Anything that can open a
socket to the API pod on `:8000` can assert `X-Forwarded-Proto: https` and be
believed. The chart's NetworkPolicy restricts ingress to the *datastore* pods
only; it deliberately does not restrict ingress to the API pods, so this is
yours to enforce — see [Ports and firewall](#ports-and-firewall).

**2. The Compose HTTP template rewrites the header.** `nginx/app-http.conf.template`
(selected by `TLS_MODE=none`, the template you use behind an external LB) sets
`proxy_set_header X-Forwarded-Proto $scheme`. On that path `$scheme` is `http`,
so nginx **replaces** your load balancer's `https` with `http`. Django then
believes the request was insecure: it emits no HSTS, builds `http://` absolute
URLs (which is what an unset `TRUEPPM_PUBLIC_API_BASE_URL` uses for the OIDC
`redirect_uri`), and would 301-loop if `TRUEPPM_SECURE_SSL_REDIRECT` were on.

The fix is to honor the inbound header when there is one. Add a `map` to your
copy of the template and use it in place of `$scheme` on every `proxy_set_header
X-Forwarded-Proto` line:

```nginx
map $http_x_forwarded_proto $forwarded_proto {
    default $http_x_forwarded_proto;   # trust the LB when it sent one
    ''      $scheme;                   # otherwise use our own scheme
}
```

Only do this when the LB is the *only* way in — an untrusted client that can
reach nginx directly can now set the header too.
:::

The missing `X-Forwarded-For` has a quieter failure. DRF's per-IP throttles read
the client address `TRUEPPM_NUM_PROXIES` hops back in `X-Forwarded-For`
(default `1`). The Helm web tier's nginx sets `Host`, `X-Real-IP` and
`Authorization` but **not** `X-Forwarded-For`, so if you route `/api` through
the web tier instead of straight to the API Service, every request arrives with
the same apparent source address and the per-IP login and anonymous throttles
collapse into one shared bucket. The default `ingress.hosts` sends `/api` and
`/ws` directly to the API Service, where this does not arise; if you change that,
add the header at your edge.

### cert-manager

`ClusterIssuer` is cluster-scoped, so one object serves every namespace. Pick
HTTP-01 if the hostname is reachable from the public internet on port 80, and
DNS-01 if it is not (or if you want a wildcard).

**HTTP-01** — cert-manager creates a temporary Ingress to answer the challenge,
so `ingress.class` must match the controller that owns your hostname:

```yaml
# clusterissuer-http01.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    # cert-manager creates this Secret and stores the ACME account key in it.
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            class: nginx
```

```bash
kubectl apply -f clusterissuer-http01.yaml
kubectl get clusterissuer letsencrypt-prod -o wide   # READY should be True
```

**DNS-01** — no inbound port 80 needed, works for internal-only hostnames and
wildcards. Route 53 shown; every provider differs only in the solver block:

```bash
kubectl create secret generic route53-credentials \
  --namespace cert-manager \
  --from-literal=secret-access-key='<AWS secret access key>'
```

```yaml
# clusterissuer-dns01.yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-dns-account-key
    solvers:
      - dns01:
          route53:
            region: us-east-1
            hostedZoneID: Z0123456789ABCDEFGHIJ
            accessKeyID: AKIAIOSFODNN7EXAMPLE
            secretAccessKeySecretRef:
              name: route53-credentials
              key: secret-access-key
        # Only solve for names in this zone; other names fall through to
        # another solver. Drop the selector if this issuer serves everything.
        selector:
          dnsZones:
            - example.com
```

Pair either issuer with the chart's Ingress. The annotation names the issuer;
cert-manager watches the Ingress, sees the `tls` block, and creates the
`trueppm-tls` Secret for you — you never run `kubectl create secret tls`:

```yaml
# my-values.yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod   # or letsencrypt-dns
    # Keep the chart's own default; Helm deep-merges this map, but naming the
    # key here replaces it, so restate it.
    nginx.ingress.kubernetes.io/proxy-body-size: "110m"
    # WebSocket lifetime — see the timeout table below.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  hosts:
    - host: trueppm.example.com
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
        - trueppm.example.com
```

Watch the issuance; a stuck certificate almost always names its own cause:

```bash
kubectl -n trueppm get certificate trueppm-tls
kubectl -n trueppm describe certificate trueppm-tls
kubectl -n trueppm get challenges          # empty once validation completes
```

### Bring your own certificate — Kubernetes

If your certificate comes from an internal CA or a commercial vendor, create the
Secret yourself and skip cert-manager entirely. The Secret must be in the same
namespace as the Ingress:

```bash
kubectl create secret tls trueppm-tls \
  --namespace trueppm \
  --cert=fullchain.pem \
  --key=privkey.pem
```

`fullchain.pem` must be the leaf certificate **followed by every intermediate**,
in that order. A leaf-only file validates in a browser that already caches the
intermediate and fails everywhere else.

Then reference it, with no `cert-manager.io/cluster-issuer` annotation:

```yaml
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: trueppm-tls
      hosts:
        - trueppm.example.com
```

Renewal is yours: replace the Secret (`kubectl create secret tls ... --dry-run=client -o yaml | kubectl apply -f -`) before expiry. ingress-nginx picks up the
change without a restart.

### Bring your own certificate — Docker Compose

`TLS_MODE` has three values (`letsencrypt`, `selfsigned`, `none`) and none of
them means "use the certificate I already have". The HTTPS nginx template reads
a fixed pair of paths, so the supported way in is to put your files there:

```
certbot/conf/live/${DOMAIN}/fullchain.pem
certbot/conf/live/${DOMAIN}/privkey.pem
```

Order matters, because `init-prod.sh` overwrites both files on the `selfsigned`
path and replaces `nginx/active.conf.template` on every path:

```bash
# 1. First boot only. TLS_MODE=selfsigned selects the HTTPS nginx template and
#    leaves the certbot renewal profile OFF — both of which is what you want.
#    It also writes a throwaway self-signed pair, which step 2 replaces.
./init-prod.sh

# 2. Install the real certificate over it.
cp /path/to/fullchain.pem certbot/conf/live/"${DOMAIN}"/fullchain.pem
cp /path/to/privkey.pem   certbot/conf/live/"${DOMAIN}"/privkey.pem

# 3. Reload nginx in place — no downtime, no container restart.
docker compose -f docker-compose.prod.yml exec nginx nginx -s reload
```

:::caution
Do not re-run `init-prod.sh` afterwards. With `TLS_MODE=selfsigned` it
regenerates the self-signed pair and silently overwrites your certificate; with
`TLS_MODE=none` it swaps the config back to the plain-HTTP template. On renewal,
repeat steps 2 and 3 only.
:::

The nginx container already reloads itself every 6 hours, so replacing the files
and waiting is also valid — the explicit reload just makes it immediate.

## WebSockets behind a proxy

Real-time collaboration runs over `wss://<host>/ws/v1/projects/<uuid>/`. The
connection is authenticated by a single-use ticket on the query string
(`?ticket=...`), minted by `POST /api/v1/ws/ticket/`.

### Required headers

Any proxy in the path must speak HTTP/1.1 upstream and pass the upgrade
handshake through. This is the shipped block from `nginx/app.conf.template`,
annotated:

```nginx
# Maps the inbound Upgrade header to the right Connection value. Without the
# map, a `Connection: upgrade` hard-coded on non-WebSocket requests breaks
# keepalive; with it, normal HTTP gets `Connection: close`.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

location /ws/ {
    proxy_pass             http://api:8000;

    # REQUIRED. The Upgrade mechanism does not exist in HTTP/1.0, which is
    # nginx's default to upstreams — without this the handshake never happens
    # and the client sees a plain 200 or 400 instead of a 101.
    proxy_http_version     1.1;

    # REQUIRED. These two carry the handshake itself.
    proxy_set_header       Upgrade           $http_upgrade;
    proxy_set_header       Connection        $connection_upgrade;

    # REQUIRED. Django validates this against ALLOWED_HOSTS on the WebSocket
    # path too; nginx would otherwise send the upstream's name ("api").
    proxy_set_header       Host              $host;

    # Client identity for the per-IP throttles (see TRUEPPM_NUM_PROXIES).
    proxy_set_header       X-Real-IP         $remote_addr;
    proxy_set_header       X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header       X-Forwarded-Proto $scheme;

    # A WebSocket carries no traffic while a project is quiet. The default
    # 60s would close it; this is a connection lifetime, not a request timeout.
    proxy_read_timeout     86400s;
}
```

### Idle timeouts

Every proxy closes a connection that looks idle. The knob is different on each
one, and on some of them it is not an *idle* timeout at all:

| Proxy | Knob | Default | Set to |
|---|---|---|---|
| nginx (standalone) | `proxy_read_timeout` / `proxy_send_timeout` | 60s | `3600s` or more |
| ingress-nginx | `nginx.ingress.kubernetes.io/proxy-read-timeout` / `proxy-send-timeout` (seconds, unquoted number as a string) | 60 | `"3600"` |
| AWS ALB | `idle_timeout.timeout_seconds`, via `alb.ingress.kubernetes.io/load-balancer-attributes` | 60 | `3600` (ALB maximum 4000) |
| GCP external HTTP(S) LB | backend service `timeoutSec`, via a `BackendConfig` | 30 | `3600` |
| HAProxy | `timeout tunnel` (`haproxy.org/timeout-tunnel` on the HAProxy Ingress Controller) | inherits `timeout client`/`timeout server` | `3600s` |

Recommended floor: **3600 seconds**. A user with the schedule open in a
background tab over lunch is a normal case, and a reconnect storm from a whole
team timing out together is not.

:::caution[On GCP, `timeoutSec` is a hard lifetime, not an idle timeout]
For WebSocket backends the Google Cloud load balancer treats the backend
service's `timeoutSec` as the **maximum duration the connection may stay open**,
whether or not traffic is flowing. Keepalive pings do not extend it. Every
client will be disconnected at that interval; size it accordingly and make sure
the reconnect path is exercised.
:::

### Why idle sockets survive a 60s default today

Nothing in the TruePPM client sends a heartbeat — the project socket is
receive-only, and the presence keepalive re-arms a Redis TTL without putting a
byte on the wire. What actually keeps an idle connection alive is **uvicorn's
protocol-level ping**:

- `ws_ping_interval` defaults to `20.0` — uvicorn sends a WebSocket PING frame
  every 20 seconds on every open socket.
- `ws_ping_timeout` also defaults to `20.0` — if the matching PONG does not come
  back within 20 seconds, **uvicorn** closes the connection.

The API image runs bare `uvicorn` with no override for either, so both defaults
apply. That 20-second ping is the only reason a 60-second proxy default does not
drop every socket, and it is load-bearing rather than deliberate. Two rules
follow:

1. **Never set `--ws-ping-interval` above your proxy's idle timeout.** Raising it
   to "reduce chatter" reintroduces exactly the disconnect it is preventing.
2. **Do not buffer the WebSocket location.** A proxy that delays PONGs by more
   than 20 seconds makes the *server* drop the client — a disconnect that looks
   like a network fault and is not.

### No sticky sessions

**Session affinity is not required, and you should not configure it.** Any
replica can serve any socket:

- The channel layer is `channels_redis.core.RedisChannelLayer`, backed by the
  same Valkey every replica shares. There is no in-memory layer anywhere in the
  settings tree.
- Group names derive from the project UUID (`project_<uuid>`), not from pod
  identity, so a broadcast reaches subscribers on every replica.
- The WebSocket ticket is written to Valkey and consumed with `GETDEL`, so a
  ticket minted by the pod that answered `POST /api/v1/ws/ticket/` is redeemable
  on any other pod — and exactly once.
- Celery-originated broadcasts (`cpm_complete` and friends) go through the same
  channel layer, so a worker's result reaches clients regardless of which
  replica they are attached to.

The one requirement is that **all replicas share one logical Valkey**. Point
them at the same instance (or the same Sentinel set); do not give each replica
its own cache.

### HTTP/2 and HTTP/3

WebSockets over HTTP/2 need the RFC 8441 Extended CONNECT protocol, which most
ingress controllers and cloud load balancers do not implement, and HTTP/3 needs
RFC 9220. In practice:

- **Browser → edge over HTTP/2 is fine.** A browser that cannot upgrade over h2
  falls back to HTTP/1.1 for the WebSocket request specifically.
- **Edge → TruePPM must be HTTP/1.1.** That is what `proxy_http_version 1.1`
  guarantees on the nginx path. On a cloud LB, leave the backend protocol at
  HTTP/1.1 for the `/ws` target group or backend service — forcing HTTP/2 or
  gRPC there breaks the upgrade with no useful error.

### Symptoms

| What you see | Cause | Fix |
|---|---|---|
| Closes immediately, code **4003** | The authenticated user's role on that project is Viewer. Not a networking fault. | Grant Member or above; see [RBAC](/administration/rbac/). |
| Closes immediately, code **4001** | No valid credential: the ticket is missing, expired, or already redeemed. Tickets are single-use, so a client that reuses one across reconnects fails on the second attempt. | Mint a fresh ticket per connection. |
| Closes immediately, code **4404** | The path matched no route. | Check the edge is not rewriting or stripping the `/ws` prefix — `/ws/v1/projects/<uuid>/` must arrive intact. |
| Handshake never completes; you get **HTTP 200 with the SPA's HTML**, or a 400 | The proxy stripped `Upgrade`/`Connection`, or spoke HTTP/1.0 upstream, or `/ws` fell through to the SPA's `try_files` catch-all. | Add the three required headers and `proxy_http_version 1.1`; route `/ws` before `/`. |
| Connects fine, then **1006** at a regular interval, all users together | A proxy idle or lifetime timeout below the connection's real lifetime. On GCP this is `timeoutSec` and pings will not save you. | Raise the timeout from the table above. |
| Connects, then the **server** drops after 20–40 seconds of quiet | PONGs are being buffered past `ws_ping_timeout` (20s). | Disable response buffering on the WebSocket location. |
| Works on one replica, breaks after scaling out | Replicas do not share a Valkey, or two different Valkey instances are configured. | Point every replica at one instance. Do **not** reach for session affinity. |

## Scaling out

### Where the load balancer sits

```mermaid
flowchart TB
    client["Browsers and mobile clients<br/>HTTPS and WSS, one hostname"]
    lb["Edge: ingress controller, cloud LB,<br/>or the Compose nginx<br/>TLS terminates here"]
    web["Web tier, nginx<br/>serves the SPA<br/>N replicas, stateless"]
    api["API tier, uvicorn<br/>REST and WebSocket<br/>N replicas, stateless"]
    worker["Celery workers<br/>CPM and Monte Carlo<br/>N replicas"]
    beat["Celery beat<br/>exactly 1 replica"]
    pg[("PostgreSQL<br/>managed")]
    valkey[("Valkey<br/>broker, channel layer,<br/>WS tickets, locks")]
    obj[("Object storage<br/>attachments")]

    client --> lb
    lb -->|"path: root"| web
    lb -->|"path: api and ws"| api
    api --> pg
    api --> valkey
    api --> obj
    worker --> pg
    worker --> valkey
    worker --> obj
    beat --> valkey
```

The edge is the only externally-facing object. Both Services stay `ClusterIP`;
nothing below the edge should be reachable from outside the cluster — see the
`X-Forwarded-Proto` caveat above for why that is a security property and not
just tidiness.

### Prerequisites for more than one API replica

Everything in the API tier is stateless *except* what is listed here. Work
through it before raising `replicaCount`:

- [ ] **One hostname, one origin.** All replicas answer on the same name; the four
      variables above agree.
- [ ] **A shared PostgreSQL.** Use a managed instance; the bundled sub-chart is
      dev/demo only. Watch the connection ceiling — see
      [Sizing](/administration/sizing/#bottlenecks-in-the-order-they-bite).
- [ ] **One shared Valkey.** It is the Celery broker, the Channels layer, the
      WebSocket ticket store, and the per-project scheduling lock. Splitting it
      breaks real-time collaboration and duplicates CPM runs.
- [ ] **Shared storage for attachments** — object storage (S3, MinIO, Ceph) or a
      `ReadWriteMany` volume. This is a **hard requirement above one replica**, not
      a durability nicety: with attachments on each pod's local disk, a file
      uploaded through replica A returns 404 when the download lands on replica B.
      Set `TRUEPPM_DEFAULT_FILE_STORAGE` and `TRUEPPM_S3_BUCKET_NAME` — see
      [object storage](/administration/configuration/#object-storage-s3--minio).
- [ ] **Celery beat stays at exactly one replica.** It fires the periodic drains;
      two overlapping beats double-dispatch every job. The chart pins it to one
      replica with a `Recreate` strategy.
- [ ] **No session affinity.** See above — configuring it only concentrates load.
- [ ] **A `PodDisruptionBudget`** (`podDisruptionBudget.enabled=true`) so a node
      drain cannot take every API replica at once.
- [ ] **WebSocket timeouts raised at the edge** (previous section) before the
      reconnect load of a larger user base finds them.

Migrations are not a concern: they run in an `initContainer` before the API
container starts, and Django's migration table makes concurrent runs safe.

## Health checks for an external load balancer

| Path | Auth | What it checks | Codes | Use it for |
|---|---|---|---|---|
| `/api/v1/health/` | none (`AllowAny`) | **Nothing.** It returns `{"status": "ok"}` if the process is running and can route a request. | `200` only | Liveness. A load balancer target check where you want "is the process up". |
| `/api/v1/readyz` | none (`AllowAny`) | Database reachable, cache reachable, and every migration shipped in the image applied. | `200` ready, **`503`** not ready | **Readiness — the right choice for an external LB's target-group health check.** It removes a pod whose datastore is down or whose schema and code disagree mid-upgrade. |
| `/api/v1/edition/` | none (`AllowAny`) | Nothing. Returns edition, version, and build SHA. | `200` only | Build identification, not health. |
| `/api/v1/health/beat/` | **staff only** (`IsAdminUser`) | Celery Beat heartbeat freshness. | `200` / `503` | Authenticated monitoring (Prometheus with a token). **Not usable as an LB probe** — it 403s without credentials. |
| `/api/v1/health/system/` | **staff only** (`IsAdminUser`) | Deep system status for the admin UI. | `200` | Admin diagnostics. **Not an LB probe.** |
| `/api/v1/health/dead-letter/`, `/api/v1/health/email/` | **staff only** (`IsAdminUser`) | Dead-letter and email gauges, Prometheus text exposition. | `200` | Scrape targets, with credentials. **Not LB probes.** |

:::caution[`/api/v1/readyz` has no trailing slash]
Every sibling path on this page ends in `/`. This one does not, and Django will
not redirect to it — a probe configured as `/api/v1/readyz/` gets a **404** and
marks every target unhealthy. Copy the path exactly.
:::

:::danger[A health check that connects by IP gets an HTTP 400]
Neither probe path is exempt from `ALLOWED_HOSTS`. A load balancer configured
with a target of `203.0.113.42:8000` and no `Host` override sends
`Host: 203.0.113.42`, which is not in `ALLOWED_HOSTS`, so Django returns **400
Bad Request** — and the check fails on a perfectly healthy pod. This is the most
common cause of a first install that looks broken.

Fix it in whichever way your LB supports, in this order of preference:

1. **Send the right `Host` header on the check.** AWS ALB target groups take a
   `Host` matcher on the health check; GCP health checks take a `host` field;
   HAProxy uses `http-check send hdr Host <name>`; nginx `proxy_set_header Host`.
   Set it to the same hostname as `ALLOWED_HOSTS`. On Kubernetes, the chart
   handles the equivalent problem for kubelet probes with
   `probes.api.hostHeader`, which sets `httpGet.httpHeaders` on both API probes.
2. **Add the address to `ALLOWED_HOSTS`.** Works, but widens what the app will
   answer on, and needs updating whenever the address changes.

Do **not** set `ALLOWED_HOSTS=*`. It disables Django's Host-header validation
entirely, which is a real defense against cache-poisoning and password-reset
poisoning attacks.
:::

A worked ALB example, on the chart's Ingress:

```yaml
ingress:
  annotations:
    alb.ingress.kubernetes.io/healthcheck-path: /api/v1/readyz
    alb.ingress.kubernetes.io/success-codes: "200"
    alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=3600
```

Verify a probe path by hand before wiring it up — from inside the cluster, with
the `Host` header set the way the LB will send it:

```bash
kubectl -n trueppm run curl --rm -it --image=curlimages/curl --restart=Never -- \
  curl -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Host: trueppm.example.com' \
  http://trueppm-api:8000/api/v1/readyz
```

`200` is ready. `503` is a real dependency failure — read the body, which names
which check failed. `400` means the `Host` header did not match `ALLOWED_HOSTS`.

## Ports and firewall

The chart's NetworkPolicy locks down the bundled **datastore** pods and
deliberately leaves the API and worker pods unrestricted in both directions —
their outbound endpoints (your IdP, your SMTP relay, your object store) are
deployment-specific, so a chart-imposed allow-list would break real installs.
That work is yours to do at the platform layer, and this is the list to do it
from. See [Datastore network isolation](/administration/security/#datastore-network-isolation)
for what the chart already covers.

### Inbound

| Source | Destination | Port / protocol | Required? | Why |
|---|---|---|---|---|
| Browsers, mobile clients | edge (ingress controller / cloud LB / Compose nginx) | 443/tcp | **Yes** | HTTPS and WSS. The only port that must be open to users. |
| Browsers | edge | 80/tcp | Yes for ACME HTTP-01; otherwise optional | Serves `/.well-known/acme-challenge/` and the 301 to HTTPS. Close it only if you use DNS-01 and accept that `http://` gives no redirect. |
| Let's Encrypt validation servers | edge | 80/tcp, from anywhere | Only with ACME HTTP-01 | The CA connects from unpredictable addresses; it cannot be source-restricted. |
| Edge | web Service / web tier pods | 80/tcp (container 8080) | Yes when the web tier is enabled | Serves the SPA. |
| Edge | API Service / API pods | 8000/tcp | **Yes** | REST and WebSocket. Must be reachable **only** from the edge — see the `X-Forwarded-Proto` caveat. |
| kubelet (node) | API pods | 8000/tcp | Yes (Kubernetes) | Liveness and readiness probes. |
| API, Celery worker, Celery beat, backup CronJob, demo-seed Job | PostgreSQL | 5432/tcp | **Yes** | Primary data store. Never expose to the internet. |
| API, Celery worker, Celery beat, demo-seed Job | Valkey | 6379/tcp | **Yes** | Broker, channel layer, WebSocket tickets, scheduling locks. Never expose to the internet. |
| Prometheus / your monitoring | API | 8000/tcp | Optional | Scrapes `/api/v1/health/beat/`, `/health/dead-letter/`, `/health/email/` — all staff-authenticated, so the scraper needs a token. |
| Operators | API pod, via `kubectl port-forward` | 8000/tcp (local) | Optional | The supported route to Django admin; no firewall rule needed. |

### Outbound

TruePPM's SSRF guard already refuses any destination that resolves to a
non-globally-routable address unless it is in
`TRUEPPM_EGRESS_ALLOWLISTED_HOSTS`. That is an application control, not a
network one — you still need the firewall rules below.

| Source | Destination | Port / protocol | Required? | Why |
|---|---|---|---|---|
| API, worker, beat | DNS resolver | 53/udp, 53/tcp | **Yes** | Resolving every destination below. |
| Nodes / Docker host | container registry (`ghcr.io`) | 443/tcp | **Yes**, at pull time | Pulling the API and web images. Mirror it internally for an air-gapped install. |
| API, worker | SMTP relay | `EMAIL_PORT`, default 587/tcp (465 implicit TLS, 25 plain) | If email notifications are enabled | Notification and invitation email. `EMAIL_USE_TLS` defaults to `true`. |
| API | OIDC / OAuth2 identity provider | 443/tcp | If SSO is configured | Discovery document, authorization, token exchange, JWKS. An in-cluster IdP needs `TRUEPPM_EGRESS_ALLOWLISTED_HOSTS`. |
| Browsers | OIDC identity provider | 443/tcp | If SSO is configured | The login redirect happens in the user's browser, not server-side — the *client* network needs this too. |
| API, worker | S3 endpoint or MinIO | 443/tcp (MinIO commonly 9000/tcp) | If object storage is enabled — required above one replica | Attachment upload, download, and presigned URLs (`TRUEPPM_S3_ENDPOINT_URL`). |
| API, worker | OTLP collector | 4317/tcp (gRPC) or 4318/tcp (HTTP) | If `OTEL_EXPORTER_OTLP_ENDPOINT` is set | Traces and metrics. Off by default — no endpoint, no egress. |
| API, worker | Slack, and your own webhook receivers | 443/tcp | If webhooks or the Slack integration are configured | Outbound webhook delivery from the outbox. |
| API, worker | Jira / GitLab / self-hosted trackers | 443/tcp | If a user connects an external task source | Read-only pull of a contributor's assigned items. |
| certbot (Compose) | `acme-v02.api.letsencrypt.org` | 443/tcp | With `TLS_MODE=letsencrypt` | Issuance and the 12-hourly renewal. |
| cert-manager (Kubernetes) | ACME directory | 443/tcp | With cert-manager | Issuance and renewal. |
| cert-manager (Kubernetes) | DNS provider API (e.g. Route 53) | 443/tcp | With a DNS-01 solver | Writing and deleting the `_acme-challenge` TXT record. |
| Backup CronJob | your backup destination | destination-specific | If backups ship off-cluster | See [Backup & restore](/administration/backup-restore/). |

An install with no email, no SSO, no telemetry, no webhooks, and object storage
inside the cluster needs **no outbound internet access at all** once the images
are pulled.

## See also

- [Deployment](/administration/deployment/) — Compose, Helm, and single-server walkthroughs
- [Configuration](/administration/configuration/) — the full environment-variable reference
- [Helm values](/administration/helm-values/) — every chart key
- [Sizing](/administration/sizing/) — replica counts and where the bottlenecks are
- [Security](/administration/security/) — CSP, headers, secrets, and the NetworkPolicy
- [Single sign-on](/administration/single-sign-on/) — the OIDC redirect URI and in-cluster identity providers

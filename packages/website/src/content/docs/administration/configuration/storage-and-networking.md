---
title: "Object storage, TLS and split-origin deploys"
description: "S3/MinIO object storage, the TLS redirect posture, and the settings for deploys that split the web and API origins."
documentedFor: "0.4"
---

## Object storage (S3 / MinIO)

Task attachments are the only user data TruePPM writes outside PostgreSQL. The
local `FileSystemStorage` default is **ephemeral in a container**, and production
refuses to boot on it, so a durable deploy points
`TRUEPPM_DEFAULT_FILE_STORAGE` at an S3-compatible bucket.

The API image bundles the S3 backend, so the two variables below are all a
deploy against AWS S3 needs:

```bash
TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage
TRUEPPM_S3_BUCKET_NAME=trueppm-attachments
```

Credentials are deliberately **not** required. Left unset, the AWS SDK resolves
them from its own chain — IRSA on EKS, an IAM instance profile, or `~/.aws` —
which is preferable to pinning static keys into a Secret. Set
`TRUEPPM_S3_ACCESS_KEY_ID` / `TRUEPPM_S3_SECRET_ACCESS_KEY` only when no such
role is available (MinIO, Ceph, Wasabi).

| Variable | Default | Description |
|---|---|---|
| `TRUEPPM_S3_BUCKET_NAME` | _(empty)_ | Bucket that holds task attachments. **Required** when `TRUEPPM_DEFAULT_FILE_STORAGE` names an S3 backend — startup fails with `trueppm.E008` if it is missing, rather than accepting the config and failing on the first upload. |
| `TRUEPPM_S3_ENDPOINT_URL` | _(empty)_ | Endpoint for a non-AWS S3-compatible store, e.g. `http://minio:9000`. Leave empty for AWS S3 so the SDK resolves the real regional endpoint. |
| `TRUEPPM_S3_REGION_NAME` | `us-east-1` | Region for the bucket. Must be non-empty even against MinIO: SigV4 embeds the region in the credential scope, so an empty value produces an unusable signature. |
| `TRUEPPM_S3_ADDRESSING_STYLE` | _(SDK default `auto`)_ | Set to `path` for MinIO and Ceph RGW, which do not serve virtual-hosted bucket URLs without per-bucket DNS. Leave unset for AWS S3. |
| `TRUEPPM_S3_ACCESS_KEY_ID` | _(empty)_ | Static access key. Omit to use the SDK credential chain (IRSA / instance profile). |
| `TRUEPPM_S3_SECRET_ACCESS_KEY` | _(empty)_ | Static secret key. Omit to use the SDK credential chain. |
| `TRUEPPM_S3_SIGNATURE_VERSION` | `s3v4` | Signing algorithm for presigned URLs. Leave at the default — the SDK would otherwise fall back to the deprecated SigV2 whenever an endpoint URL is set, and AWS rejects SigV2 in every region created after 2014. |
| `TRUEPPM_S3_QUERYSTRING_EXPIRE` | `900` | Lifetime, in seconds, of the presigned URL returned by the attachment **Get signed download URL** action. |

### MinIO

```bash
TRUEPPM_DEFAULT_FILE_STORAGE=storages.backends.s3.S3Storage
TRUEPPM_S3_BUCKET_NAME=trueppm-attachments
TRUEPPM_S3_ENDPOINT_URL=http://minio:9000
TRUEPPM_S3_ADDRESSING_STYLE=path
TRUEPPM_S3_ACCESS_KEY_ID=your-access-key
TRUEPPM_S3_SECRET_ACCESS_KEY=your-secret-key
```

Create the bucket before first use — TruePPM does not create it for you. Keep it
**private**: attachments are reached only through a presigned URL, and a
world-readable bucket makes that signature meaningless.

:::caution[Do not hand TruePPM your MinIO root credentials]
`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` — whose out-of-the-box value on a fresh
MinIO is `minioadmin` for both — are the **administrative** account for the whole
server. Two separate things to get right:

1. **Change the defaults.** A MinIO reachable on `minioadmin`/`minioadmin` is
   compromised the moment anything can route to it.
2. **Do not use the root account here even after changing it.** Issue a dedicated
   MinIO **access key** scoped to a policy that allows only
   `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on
   `arn:aws:s3:::trueppm-attachments/*` (plus `s3:ListBucket` on the bucket
   itself), and put *that* key pair in the two variables above. TruePPM never
   needs to create buckets, read other buckets, or administer the server, so a
   leaked application credential should not be able to.
:::

### Which backends the image can import

The image bundles **S3 only**. `storages.backends.gcloud.GoogleCloudStorage` and
`storages.backends.azure_storage.AzureStorage` are recognized as signing-capable
by the signed-URL action, but their client libraries are not installed — naming
one fails startup with `trueppm.E007` and the exact package to install:

```text
(trueppm.E007) STORAGES['default']['BACKEND'] is set to
'storages.backends.gcloud.GoogleCloudStorage', which cannot be imported:
Could not load Google Cloud Storage bindings.
    HINT: Install it with: pip install 'django-storages[google]' (this image
    bundles django-storages[s3] only), or point TRUEPPM_DEFAULT_FILE_STORAGE at
    a backend the image carries.
```

To run on GCS or Azure Blob, install the extra into a derived image:

```dockerfile
FROM registry.gitlab.com/trueppm/trueppm/api:latest
USER root
RUN pip install --no-cache-dir 'django-storages[google]'
USER trueppm
```

### Signed download URLs

The attachment **Get signed download URL** action returns a time-limited URL only
when it can confirm the backend genuinely signs one. On the S3 backend above it
does, and the URL carries a real `X-Amz-Expires`. On `FileSystemStorage` — or any
backend the action does not recognize — it refuses with `501 Not Implemented`
rather than hand back a permanent link labeled "signed". If you run a
signing-capable backend that is not recognized, opt in with
`TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS=true`.

The caller may request a lifetime with `?ttl=<seconds>` (default 900, hard-capped
at 3600). That value is applied to the **signature itself**, so the `expires_at`
in the response and the URL's real expiry always agree.
`TRUEPPM_S3_QUERYSTRING_EXPIRE` sets the default used when a request omits `ttl`.

## TLS redirect posture

`TRUEPPM_SECURE_SSL_REDIRECT` controls whether the `prod` settings module issues an
HTTP→HTTPS redirect for every request. It is **opt-in and defaults to `false`** for a
reason that trips up a first deploy: most self-hosted installs terminate TLS at an
ingress or load balancer and speak plain HTTP from there to the app pod, including the
Kubernetes liveness/readiness probes hitting `/api/v1/health/` and `/api/v1/edition/`.
An unconditional redirect in that topology would 301-loop the probes and take the pod
out of rotation.

| Variable | Default | What it does |
|---|---|---|
| `TRUEPPM_SECURE_SSL_REDIRECT` | `false` | When `true`, `prod` redirects every non-HTTPS request to HTTPS, using `SECURE_PROXY_SSL_HEADER` (`X-Forwarded-Proto`) to detect the original scheme behind a proxy. |

There is no companion variable for the **host**, deliberately. `prod` pins
`USE_X_FORWARDED_HOST = False` and `USE_X_FORWARDED_PORT = False`: the scheme has
to come from the proxy because the container cannot know it, but the host does
not, and no proxy TruePPM ships sets `X-Forwarded-Host`. Trusting it would mean
believing a header only the client could have written. When your edge rewrites
`Host`, set `TRUEPPM_PUBLIC_API_BASE_URL` instead — a value you control, rather
than a belief about a header TruePPM cannot verify.

Turn it on only when TruePPM itself terminates TLS or otherwise receives the original
request scheme reliably — for example, a deployment that exposes the app directly over
HTTPS with no intervening proxy, or a proxy configured to forward `X-Forwarded-Proto`
correctly. The Kubernetes health-probe paths (`/api/v1/health/`, `/api/v1/readyz`,
`/api/v1/edition/`) are always exempt from the redirect regardless of this setting, so
turning it on never breaks the probes even if they are reached over plain HTTP.

This setting has no effect outside `trueppm_api.settings.prod` — the `dev` settings
module never enforces an HTTPS redirect.

## Split-origin deploys

:::danger[Not supported — TruePPM requires a single origin]
Serving the SPA at `https://app.example.com` and the API at
`https://api.example.com` **cannot be made to work**, and no combination of the
settings below will make it work.

TruePPM ships **no CORS support**: `django-cors-headers` is not a dependency and
there is no `CORS_*` setting anywhere in the settings tree, so Django never emits
an `Access-Control-Allow-Origin` header. Without that header the browser blocks
every cross-origin XHR and every cross-origin WebSocket upgrade the SPA attempts,
before any of TruePPM's own configuration is consulted.

`CSRF_TRUSTED_ORIGINS`, `AUTH_REFRESH_COOKIE_SAMESITE`, and `CSP_CONNECT_SRC`
govern CSRF token validation, cookie scope, and Content-Security-Policy — three
different layers, none of them CORS. Relaxing them weakens the install and
changes nothing about the block.

Earlier revisions of this page gave a split-origin recipe built on those three
settings. It never worked, and it has been removed.
:::

**Serve the SPA, the API, and the WebSocket endpoint from one hostname**, routed
by path — `/` to the SPA, `/api/` and `/ws/` to Django. Every shipped topology
(the Docker Compose nginx templates, the published `web` image, and the Helm
chart's default `ingress.hosts`) already does this, so a standard deploy needs no
origin configuration at all: the secure defaults assume a single origin and are
correct as shipped.

Four variables must all describe that one origin —
`DOMAIN`, `ALLOWED_HOSTS`, `TRUEPPM_FRONTEND_BASE_URL`, and (with OIDC)
`TRUEPPM_PUBLIC_API_BASE_URL`. See
[One origin, four variables](/administration/networking/#one-origin-four-variables)
for the full table and what each mismatch looks like.

### When the settings above still matter

Same-origin is the requirement for the SPA reaching its own API. The three
settings remain useful for narrower cases on a single-origin deploy:

| Setting | Still needed when |
|---------|-------------------|
| `CSRF_TRUSTED_ORIGINS` | A proxy in front of TruePPM rewrites the `Origin` or `Referer` header, so Django's CSRF check sees an origin that is not the one it served. Add the origin the browser actually sends. |
| `CSP_CONNECT_SRC` | The page must open connections to something other than TruePPM — an analytics endpoint, or an object store you serve attachment downloads from directly. Add that origin; do not remove `'self'`. |
| `AUTH_REFRESH_COOKIE_SAMESITE` | You embed TruePPM in an iframe on another site, where `SameSite=Strict` suppresses the refresh cookie. `None` requires `Secure`, which is already enforced, **and** the `TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE_NONE_ACK` sentinel (0.4) or it is refused at boot. Note the default CSP sets `frame-ancestors 'none'`, so framing needs that changed too. **Relaxing this setting does not relax the refresh/logout endpoints' independent `Sec-Fetch-Site` / `Origin` check (0.4)** — a cross-site `Sec-Fetch-Site`, or an `Origin` matching neither same-origin nor `CSRF_TRUSTED_ORIGINS`, is still rejected regardless of `SameSite`. A request with neither header (the mobile app, a non-browser API client) is unaffected either way. |

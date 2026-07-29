---
title: Configuration
description: Environment variables and settings for TruePPM.
---

All configuration is via environment variables. For local development, `docker-compose.yml` sets sensible defaults.

## Required in production

| Variable | Description | Example |
|----------|-------------|---------|
| `SECRET_KEY` | Django secret key. Use a long random string. | `$(python -c "import secrets; print(secrets.token_urlsafe(50))")` |
| `DATABASE_URL` | PostgreSQL connection string. **Include `?sslmode=require`** — production refuses to boot on a URL without an `sslmode` parameter (the connection could otherwise fall back to unencrypted transport), unless you set `TRUEPPM_ALLOW_UNENCRYPTED_DB=true` because TLS is enforced at the network layer. | `postgres://trueppm:password@db:5432/trueppm?sslmode=require` |
| `REDIS_URL` | Connection string for the Celery broker / Channels layer. TruePPM ships with [Valkey](https://valkey.io) (BSD-licensed Redis fork, wire-compatible); the `redis://` scheme works against either. | `redis://valkey:6379` |
| `DJANGO_SETTINGS_MODULE` | Settings module to load. | `trueppm_api.settings.prod` |
| `ALLOWED_HOSTS` | Comma-separated list of allowed hostnames. | `trueppm.example.com` |
| `INTEGRATION_ENCRYPTION_KEY` | Fernet key that encrypts stored integration credentials (connected-account PATs) at rest. **Production refuses to boot if this is empty** — the guard runs at settings-import time, so a missing key crash-loops the deploy rather than failing later. | `$(python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")` |
| Attachment storage | Pick one: set `TRUEPPM_DEFAULT_FILE_STORAGE` to a persistent object-storage backend, **or** set `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE=true` if local disk is backed by a persistent volume. **Production refuses to boot on the ephemeral local default** otherwise (see [optional settings](#optional--advanced-settings) for the two variables). | `storages.backends.s3.S3Storage` |

## Default values (development only)

| Variable | Default |
|----------|---------|
| `SECRET_KEY` | `dev-secret-key-change-in-prod` |
| `DATABASE_URL` | `postgres://trueppm:trueppm@db:5432/trueppm` |
| `REDIS_URL` | `redis://valkey:6379` |
| `DJANGO_SETTINGS_MODULE` | `trueppm_api.settings.dev` |
| `ALLOWED_HOSTS` | `*` |

:::danger
Never use the default `SECRET_KEY` or `ALLOWED_HOSTS=*` in production. The default secret key is public — anyone who knows it can forge session cookies and JWTs.
:::

## Optional / advanced settings

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SIGNING_KEY` | `SECRET_KEY` | Dedicated signing key for access/refresh JWTs. When unset it inherits `SECRET_KEY`, so a single strong value covers everything. Set it to a separate strong value (same rules as `SECRET_KEY` — ≥ 32 chars, not the `django-insecure-` placeholder, or prod refuses to boot) to limit the blast radius of a `SECRET_KEY` leak and to gain an independent **rotate-to-sign-everyone-out** lever. See [Secret management](/administration/security/#separating-the-jwt-signing-key-and-forcing-a-global-sign-out). |
| `TRUEPPM_REFRESH_TOKEN_REMEMBER_DAYS` | `30` | Session length when a user checks **"Keep me signed in"** at login: a persistent refresh cookie (survives browser close) and matching token lifetime, in days. |
| `TRUEPPM_REFRESH_TOKEN_SESSION_HOURS` | `12` | Sliding idle lifetime for a **not-remembered** login (the default, and all SSO logins): the refresh cookie is a session cookie (dropped on browser close) and the token expires after this many idle hours. |
| `TRUEPPM_EDITION` | `community` | Edition discriminator read by `/api/v1/edition/`. Set to `enterprise` in the enterprise Helm chart so the React shell can make the post-login redirect decision without importing enterprise code (ADR-0029). Never set this in an OSS deployment. |
| `TRUEPPM_VERSION` | the installed package version | Version string surfaced on `/api/v1/edition/`; will also feed the [in-product feedback](#in-product-feedback-report-a-bug) payload once that control ships in 0.4, so a bug report names the exact release it came from. Leave unset to use the running package's own version. |
| `TRUEPPM_BUILD_SHA` | _(empty)_ | Commit SHA of the image build, surfaced alongside `TRUEPPM_VERSION`. Set by the Helm chart's image build pipeline; empty on a source checkout, where the version string alone is identifying enough. |
| `TRUEPPM_SECURE_SSL_REDIRECT` | `false` | Production-only HTTP→HTTPS redirect. See [TLS redirect posture](#tls-redirect-posture) below before enabling it. |
| `TRUEPPM_PUBLIC_API_BASE_URL` | _(empty)_ | Public origin of the API itself (not the web app), used only to build the OIDC `redirect_uri` your identity provider redirects back to: `{TRUEPPM_PUBLIC_API_BASE_URL}/api/v1/auth/oidc/callback/`. Empty (the default) falls back to the incoming request's absolute URL — correct for a single-origin dev setup, but **behind a reverse proxy or load balancer set this explicitly** so the value your IdP's allow-listed redirect URI must match is deterministic rather than dependent on request headers. A trailing slash is stripped. See [Single sign-on](/administration/single-sign-on/). |
| `TRUEPPM_HISTORY_RETENTION_DAYS` | `90` | How many days of object-change history to keep. Records older than this are purged nightly by Celery beat. To disable automatic purging, set the Django setting to `None` in a settings override or toggle the table off in the [Retention & purge](/administration/retention/) editor. **Do not set `0`** — a zero-day window makes the cutoff "now" and purges all rows on the next run. The legacy bare `HISTORY_RETENTION_DAYS` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_TASK_RUN_RETENTION_DAYS` | `30` | How many days of completed/failed/canceled Celery task-run records to keep before the nightly purge. To disable, set the Django setting to `None` in a settings override or toggle the table off in the [Retention & purge](/administration/retention/) editor. **Do not set `0`** — a zero-day window purges all rows on the next run. The legacy bare `TASK_RUN_RETENTION_DAYS` is still read as a fallback when the prefixed var is unset. |
| `MSPROJECT_MAX_UPLOAD_MB` | `50` | Per-file size cap for MS Project (`.mpp` / `.xml`) imports, in megabytes. See [MS Project import limit](#ms-project-import-limit) below. |
| `JIRA_IMPORT_MAX_UPLOAD_MB` | `25` | Per-file size cap for [Jira XML](/features/jira-import/) imports, in megabytes. See [Jira import limit](#jira-import-limit) below. |
| `CSV_IMPORT_MAX_UPLOAD_MB` | `10` | Per-file size cap for [CSV / Excel](/features/csv-import-export/) imports, in megabytes. See [CSV / Excel import limits](#csv--excel-import-limits) below. |
| `CSV_IMPORT_MAX_ROWS` | `5000` | Maximum data rows a single CSV / Excel import may contain. Rows past the cap are reported back as skipped, not silently dropped. |
| `CSV_IMPORT_MAX_UNCOMPRESSED_MB` | `100` | Decompression-bomb ceiling for `.xlsx` uploads: the maximum total *uncompressed* size the workbook may declare. |
| `TRUEPPM_THROTTLE_ANON_RATE` | `60/min` | General default rate limit for **unauthenticated** requests, per client IP, in DRF `<count>/<period>` form (`period` is `sec`, `min`, `hour`, or `day`). Applies to every endpoint that does not set its own throttle. See [general API rate limiting](#general-api-rate-limiting) below. |
| `TRUEPPM_THROTTLE_USER_RATE` | `1000/min` | General default rate limit for an **authenticated** account, in DRF `<count>/<period>` form. Applies to every endpoint that does not set its own throttle. See [general API rate limiting](#general-api-rate-limiting) below. |
| `TRUEPPM_NUM_PROXIES` | `1` | Number of trusted reverse proxies in front of the API. Used to extract the real client IP for the **unauthenticated** rate limit from the `X-Forwarded-For` chain. The standard Helm chart runs a single ingress (`1`); set to your actual proxy depth, or `0` if the API is reached directly (uses `REMOTE_ADDR`). An incorrect value lets a client spoof its IP and evade the anon limit, so match it to your deployment. |
| `TRUEPPM_RATE_LIMIT_ENABLED` | `true` | Global on/off switch for **all** API rate limiting. Leave `true` in production. Setting it `false` requires an explicit acknowledgment env var and disables every throttle instance-wide (DoS/abuse protection off) — intended for load testing only. See [disabling rate limiting entirely](#disabling-rate-limiting-entirely) below. |
| `TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE` | `5/min` | Per-**account** login rate limit, bucketed by hashed username across all source IPs, in DRF `<count>/<period>` form. Stacks with the fixed per-IP `login` throttle to bound distributed credential stuffing. See [login brute-force protection](#login-brute-force-protection) below. |
| `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED` | `true` | Org-wide kill switch for [public sharing](/features/board-sharing/) — governs **both** board and schedule links. When `false`, project Admins cannot mint public links (`403`) **and** every existing public link stops resolving (`404`) instance-wide — the operator lever for locked-down environments. No data is exposed until an Admin explicitly creates a link, so the default is on. |
| `TRUEPPM_THROTTLE_SHARE_ACCESS_RATE` | `60/min` | Rate limit for the **unauthenticated** public board endpoint (`GET /share/board/<token>/`), per client IP, in DRF `<count>/<period>` form. Bounds scraping of a leaked or widely-shared link. |
| `TRUEPPM_THROTTLE_SHARE_MINT_RATE` | `20/min` | Rate limit for an Admin minting public board links, per account, in DRF `<count>/<period>` form. |
| `TRUEPPM_THROTTLE_SAMPLE_LOAD_RATE` | `6/min` | Rate limit for loading a bundled demo sample (`POST /programs/load-sample/`), per account, in DRF `<count>/<period>` form. Each call rebuilds an entire program — a teardown of the caller's previous copy plus a full fixture import, run synchronously — so the cap is deliberately tight. Ample for a person clicking **Load demo data** and trying a couple of samples; raise it only if you are scripting demo environments. |
| `TRUEPPM_THROTTLE_SEED_IMPORT_RATE` | `6/min` | Rate limit for importing a JSON seed bundle (`POST /programs/import/`), per account, in DRF `<count>/<period>` form. Runs the same synchronous importer as the demo loader above, on a payload the caller supplies. Separate bucket, so loading a demo does not spend an import allowance. Raise it if you bulk-migrate programs through the API. |
| `TRUEPPM_THROTTLE_SEED_VALIDATE_RATE` | `20/min` | Rate limit for the seed **dry run** (`POST /programs/import/validate/`), per account, in DRF `<count>/<period>` form. Looser than the import bucket because the dry run never reaches the importer — it parses and validates, then writes nothing. Separate bucket for a usability reason as much as a cost one: iterating on a file until it validates must not spend the allowance for importing the file that finally passes. |
| `TRUEPPM_THROTTLE_OMNI_SEARCH_RATE` | `60/min` | Rate limit for the ⌘K global Epic/Story omni-search, per account, in DRF `<count>/<period>` form. Matches the general user-typeahead rate — snug enough to block a scripted scrape of every title an account can see, loose enough that live typing never trips it. |
| `TRUEPPM_THROTTLE_SAMPLE_DOWNLOAD_RATE` | `60/min` | Rate limit for downloading a bundled sample fixture (`GET /programs/samples/{key}/download/`), per account, in DRF `<count>/<period>` form. Looser than `TRUEPPM_THROTTLE_SAMPLE_LOAD_RATE` because a download only streams a small file off disk and touches no table — but it is still throttled, since it serves a file keyed by a client-supplied string and would otherwise double as an enumeration oracle. |
| `TRUEPPM_THROTTLE_TELEMETRY_TEST_RATE` | `6/min` | Rate limit for the admin-only telemetry test-export probe (each call opens a real outbound connection to the configured OTLP collector), per account, in DRF `<count>/<period>` form. Tight enough that the probe cannot be used to hammer the collector. |
| `TRUEPPM_THROTTLE_MCP_READ_RATE` | `120/min` | Baseline rate limit for **API-token** reads on the [MCP read surface](/features/mcp-server/), per token, in DRF `<count>/<period>` form. Does not affect human session/JWT traffic. See [MCP read-surface rate limiting](#mcp-read-surface-rate-limiting) below. |
| `TRUEPPM_THROTTLE_MCP_READ_COMPUTE_RATE` | `12/min` | Tighter rate limit stacked on the four **compute-heavy** MCP tools (what-if, latest Monte Carlo, forecast, sprint-forecast), per token, in DRF `<count>/<period>` form. See [MCP read-surface rate limiting](#mcp-read-surface-rate-limiting) below. |
| `TRUEPPM_MCP_ENABLED` | `true` | Instance-wide kill switch for [MCP (AI-agent) token access](/features/mcp-server/). When `false`, every `mcp:read` token read is denied (`403`) across the whole instance — even for tokens that already exist — while human session/JWT traffic on the same endpoints is unaffected. The operator lever for "no agent access on this instance, period." See [MCP read-surface rate limiting](#mcp-read-surface-rate-limiting) below. |
| `TRUEPPM_MAX_PERSONAL_ACCESS_TOKENS` | `10` | Maximum number of **active** [personal access tokens](/features/personal-access-tokens/) a single user may hold at once (not revoked, not expired). Bounds the blast radius of a leaked account. Once at the cap a user must revoke one before minting another. |
| `TRUEPPM_MAX_USER_PINS` | `100` | Maximum pinned projects + programs a single user may hold. This is a navigability cap on the pinned rail and `/me/pinned/`, not a security control — exceeding it returns `400` with `code: "pin_limit_reached"`. |
| `TRUEPPM_TOKEN_ISSUANCE_PER_MINUTE` | `5` | Per-account rate limit (requests per minute) on the token-mint endpoint. Caps the blast radius of a scripted attacker on a compromised admin session even when RBAC is satisfied. |
| `TRUEPPM_TASK_SYNC_STEADY_STATE_LIMIT` | `100` | Per-project steady-state rate limit (requests per minute) for the inbound [task-sync](/features/jira-import/) endpoint, applied after the 60-minute backfill window. |
| `TRUEPPM_TASK_SYNC_BACKFILL_LIMIT` | `1000` | Per-project rate limit (requests per minute) for inbound task-sync during the first 60 minutes after a token is minted, giving a large first import headroom before dropping to the steady-state limit. |
| `TRUEPPM_SHARE_BOARD_MAX_CARDS` | `1000` | Maximum cards in a public board snapshot; a larger board is truncated (the viewer sees a "showing the first N cards" note). |
| `TRUEPPM_SHARE_SCHEDULE_MAX_TASKS` | `1000` | Maximum tasks in a public [schedule share](/features/board-sharing/) snapshot; a larger schedule is truncated the same way as an over-cap board. |
| `VITE_FEATURE_FLAGS` | `{}` | Build-time JSON blob of feature flag overrides for the React frontend, e.g. `'{"schedule_build_mode_v1":true}'`. Set in `packages/web/.env` or `.env.production` before `npm run build`. Per-user `localStorage` overrides win over this default at runtime. |
| `TRUEPPM_DEFAULT_FILE_STORAGE` | `django.core.files.storage.FileSystemStorage` | Backend for task-attachment storage. The local default is **ephemeral in a container** — uploads are lost on every pod restart, and `prod` refuses to boot on it (see `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE`). Point this at a persistent object-storage backend for production, e.g. `storages.backends.s3.S3Storage`. |
| `TRUEPPM_ALLOW_LOCAL_ATTACHMENT_STORAGE` | `false` | Operator opt-in to run production on the local `FileSystemStorage` default (e.g. when local disk is backed by a persistent volume). `prod` refuses to boot on local storage unless this is `true` or `TRUEPPM_DEFAULT_FILE_STORAGE` is set to a remote backend. |
| `STATIC_ROOT` | `staticfiles/` under the app directory | Filesystem path WhiteNoise collects and serves Django static assets from (`manage.py collectstatic`). Override only if your container image lays out paths differently than the shipped image. |
| `TRUEPPM_ATTACHMENT_STORAGE_SIGNS_URLS` | `false` | Operator opt-in confirming `TRUEPPM_DEFAULT_FILE_STORAGE` produces a real time-limited signed URL. The attachment **Get signed download URL** action only recognizes the built-in django-storages S3, GCS, and Azure Blob backends automatically; on `FileSystemStorage` (the default) or any other backend it refuses with `501 Not Implemented` rather than hand back a link labeled "signed" that never actually expires. Set this to `true` only if your configured backend genuinely signs its URLs. |
| `TRUEPPM_ALLOW_UNENCRYPTED_DB` | `false` | Operator opt-in to run production against a `DATABASE_URL` that has no `sslmode` parameter (e.g. when TLS to the database is enforced at the network layer). `prod` refuses to boot on such a URL unless this is `true`; when set, the boot logs a warning instead. |
| `CSRF_TRUSTED_ORIGINS` | _(empty)_ | Comma-separated origins (scheme included) trusted for cross-origin POST/CSRF. Required only for split-origin deploys where the web app and API are served from different hostnames, e.g. `https://app.example.com,https://api.example.com`. |
| `TRUEPPM_FRONTEND_BASE_URL` | _(empty)_ | Public origin the web app is served from, e.g. `https://trueppm.example.com`. Used to build absolute task deep-links in notification emails (e.g. `task.blocked`). Leave empty to omit the link — emails still carry the blocker type, age, and actor. No trailing slash, no path. The legacy bare `FRONTEND_BASE_URL` is still accepted as a fallback. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_SECURE` | `true` | Sets the `Secure` flag on the refresh-token cookie. The browser drops a `Secure` cookie over plain HTTP, so set `false` only on a non-HTTPS dev/preview host. The dev settings already default this to `false` for localhost. Legacy bare `AUTH_REFRESH_COOKIE_SECURE` still accepted. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_SAMESITE` | `Strict` | `SameSite` policy for the refresh cookie. `Strict` blocks the cookie on any cross-site request. **Split-origin deploys must relax this** to `Lax` or `None` so the refresh request carries the cookie; `None` additionally requires `Secure` (HTTPS). See [split-origin notes](#split-origin-deploys). Legacy bare `AUTH_REFRESH_COOKIE_SAMESITE` still accepted. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_NAME` | `trueppm_refresh` | Name of the refresh-token cookie. Override only to avoid a collision with another app on the same domain. Legacy bare `AUTH_REFRESH_COOKIE_NAME` still accepted. |
| `TRUEPPM_AUTH_REFRESH_COOKIE_PATH` | `/api/v1/auth/token/refresh/` | Path the refresh cookie is scoped to. Override only if you reverse-proxy the API under a non-default base path. Legacy bare `AUTH_REFRESH_COOKIE_PATH` still accepted. |
| `CSP_CONNECT_SRC` | `'self' wss:` | Space-separated `connect-src` sources for the Content-Security-Policy header — the origins the browser may open XHR / fetch / WebSocket connections to. **Split-origin deploys must add the API origin** (and its `wss://` origin) here, e.g. `'self' https://api.example.com wss://api.example.com`. See [split-origin notes](#split-origin-deploys). |
| `TRUEPPM_WEBHOOK_RETENTION_DAYS` | `7` | Days of webhook delivery records to keep before the nightly purge. See [Retention](/administration/retention/). |
| `TRUEPPM_EXPORT_RETENTION_DAYS` | `7` | Days of generated export artifacts to keep before purge. See [Retention](/administration/retention/). |
| `TRUEPPM_SYNC_BATCH_RETENTION_HOURS` | `24` | Hours of processed offline-sync upload batches to keep before purge. See [Retention](/administration/retention/). |
| `TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES` | `4` | Maximum offline-sync upload batches one user may have applying **at the same time**. Each accepted batch is a heavy transaction (row locks + a schedule recompute), so this bounds simultaneous heavy writes per user as defense-in-depth over the per-minute upload rate limit. A user exceeding the cap gets an HTTP 429 with a short `Retry-After` and retries once in-flight work drains. If the throttle store (Valkey/Redis) is unreachable the guard degrades to off — the rate limit remains the hard bound. |
| `TRUEPPM_SYNC_INFLIGHT_TTL_SECONDS` | `120` | Time-to-live (seconds) on the per-user in-flight sync-batch counter that backs `TRUEPPM_SYNC_MAX_CONCURRENT_BATCHES`. Guards against a slot leaking if a worker dies mid-apply: the counter is reclaimed once no further batch refreshes it within this window. Set comfortably above the longest legitimate batch-apply time so an in-progress upload is never counted out from under a live request. |
| `TRUEPPM_SYNC_BATCH_MAX_ROWS` | `500` | Maximum rows (created + updated + deleted combined) a single mobile sync **upload** batch may contain. The batch applies in one transaction, so this bounds how long that transaction — and its per-task row locks — can be held by a single request. A client with more pending rows splits them across multiple upload batches. |
| `TRUEPPM_SYNC_PULL_PAGE_SIZE` | `1000` | Default page size for the offline delta **pull** (`since=` cursor). Bounds a cold-start sync (`since=0`) to this many rows per response instead of materializing an entire project into one unbounded multi-MB payload; the client loops on the returned cursor for the rest. |
| `TRUEPPM_SYNC_PULL_MAX_PAGE_SIZE` | `5000` | Hard ceiling on a client-requested `page_size` for the sync pull. Clamps a caller-supplied page size so a single request can never re-open the unbounded-response cliff `TRUEPPM_SYNC_PULL_PAGE_SIZE` exists to close. |
| `RETENTION_PURGE_INFLIGHT_SECONDS` | `600` | Lock TTL (seconds) guarding against overlapping retention-purge runs. See [Retention](/administration/retention/). |
| `TRUEPPM_BEAT_STALE_SECONDS` | `120` | Age (seconds) after which the last Celery-beat heartbeat is considered stale by `/health/beat/`. See [Durability](/administration/durability/). |
| `TRUEPPM_EXTERNAL_SYNC_ON_OPEN_STALE_SECONDS` | `300` | Age (seconds) past which a connected personal external source (e.g. Jira, see [Connected Accounts](/features/connected-accounts/)) is considered stale enough that opening My Work enqueues a background refresh pull. Raise this on a rate-sensitive token; the pull never blocks the My Work response either way. |
| `TRUEPPM_INTEGRATION_ALLOWED_HOSTS` | _(empty)_ | Comma-separated allow-list of **self-hosted** integration hosts a user's [Connected Account](/features/connected-accounts/) credential may be sent to — GitHub Enterprise / GitLab CE for task links, and **self-hosted Jira Data Center / Server** for personal read-only sync. Atlassian Cloud (`*.atlassian.net`) and github.com / gitlab.com are always allowed and need no entry. This is a security gate: a personal access token is only ever put on the wire toward a host on this list, so a user cannot be tricked into exfiltrating their PAT to an arbitrary host (host is matched by name, e.g. `jira.example.com`). **The host must also be reachable from the TruePPM server over a public (non-private) IP** — the outbound-request SSRF guard independently blocks any host resolving to a private/internal address, so an internal-only Data Center instance is not yet supported. |
| `TRUEPPM_RECURRENCE_HORIZON_DAYS` | `14` | Look-ahead window (days) for spawning recurring-task occurrences. See [Recurring tasks](/features/recurring-tasks/). |
| `TIMETRACKING_TIMER_MAX_MINUTES` | `600` | Stale-timer ceiling (minutes) for the running work timer that feeds the [Timesheet](/features/timesheet/). A running timer past this many minutes is flagged `stale` on `GET /me/timer/`, and **stop** caps the logged duration at the ceiling rather than the raw elapsed time — so a timer left running over a weekend logs the ceiling, not thousands of minutes. |
| `TIMETRACKING_BACKDATE_DAYS` | `60` | Manual time-entry backdate window (days). A manual `entry_date` is rejected if it is in the future or older than this many days, so a contributor can fill in last week's hours but not rewrite arbitrary history. |
| `SIGNAL_CEILING_PROPOSAL_TTL_HOURS` | `72` | How long a team-ratification proposal to raise a signal's visibility ceiling stays open before it lazily expires unratified (the ceiling is left unchanged — silence is never consent for widening a team signal's exposure). Evaluated lazily on read/vote/propose; no Beat sweep is required. |
| `TRUEPPM_TELEMETRY_TEST_EXPORT_TIMEOUT_SECONDS` | `5` | Wall-clock bound (seconds) for the admin telemetry test-export probe: caps the one-off canary export and reachability check to the configured OTLP collector so a dead collector can never hang the request thread. |
| `TRUEPPM_WORKFLOW_BACKEND` | `trueppm_api.workflows.backends.default.DefaultWorkflowBackend` | Dotted path to the `WorkflowBackend` implementation for the durable-execution engine. The OSS default composes the transactional outbox with Celery. Enterprise editions register an alternate backend (e.g. Temporal) by overriding this; do not change it in an OSS deployment. The legacy bare `WORKFLOW_BACKEND` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_WORKFLOW_HISTORY_RETENTION_DAYS` | `30` | Days of `WorkflowHistoryEvent` records to keep before the nightly `workflows.purge_old_records` task purges them. Set the Django setting to `None` (or `0`) to disable history purging. The legacy bare `WORKFLOW_HISTORY_RETENTION_DAYS` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_WORKFLOW_DRAIN_BATCH_SIZE` | `200` | Maximum rows the workflow outbox/timer drains process per tick. Bounds the work per run so a large backlog (e.g. after a broker outage) cannot exceed the Celery task time limit — later ticks drain the remainder. The legacy bare `WORKFLOW_DRAIN_BATCH_SIZE` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_WORKFLOW_PURGE_BATCH_SIZE` | `500` | Rows deleted per statement by the nightly workflow retention purge. The purge deletes in bounded chunks rather than one unbounded statement, so the first run on a mature install cannot hold a long lock over a large slice of the history/outbox tables. The legacy bare `WORKFLOW_PURGE_BATCH_SIZE` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_IDEMPOTENCY_RETENTION_HOURS` | `24` | Hours to retain stored `Idempotency-Key` responses, purged hourly by the Celery beat task. After expiry, a retry with the same key re-runs the mutation. Set the Django setting to `None` to disable automatic purging. The legacy bare `IDEMPOTENCY_RETENTION_HOURS` is still read as a fallback when the prefixed var is unset. |
| `TRUEPPM_IDEMPOTENCY_MAX_BODY_BYTES` | `1048576` | Maximum stored response body size, in bytes (1 MiB default). Responses larger than this are not stored — the claim row is dropped so a retry re-runs the mutation. Single-object mutation responses effectively never approach this limit. The legacy bare `IDEMPOTENCY_MAX_BODY_BYTES` is still read as a fallback when the prefixed var is unset. |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_HOST_USER` / `EMAIL_TIMEOUT` / … | _(Django default)_ | SMTP settings for notification and invite email. **Every one of these binds directly from the container environment** — set them as plain env vars or Helm `env:` values, no settings override needed. See [Outbound email](/administration/email/) for the full variable list and how they relate to the in-app Email & SMTP page. |

## General API rate limiting

TruePPM applies a **general default rate limit** to every API endpoint that does
not declare its own throttle, so a self-hosted instance has baseline protection
against runaway clients and resource-starvation abuse. Two tunable rates control
it:

| Variable | Default | Applies to |
|----------|---------|------------|
| `TRUEPPM_THROTTLE_ANON_RATE` | `60/min` | Unauthenticated requests, bucketed per client IP |
| `TRUEPPM_THROTTLE_USER_RATE` | `1000/min` | Authenticated requests, bucketed per account |

Both use Django REST Framework's `<count>/<period>` syntax, where `period` is
`sec`, `min`, `hour`, or `day` (for example `120/min` or `5000/hour`).

A few behaviors are worth knowing:

- **The Kubernetes probe endpoints are exempt.** `/api/v1/health/` (liveness /
  readiness) and `/api/v1/edition/` (the shell's startup edition read) are never
  counted, so an orchestrator's tight probe loop cannot exhaust the shared limit
  and trigger spurious pod restarts.
- **Scoped endpoints replace, not stack.** Endpoints with their own stricter
  limit — login, token refresh, Monte Carlo, and the other scoped throttles —
  keep only that specific limit; the general default does not add to it.
- **Exceeding a limit returns `429 Too Many Requests`** with a standard
  `Retry-After` header telling the client how many seconds to wait.

The throttle count lives in the configured cache (Valkey/Redis in production),
so the limit is shared across all API replicas rather than per-process.

### Disabling rate limiting entirely

Rate limits *tune* how fast callers may go; the **`TRUEPPM_RATE_LIMIT_ENABLED`**
switch decides *whether any throttle applies at all*. It exists so a load test — or
a throwaway benchmarking instance — can measure raw throughput without the
per-account limit tripping. It is **not** for production use.

Turning it off deliberately takes **two** environment variables, in **every**
environment:

```bash
TRUEPPM_RATE_LIMIT_ENABLED=false
TRUEPPM_RATE_LIMIT_DISABLE_ACK=i-understand-this-disables-abuse-protection
```

- Setting `TRUEPPM_RATE_LIMIT_ENABLED=false` **alone does nothing.** Without the
  exact acknowledgment string the request is ignored, rate limiting stays on, and
  the server logs a `CRITICAL` line at startup. A stray flag can never silently
  remove protection — and it never crashes the app either; it fails toward the
  protected state.
- When both are set, **every** throttle is bypassed: the general anon/user limits,
  every scoped endpoint limit, and even the fail-closed offline-sync write-path
  limit. "Off" means off, with no hidden exceptions.
- It is **deploy-time operator config only** — there is no in-app toggle, so an
  authenticated user can never switch off this protection through the API. While it
  is off, workspace admins see a persistent red banner and a card under
  **Settings → System**, and the `trueppm.ratelimit.enabled` OpenTelemetry gauge
  reports `0`, so the state is impossible to miss and easy to alert on.

Never set these on a production-facing deployment. Leave `TRUEPPM_RATE_LIMIT_ENABLED`
at its default `true` to keep abuse protection on.

## Login brute-force protection

The login endpoint (`POST /api/v1/auth/token/`) is protected by **two stacked
throttles** — both must pass before credentials are checked, so an attacker is
bounded on two independent axes:

| Variable | Default | Buckets by | What it bounds |
|----------|---------|------------|----------------|
| _(fixed)_ `login` scope | `10/min` | Client IP | Password guessing from a single source address |
| `TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE` | `5/min` | Account (hashed username) | Guessing against a single account across **all** source IPs |

The per-account throttle exists because the IP throttle alone only caps guesses
_per source address_. A distributed credential-stuffing attack that rotates
through a botnet or proxy pool gets the full per-IP allowance from every fresh
IP, so the aggregate guess rate against one account is unbounded. The
account-keyed throttle closes that gap: once the per-account rate is exceeded,
further login attempts for that username return `429 Too Many Requests` no matter
how many IPs participate.

- **The username is hashed before it becomes a cache key** — the raw email or
  username is never written to the cache backend.
- **Both success and failure count** toward the per-account bucket, so a normal
  interactive user (well under 5 logins/minute) is never affected while an
  automated attack is stopped quickly. Tighten or loosen the rate with
  `TRUEPPM_THROTTLE_LOGIN_ACCOUNT_RATE` using the same `<count>/<period>` syntax
  as the general rate limits.

Every rejected login also emits a structured `auth.login_failed` audit event on
the `trueppm.auth` logger, carrying the **hashed** username and client IP (never
the raw credential). Ship this logger to your SIEM to alarm on credential-stuffing
bursts — a spike of failures against one `username_hash` from many `client_ip`
values is the distributed-attack signature.

## MCP read-surface rate limiting

The [MCP server](/features/mcp-server/) exposes a read-only view of the OSS API to
`mcp:read` API tokens so an AI agent can query schedules, forecasts, and Monte
Carlo results. Those token reads are rate-limited **per token** so an agent retry
loop — or a leaked read-only token — cannot burn arbitrary server compute. Two
throttles apply:

| Variable | Default | Buckets by | Applies to |
|----------|---------|------------|------------|
| `TRUEPPM_THROTTLE_MCP_READ_RATE` | `120/min` | API token | Every MCP-readable endpoint |
| `TRUEPPM_THROTTLE_MCP_READ_COMPUTE_RATE` | `12/min` | API token | The four compute-heavy tools only |

The four **compute-heavy** tools — what-if, latest Monte Carlo, forecast, and
sprint-forecast — each run a CPM + Monte Carlo recompute per call, so they stack
the tighter `mcp_read_compute` bucket **on top of** the baseline `mcp_read` one.
A token calling one of them is bounded by whichever limit it hits first.

A few behaviors are worth knowing:

- **Only token traffic is throttled.** Requests authenticated by a human session
  or JWT pass through untouched — they remain governed by the general
  `TRUEPPM_THROTTLE_USER_RATE` limit above — so tightening these rates never slows
  an interactive user browsing the same views.
- **Each token has its own bucket**, keyed on the token's id. Revoking and
  re-minting a token starts a fresh window, and two agents holding two tokens
  neither share nor starve one budget.
- **Exceeding a limit returns `429 Too Many Requests`** with a `Retry-After`
  header, the same as the other scoped throttles.

Both use Django REST Framework's `<count>/<period>` syntax. Widen them for a
trusted internal agent fleet, or tighten them under load.

### Disabling MCP access entirely

Rate limits bound how fast agents read; the **`TRUEPPM_MCP_ENABLED`** kill switch
decides *whether they can read at all*. Set it to `false` to deny every MCP token
read across the whole instance:

- Every request authenticated by an `mcp:read` token is refused with `403`, even
  though the token still exists and carries the scope — the check is **fail-closed**
  and lives at the single guard chokepoint every MCP-readable endpoint shares.
- **Human session/JWT traffic on the same endpoints is unaffected.** The switch
  gates only the API-token (agent) path, so interactive users and the web client
  keep working normally.
- Each denied read is still recorded in the [agent-action audit
  log](/administration/mcp-server/#agent-action-audit-log) as a `policy` refusal,
  so you retain a trail of what was attempted while access was off.

The default is `true` for backward compatibility. Flip it to `false` when you want
"no agent access on this instance, period" — for a locked-down or regulated
deployment, or as an incident-response lever — then back to `true` to restore it.

## MS Project import limit

[MS Project import](/features/msproject-import-export/) accepts `.mpp` and
`.xml` files. The upload is bounded on three axes, because file size alone does
not bound either the derived object count or the work converting a `.mpp` creates:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `MSPROJECT_MAX_UPLOAD_MB` | `50` | MB | Maximum size of a single MS Project import upload |
| `MSPROJECT_MAX_ROWS` | `20000` | tasks | Maximum tasks (also applied to resources and dependency links) a single import may contain |
| `MPXJ_MAX_OUTPUT_MB` | `512` | MB | Ceiling on the XML MPXJ streams to stdout while converting a `.mpp` to MSPDI XML |
| `MPXJ_MAX_HEAP_MB` | `512` | MB | JVM max-heap (`-Xmx`) for the MPXJ conversion subprocess |

This cap was raised from a previously hardcoded 10 MB. An import is read fully
into memory and stored base64-encoded in a single database row (about +33%), so
a 50 MB upload already costs roughly 67 MB of memory and row size — keep the
limit close to the practical MS Project file ceiling rather than maximizing it.

**The byte cap alone does not bound the object graph a request can materialize.**
A 50 MB MSPDI XML file can encode roughly a million tasks, and the importer builds
one `Task` object per row, computes the WBS over all of them, then bulk-creates the
lot — a worker-memory / transaction-time denial-of-service that the byte ceiling
alone does not stop. `MSPROJECT_MAX_ROWS` rejects the import outright once the task
count (or resource or dependency-link count) exceeds it, rather than partially
processing an oversized file. 20,000 tasks is far above any realistic
hand-authored schedule.

**Converting a `.mpp` is a bigger risk than parsing MSPDI XML.** MS Project's
binary `.mpp` format is converted to XML by an external MPXJ (Java) subprocess. A
decompression-bomb `.mpp`, still comfortably inside the 50 MB upload cap, can
expand to multi-gigabyte XML — buffering that unbounded would OOM the worker.
`MPXJ_MAX_OUTPUT_MB` streams the subprocess's stdout and aborts past this many
bytes; `MPXJ_MAX_HEAP_MB` is a second line of defense that bounds the JVM's own
heap, so even a bomb the byte ceiling hasn't yet caught dies with a JVM
`OutOfMemoryError` (a clean non-zero exit) rather than driving the host into swap.

The MS Project and Jira import paths (below) share one more bulk-write knob:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `IMPORT_BULK_BATCH_SIZE` | `500` | rows | `batch_size` for the shared importer's `bulk_create()` calls |

Without a `batch_size`, Django would emit one giant multi-row `INSERT` that pins
the whole task/dependency set in a single statement (and can exceed PostgreSQL's
parameter limit); chunking bounds the per-statement memory and parameter count.

:::caution[Do not configure above the hard ceiling]
`MSPROJECT_MAX_UPLOAD_MB` must stay **at or below 100 MB**. The global Django
`DATA_UPLOAD_MAX_MEMORY_SIZE` (100 MB) and the operator-configured nginx
`client_max_body_size` are the hard edge cap — the shipped reference nginx
templates set `client_max_body_size 20M`, so the 50 MB import default is
unreachable until you raise it to at least your `MSPROJECT_MAX_UPLOAD_MB`. Set
both, and keep `MSPROJECT_MAX_UPLOAD_MB` under them. Setting it higher has no
effect: the larger request is rejected at the edge before the importer ever
sees it.
:::

```bash
# Allow MS Project imports up to 80 MB. Must stay <= 100 MB
# (DATA_UPLOAD_MAX_MEMORY_SIZE / nginx client_max_body_size).
MSPROJECT_MAX_UPLOAD_MB=80
```

Imported files are stored base64-encoded in an `ImportRequest` row only until
the import is processed, then purged on the schedule set by
`TRUEPPM_IMPORT_RETENTION_DAYS` (default 7 days). See
[Outbox & Record Retention](/administration/retention/) to tune that window.

## Jira import limit

[Jira import](/features/jira-import/) accepts a **Jira Server / Data Center XML
export** (`.xml` only). Like MS Project import, it is bounded on both size and
row count:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `JIRA_IMPORT_MAX_UPLOAD_MB` | `25` | MB | Maximum size of a single Jira XML import upload |
| `JIRA_IMPORT_MAX_ROWS` | `20000` | issues | Maximum issues a single Jira XML import may contain |

The size default is lower than the MS Project cap because a Jira issue export is
typically small and, like the MS Project importer, an upload is read fully into
memory and stored base64-encoded in a single database row (about +33%) until the
import is processed. Files larger than the cap are rejected with HTTP 400 before
any parsing happens.

`JIRA_IMPORT_MAX_ROWS` exists for the same reason as `MSPROJECT_MAX_ROWS` above:
the byte cap does not bound the derived task count, and every issue becomes a
`Task` object built and bulk-created through the same shared importer
(`msproject.importer.import_project`). An import past the row cap is rejected
outright.

```bash
# Allow Jira XML imports up to 40 MB. Same edge caps apply as MS Project imports:
# keep it at or below DATA_UPLOAD_MAX_MEMORY_SIZE (100 MB) and your nginx
# client_max_body_size, or the request is rejected upstream before the importer.
JIRA_IMPORT_MAX_UPLOAD_MB=40
```

The Jira XML parse goes through `defusedxml` (no entity expansion, no
external-entity resolution), so an XXE / billion-laughs payload is rejected at
parse time — the same unconditional protection the MS Project importer has.

## CSV / Excel import limits

[CSV / Excel import](/features/csv-import-export/) is bounded on three axes, because
size alone does not bound the work an upload creates:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `CSV_IMPORT_MAX_UPLOAD_MB` | `10` | MB | Maximum size of a single `.csv` / `.xlsx` upload |
| `CSV_IMPORT_MAX_ROWS` | `5000` | rows | Maximum data rows parsed from one file |
| `CSV_IMPORT_MAX_UNCOMPRESSED_MB` | `100` | MB | Maximum *uncompressed* size an `.xlsx` may declare |

The size cap is much lower than the MS Project one on purpose: a spreadsheet
migration is a hand-maintained sheet, not a generated plan, and 10 MB is already
far past what a real one weighs. Like the other importers, an upload is read
fully into memory and stored base64-encoded in a single database row (about +33%)
until it is processed.

The **row cap is a separate limit for a reason**: a 10 MB CSV can encode well
over a million short rows, and the parser builds one task object per row before
anything is written. Rows past the cap are **reported back to the operator as
skipped** rather than silently dropped, so an import is never quietly partial.

```bash
# Allow larger sheets. Keep the upload cap at or below
# DATA_UPLOAD_MAX_MEMORY_SIZE (100 MB) and your nginx client_max_body_size,
# or the request is rejected upstream before the importer sees it.
CSV_IMPORT_MAX_UPLOAD_MB=25
CSV_IMPORT_MAX_ROWS=20000
```

### Why `.xlsx` has a third limit

An `.xlsx` file is a **zip archive of XML**. TruePPM parses it with `openpyxl`,
which automatically enables `defusedxml` hardening (no entity expansion, no
external-entity resolution) because `defusedxml` is installed — so XXE and
billion-laughs payloads are rejected at parse time.

That protection does **not** bound *decompression*. A 1 MB upload can inflate to
gigabytes and exhaust worker memory while sitting comfortably inside the byte
cap. Before parsing, TruePPM sums the sizes declared in the zip's central
directory and rejects anything above `CSV_IMPORT_MAX_UNCOMPRESSED_MB`. The check
reads no member data and runs before any XML parser is invoked.

## Seed import limit

A [JSON program seed](/administration/management-commands/#sample-data--json-seed)
(`POST /programs/import/`, ADR-0109) has its own, much smaller size cap:

| Variable | Default | Unit | What it bounds |
|----------|---------|------|----------------|
| `SEED_MAX_UPLOAD_MB` | `5` | MB | Maximum size of a single JSON program seed upload |

Seeds are bounded relative to the other importers because they are a different
kind of payload: the largest bundled sample seed is a few hundred KB, so 5 MB is
generous headroom while still bounding the memory a single authenticated import
request can consume. See [general API rate limiting](#general-api-rate-limiting)
above for the separate `TRUEPPM_THROTTLE_SEED_IMPORT_RATE` /
`TRUEPPM_THROTTLE_SEED_VALIDATE_RATE` throttles that bound *how often* a caller
may hit this endpoint, independent of payload size.

## Monte Carlo simulation caps

The Community (OSS) tier bounds [Monte Carlo risk analysis](/features/monte-carlo/)
with three caps. Like the email settings above, these are **Django settings
constants, not environment variables** — override them in a Django settings
module; setting bare env vars of the same name has no effect. The Enterprise
edition raises or removes them.

| Setting | Default (OSS) | What it bounds |
|---------|---------------|----------------|
| `MC_SIMULATION_CAP` | `1000` | Maximum simulation runs (iterations) per request. The Monte Carlo run endpoint rejects an `n_simulations` above this. |
| `MC_TASK_CAP` | `5000` | Largest project — by task count — Monte Carlo will run on. The vectorized NumPy path handles 5000 tasks × 1000 runs in a few seconds; a larger project is refused rather than run unbounded. |
| `MC_HISTORY_CAP` | `100` | Forecast-history rows kept per project. The nightly purge trims each project to its newest `MC_HISTORY_CAP` `MonteCarloRun` rows. |

:::note[Added in 0.3]
`MC_HISTORY_CAP` and the persisted forecast history it bounds (the `MonteCarloRun`
rows) were added in 0.3. `MC_SIMULATION_CAP` and `MC_TASK_CAP` have applied since the
Monte Carlo engine landed in 0.1.
:::

Set any cap to `None` for unlimited — the Enterprise default, where unbounded
forecast history plus cross-program rollup is part of the portfolio tier.
Operators on constrained hardware can lower `MC_TASK_CAP` to keep simulations
cheap.

```python
# settings override — raise the task ceiling for a large-project deployment.
MC_TASK_CAP = 10_000
```

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

Turn it on only when TruePPM itself terminates TLS or otherwise receives the original
request scheme reliably — for example, a deployment that exposes the app directly over
HTTPS with no intervening proxy, or a proxy configured to forward `X-Forwarded-Proto`
correctly. The Kubernetes health-probe paths (`/api/v1/health/`, `/api/v1/readyz`,
`/api/v1/edition/`) are always exempt from the redirect regardless of this setting, so
turning it on never breaks the probes even if they are reached over plain HTTP.

This setting has no effect outside `trueppm_api.settings.prod` — the `dev` settings
module never enforces an HTTPS redirect.

## Split-origin deploys

A standard deploy serves the web app from the **same origin** as the API
(e.g. nginx routes `/` to the SPA and `/api` to Django on one hostname). The
secure defaults assume this and need no extra configuration.

A **split-origin** deploy serves the SPA from a different origin than the API —
for example `https://app.example.com` (SPA) and `https://api.example.com` (API).
Two security defaults are origin-aware and must be relaxed for the browser to
talk to the API:

| Setting | Why it must change | Set to |
|---------|--------------------|--------|
| `AUTH_REFRESH_COOKIE_SAMESITE` | The refresh cookie is `SameSite=Strict`, so the browser will not send it on the cross-origin refresh request, and sessions silently fail to renew. | `Lax` (or `None` if the SPA and API are on unrelated sites — `None` requires HTTPS, which the `Secure` flag already enforces). |
| `CSP_CONNECT_SRC` | The Content-Security-Policy `connect-src` defaults to `'self' wss:`. With the SPA on a different origin, the browser blocks XHR / WebSocket connections to the API origin. | `'self' https://api.example.com wss://api.example.com` — add the API origin and its `wss://` origin. |

Also set `CSRF_TRUSTED_ORIGINS` (above) for any split-origin deploy.

## In-product feedback ("Report a bug")

TruePPM shows a **Report a bug** entry in the account menu and the command
palette. Choosing it opens a dialog containing the exact text that would be
submitted; the user can edit it, then continue to your tracker in a new tab.

**It is a link, not a beacon.** TruePPM sends nothing on this path. Rendering the
control makes no network request, opening the dialog makes no network request,
and there is no background telemetry attached to it. The context travels only as
query parameters in a URL the user can read before submitting, and the link
carries `rel="noopener noreferrer"` so the tracker is not even handed the page
URL the user came from.

**What is included** — the minimum that makes a report actionable:

- the TruePPM version, edition, and build SHA;
- the *screen* the user was on, as a route shape (`/projects/:id/board`);
- the browser's user-agent string.

**What is not included** — and cannot be, by construction:

- any workspace, program, project, task, or user identifier;
- the user's name or email address;
- any query string, search term, or filter value;
- any schedule, comment, or attachment content.

Identifiers are stripped from the route before the body is assembled: the query
string and fragment are dropped entirely, and any path segment that looks like an
identifier is replaced with `:id`.

Two settings, under **Settings → System → Feedback** (workspace admin only):

| Setting | Default | Effect |
|---|---|---|
| **Report a bug control** | Shown | Hides the entry entirely — from the account menu *and* the command palette — when set to Hidden. A locked-down install does not advertise a route it has closed. |
| **Tracker URL** | *(blank)* | Where the control points. Blank means the public TruePPM issue tracker. Set it to your own tracker or helpdesk to keep reports internal. |

The default tracker URL is **not stored** in the database. A blank value means
"use the built-in default", so an operator who never touched the setting follows
the default wherever it moves in a future release, rather than being pinned to
whatever it was at install time.

The prefilled title and description are passed as `issue[title]` and
`issue[description]` query parameters (GitLab's new-issue form). A tracker that
does not understand them ignores them and simply opens its own blank form, so
repointing at an arbitrary helpdesk URL still works.

:::note[Ships in 0.4]
The in-product feedback control and both settings above ship in 0.4.
:::

## First user setup

No manual steps are needed: the api container runs migrations and the `create_admin` bootstrap automatically on startup. Retrieve the generated admin password as described in [Admin password setup](/administration/admin-password/).

The admin user can then authenticate via the API and create projects. When a user creates a project, they automatically become its Owner.

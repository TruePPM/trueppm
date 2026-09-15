---
title: "Rate limits and import caps"
description: "API and login rate limiting, the MCP read-surface limits, and the size caps on MS Project, Jira, CSV/Excel and seed imports and on Monte Carlo runs."
documentedFor: "0.4"
---

## Rate limiting and access

| Variable | Default | What it does |
|----------|---------|--------------|
| `TRUEPPM_THROTTLE_GIT_WEBHOOK_IP_RATE` | `600/min` | Per-IP limit for inbound Git webhooks, in DRF `<count>/<period>` form. Deliberately high: a monorepo push fans out to many hook deliveries from one address, and throttling them drops commit links silently. Lower it only if webhooks are a load problem. |
| `TRUEPPM_FAILED_TASK_BULK_ACTION_MAX` | `500` | Maximum failed background tasks one bulk retry/discard may act on. Bounds a single admin click's blast radius on the queue. |
| `TRUEPPM_PASSWORD_RESET_TIMEOUT` | `1800` | Seconds a password-reset link stays valid (30 minutes). Django's own default is 3 days; this is deliberately much shorter, since the link is a bearer credential sitting in a mailbox. Raise it only if your users routinely hit expiry. |
| `TRUEPPM_RATE_LIMIT_DISABLE_ACK` | _(empty)_ | Acknowledgment sentinel required **in addition to** `TRUEPPM_RATE_LIMIT_ENABLED=false` to actually turn throttling off. Without both, limits stay on and the attempt is logged at CRITICAL — a stray env var cannot silently open a DoS path. See [disabling rate limiting entirely](#disabling-rate-limiting-entirely). |
| `TRUEPPM_WS_LEGACY_TOKEN_AUTH_ENABLED` | `false` | Re-enables the legacy WebSocket token-in-query-string authentication. **Leave off.** A query string is logged by proxies, load balancers, and browser history, so the token leaks into places a header never reaches. Only for a client too old to use the ticket flow, and only while you upgrade it. |

## General API rate limiting

TruePPM applies a **general default rate limit** to every API endpoint that does
not declare its own throttle, so a self-hosted instance has baseline protection
against runaway clients and resource-starvation abuse. Two tunable rates control
it:

| Variable | Default | Applies to |
|----------|---------|------------|
| `TRUEPPM_THROTTLE_ANON_RATE` | `60/min` | Unauthenticated requests, bucketed per client IP |
| `TRUEPPM_THROTTLE_USER_RATE` | `1000/min` | Authenticated requests, bucketed per account |
| `TRUEPPM_THROTTLE_READYZ_RATE` | `2000/min` | The readiness probe (`/api/v1/readyz`) only, bucketed per client IP — see below |

Both use Django REST Framework's `<count>/<period>` syntax, where `period` is
`sec`, `min`, `hour`, or `day` (for example `120/min` or `5000/hour`).

A few behaviors are worth knowing:

- **`/api/v1/health/` (liveness) and `/api/v1/edition/` (the shell's startup
  edition read) are exempt.** They are never counted, so an orchestrator's
  tight liveness loop cannot exhaust the shared limit and trigger spurious pod
  restarts. **`/api/v1/readyz` (readiness) is not exempt** — unlike the other
  two it does a real database and cache round-trip per call, so it gets its
  own dedicated, generous scope (`TRUEPPM_THROTTLE_READYZ_RATE`, default
  `2000/min`) instead of a full exemption, bounding an unauthenticated caller
  who reaches the pod IP directly (the probe path bypasses the Ingress) without
  risking a legitimate, tight readiness loop.
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
  gates only the **agent-token (`mcp:read`)** path, so interactive users and the
  web client keep working normally. A member's own full-access (`legacy:full`)
  [personal access token](/features/personal-access-tokens/) is unaffected too —
  it is that person's credential rather than an agent's, and it reaches the
  general API on the same terms as their browser session regardless of this
  switch.
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

**`TRUEPPM_SCHEDULE_TASK_CEILING` (default `1000`) is not a fourth bound here** — the three
limits above reject or truncate; this one never does. It is the Schedule's own
[tested-comfortable task count](/administration/sizing/#tested-envelope), and the import
preview compares your existing task count plus this file's tasks against it purely to
warn, not to gate the commit. Raising `CSV_IMPORT_MAX_ROWS` does not raise this — they
answer different questions ("how big a file will the parser accept" vs. "how big a
project stays comfortable to open"), and a file well under the row cap can still carry a
project past it.

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
| `SEED_MAX_UPLOAD_MB` | `5` | MB | Maximum size of a single JSON program seed payload |
| `SEED_IMPORT_MAX_CONCURRENT_JOBS` | `3` | jobs | Seed imports one account may have queued or running at once. `0` disables the bound. |

Seeds are bounded relative to the other importers because they are a different
kind of payload: the largest bundled sample seed is a few hundred KB, so 5 MB is
generous headroom while still bounding the memory a single authenticated import
request can consume. The ceiling is enforced on **both** request shapes — a
`multipart/form-data` upload and a raw JSON body — so it cannot be sidestepped by
posting the document as the body. It is measured against the bytes that actually
arrived rather than a declared `Content-Length`, which a chunked request may omit. See
[general API rate limiting](#general-api-rate-limiting)
above for the separate `TRUEPPM_THROTTLE_SEED_IMPORT_RATE` /
`TRUEPPM_THROTTLE_SEED_VALIDATE_RATE` throttles that bound *how often* a caller
may hit this endpoint, independent of payload size.

`SEED_IMPORT_MAX_CONCURRENT_JOBS` bounds a third, independent thing: how many
imports one account may have **outstanding**. The rebuild runs on a worker, so
the rate throttle alone lets a caller keep adding full subtree builds to the
queue at its permitted rate without ever waiting for one to finish. Over the cap
the endpoint answers `429` with `code: seed_import_concurrency_limit`, which —
unlike a throttle `429` — is cleared by an outstanding import finishing rather
than by waiting out a window. Raise it if your operators legitimately run
imports in parallel; set it to `0` to leave the rate throttle as the only limit.

The seed document itself is bounded field by field as well as in total: prose
fields (`description`) accept up to 100,000 characters and narrative fields
(`notes`, `goal`, `trigger`, `contingency`) up to 10,000, and the top-level
`accounts`, `calendars`, `resources` and `risks` collections carry item ceilings.
These are schema-level and not configurable; a document that exceeds one is
rejected with a `400` naming the field.

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

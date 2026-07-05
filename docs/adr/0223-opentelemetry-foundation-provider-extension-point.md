# ADR-0223: OpenTelemetry Foundation — Provider Extension Point & `trueppm.*` Naming Convention

## Status
Accepted

## Context

TruePPM ships as self-hosted software. Operators running a single instance need
to answer ordinary production questions — "is the API healthy?", "why is this
request slow?", "which endpoint is burning worker time?" — using the observability
stack they already run (Grafana Tempo, Jaeger, Honeycomb, an OTLP collector, a
managed APM). Today the OSS Django API emits **no distributed traces or metrics**;
`grep -ri "opentelemetry" packages/api/src/` returns nothing. Epic #707 closes that
gap with OpenTelemetry (OTel), the vendor-neutral CNCF standard, exported over OTLP.

This ADR is the **foundation** (issue #708) for that epic. It does **not**
instrument business logic — no auto-instrumented views, ORM, or Celery spans yet
(that is Phase 1/2, #709/#710). It establishes exactly three things:

1. A **bootstrap** that builds an OTel `TracerProvider` / `MeterProvider` at app
   startup, wires the OTLP exporter, and sets them as the process-global providers.
2. A **stable extension point** — an importable hook — that the proprietary
   `trueppm-enterprise` edition registers against to attach its own span
   processors / exporters / instrumentation, **without importing OSS internals or
   OSS importing enterprise** (boundary rule #3).
3. A **`trueppm.*` span-attribute and resource-attribute naming convention** so OSS
   Phase 1/2 instrumentation and the enterprise edition emit attributes under one
   agreed, collision-free namespace.

**Opt-in, no default endpoint.** Telemetry is a deliberate operator choice, not a
default that silently opens an egress connection. With no OTLP endpoint configured
the provider is a **strict no-op**: no SDK objects, no background export threads,
zero per-request overhead. This mirrors the opt-in posture of SMTP (ADR-0213) and
the backup CronJob — configure it to turn it on, and it is off until you do.

**P3M layer**: platform / Operations. Instance instrumentation is a core
self-hosting concern, not portfolio governance. The `enterprise-check` gate
classified the foundation **OSS**: the same pattern as ADR-0029 (frontend slot
registry), ADR-0049 (integration provider registry), and ADR-0112 (AI extension
hooks) — OSS defines the extension point, enterprise registers against it. The
Enterprise line is org-wide **telemetry-pipeline governance** (enforced/mandated
endpoints, per-tenant telemetry isolation, compliance-grade retention/redaction of
spans), which sits on top of this foundation and is filed in `trueppm-enterprise`.

## Decision

### 1. Configuration surface — standard `OTEL_*` env vars, gated by endpoint presence

Telemetry is enabled **iff** an OTLP endpoint is configured **and** the master
switch is on. There is no default endpoint, so the out-of-the-box state is off.

We adopt the **well-known upstream `OTEL_*` environment-variable names** rather than
inventing `TRUEPPM_`-prefixed synonyms, because (a) operators already running OTel
know them, (b) the OTLP exporter documents them, and (c) it keeps our config surface
aligned with every other OTel-emitting service in their cluster. We add a small
number of `TRUEPPM_OTEL_*` switches only for behaviour the standard vars do not
express (a master kill switch, and independent traces/metrics toggles). Values are
read into Django settings in `settings/base.py` via `django-environ`, giving **one
source of truth** — the bootstrap passes them explicitly to the exporter rather than
relying on the SDK's own ambient env reading.

| Setting (env var) | Type | Default | Meaning |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | str | `""` | **The gate.** Empty → no-op. Collector URL, e.g. `http://otel-collector:4317`. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | str | `grpc` | `grpc` or `http/protobuf`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | str | `""` | Passed through to the exporter (e.g. `authorization=Bearer …` for a SaaS backend). |
| `OTEL_SERVICE_NAME` | str | `trueppm-api` | Resource `service.name`. |
| `TRUEPPM_OTEL_ENABLED` | bool | `true` | Master kill switch, AND-ed with endpoint presence. Set `false` to force-disable while leaving the endpoint set. |
| `TRUEPPM_OTEL_TRACES_ENABLED` | bool | `true` | Export traces (when telemetry is enabled). |
| `TRUEPPM_OTEL_METRICS_ENABLED` | bool | `true` | Export metrics (when telemetry is enabled). |

Effective enablement: `TRUEPPM_OTEL_ENABLED and bool(OTEL_EXPORTER_OTLP_ENDPOINT)`.

Helm exposes these under a structured `observability.otlp.*` block that renders into
the standard env vars for **both** the API and the Celery worker/beat deployments
(via a new `trueppm.observabilityEnv` helper, appended alongside `trueppm.envVars`).

### 2. "No-op when unconfigured" means: install no SDK provider at all

When telemetry is disabled the bootstrap **does not call**
`trace.set_tracer_provider()` / `metrics.set_meter_provider()`. The OTel **API's**
built-in default (a no-op `ProxyTracerProvider` / no-op meter) stays in place, so
any future `trace.get_tracer(__name__).start_as_current_span(...)` call returns a
non-recording span at essentially zero cost, and **no** `BatchSpanProcessor` thread
or `PeriodicExportingMetricReader` timer is ever created. This is a stricter no-op
than "build a provider with no exporter": there is no SDK object graph, no export
loop, and nothing to shut down.

When telemetry is enabled the bootstrap builds a `Resource`, a `TracerProvider`
(with a `BatchSpanProcessor` wrapping the OTLP span exporter) and/or a
`MeterProvider` (with a `PeriodicExportingMetricReader` wrapping the OTLP metric
exporter), sets them global, and invokes the extension hooks (§4).

### 3. Resource & span attribute naming convention — the `trueppm.*` namespace

**Resource attributes** (identify the emitting process, set once at build time):

| Key | Source | Notes |
|---|---|---|
| `service.name` | `OTEL_SERVICE_NAME` (default `trueppm-api`) | OTel standard. |
| `service.version` | `importlib.metadata.version("trueppm-api")` | OTel standard; falls back to `"unknown"`. |
| `service.namespace` | constant `trueppm` | OTel standard. |
| `trueppm.edition` | `TRUEPPM_EDITION` (`community` \| `enterprise`) | Lets a backend split OSS vs enterprise traffic. |

**Span attributes** use the reserved `trueppm.*` namespace. This ADR fixes the
namespace and the ownership split; Phase 1/2 and enterprise populate the keys. The
canonical key constants live in `observability/otel/attributes.py` so every emitter
imports the same strings instead of hand-typing them.

- **OSS-owned** sub-namespaces (Phase 1/2 instrumentation): `trueppm.project.*`,
  `trueppm.program.*`, `trueppm.task.*`, `trueppm.board.*`, `trueppm.user.*`,
  `trueppm.schedule.*`, `trueppm.request.*`, `trueppm.edition`.
- **Enterprise-reserved** sub-namespaces (OSS will never emit these, so no
  collision): `trueppm.portfolio.*`, `trueppm.governance.*`, `trueppm.tenant.*`.

Rule: an attribute that is not part of a business fact TruePPM owns must **not** be
placed under `trueppm.*`; use the appropriate OTel semantic-convention key
(`http.*`, `db.*`, `messaging.*`) instead.

### 4. The extension point — an order-independent provider hook

Enterprise attaches to the telemetry pipeline through one importable OSS module,
`trueppm_api.apps.observability.otel` (re-exported for a stable path):

```python
from trueppm_api.apps.observability.otel import (
    register_provider_hook,   # register a callback
    OTelBootstrapContext,     # frozen dataclass passed to the callback
    get_tracer,               # thin, stable accessor over the OTel API
)
```

- `register_provider_hook(hook: Callable[[OTelBootstrapContext], None]) -> None`
  registers a callback. Enterprise calls it from its own `AppConfig.ready()` and,
  in the callback, does `ctx.tracer_provider.add_span_processor(BatchSpanProcessor(its_own_exporter))`,
  adds a metric reader, or wires additional instrumentation. Adding a span processor
  after construction is supported by the SDK, so a hook can extend a
  fully-built provider.

- `OTelBootstrapContext` is a **frozen dataclass** carrying an additive
  `schema_version: int` (the ADR-0112 versioning convention), `enabled: bool`,
  `edition: str`, the immutable `resource`, and the `tracer_provider` /
  `meter_provider` (each `None` when that signal is disabled). Frozen + versioned =
  a stable cross-repo contract; new fields are added, never renamed or removed.

- **Order-independence** (the key design point): AppConfig `ready()` fires in
  `INSTALLED_APPS` order and enterprise apps are appended *after* OSS apps, so an
  enterprise hook would otherwise register *after* the OSS bootstrap already ran.
  We make registration order-independent: the bootstrap invokes every hook already
  registered **and stores the context**; `register_provider_hook` invokes a
  late-arriving hook **immediately** against the stored context. Both orderings —
  enterprise-before-OSS and OSS-before-enterprise — deliver the context exactly once.

- Hooks run inside a `try/except` that logs and swallows: a broken enterprise hook
  must never crash API startup.

- `get_tracer(name)` / `get_meter(name)` are thin wrappers over the standard OTel
  API (`opentelemetry.trace.get_tracer`), given so OSS Phase 1/2 code and enterprise
  obtain instruments through one documented OSS surface. They work identically in
  the enabled and no-op states.

The dependency direction is one-way and unchanged: **enterprise imports this OSS
module; OSS never imports `trueppm_enterprise`.** `grep -r "trueppm_enterprise"
packages/` stays at zero.

### 5. Bootstrap location — `ObservabilityConfig.ready()`

The existing `trueppm_api.apps.observability` app (currently Beat-liveness +
retention, ADR-0081/0173) gains a `ready()` that calls `otel.bootstrap()`.
`bootstrap()` is **idempotent**: if it has already installed an SDK provider it
returns early, so the double-import that happens under the test runner and the
autoreloader cannot build two export pipelines. No changes to `asgi.py` / `wsgi.py`
/ `celery.py` are required — the app registry fires `ready()` after `django.setup()`
for every entrypoint (web, ASGI, and Celery worker/beat alike).

### 6. Dependencies

Add to `packages/api/pyproject.toml` (both Apache-2.0, verified against PyPI
`license_expression`):

- `opentelemetry-sdk>=1.43,<2` — the SDK (providers, processors, resource).
- `opentelemetry-exporter-otlp>=1.43,<2` — the OTLP exporter meta-package (pulls the
  gRPC and HTTP exporters). Transitive: `opentelemetry-api`,
  `opentelemetry-semantic-conventions`, `opentelemetry-proto`,
  `googleapis-common-protos`, `grpcio`, `protobuf`, `requests` — all Apache-2.0 or
  permissive (BSD/MIT), none copyleft, so `license:check:py` (which fails only on
  GPLv2/GPLv3/AGPLv3) stays green.

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| **A: Opt-in bootstrap in `observability.ready()`, standard `OTEL_*` env, order-independent hook (chosen)** | Zero overhead when off; operators reuse known env vars; enterprise attaches without OSS coupling; no entrypoint edits | Hook re-invoke-on-late-register logic needs a stored context |
| B: Bootstrap in `asgi.py`/`wsgi.py`/`celery.py` | Explicit, obvious location | Three copies to keep in sync; misses `manage.py`/management commands; still needs an app hook for enterprise |
| C: Always build an SDK provider, just omit the exporter when unconfigured | One code path | A `BatchSpanProcessor` thread and provider object exist even when off — not a true no-op; violates the issue's "no-op when unset" |
| D: `TRUEPPM_OTEL_*`-only config (no standard `OTEL_*`) | One naming style | Operators must relearn our synonyms; the exporter's own docs reference `OTEL_*`; friction against every other OTel service in the cluster |
| E: Django signal (`Signal`) as the extension point | Familiar Django idiom | Signals give no clean typed contract or ordering guarantee; a frozen-dataclass hook is a firmer cross-repo contract (per ADR-0112) |

## Consequences

**Easier:**
- Operators point TruePPM at their existing OTLP collector with one env var / Helm
  value and get traces + metrics — no fork, no patch.
- Phase 1/2 (#709/#710) instrument views/ORM/Celery against a provider and a naming
  convention that already exist and are stable.
- Enterprise ships telemetry-pipeline governance by importing one OSS module — no
  OSS changes, no boundary violation.

**Harder:**
- The `trueppm.*` namespace and `OTelBootstrapContext` are now a public contract:
  changes are additive-only (new attribute keys, new dataclass fields), and removing
  or renaming either is a breaking change for enterprise.
- `opentelemetry-exporter-otlp` pulls `grpcio` (a compiled wheel), enlarging the API
  image and dependency surface even for operators who never enable telemetry. Accepted
  for this foundation; a future switch to the lighter HTTP-only exporter
  (`opentelemetry-exporter-otlp-proto-http`, which reuses the already-present
  `requests`) can be evaluated if image size becomes a concern (#708 follow-up).

**Risks:**
- A misconfigured endpoint could make the exporter retry in the background. Mitigated
  because the OTLP `BatchSpanProcessor` is fire-and-forget and bounded — export
  failures are logged and dropped by the SDK and **never** propagate into a request
  path. This is asserted by test.
- A buggy enterprise hook could raise at startup; mitigated by the `try/except`
  around hook invocation.

## Implementation Notes

- **P3M layer:** Platform / Operations.
- **Affected packages:** api (settings, observability app, new `otel` module,
  pyproject), helm (values + env helper), docs (admin page + this ADR).
- **Migration required:** no — no models change.
- **API changes:** no — no new REST/WS endpoint, viewset, or serializer.
- **OSS or Enterprise:** OSS. Defines the extension point; enterprise registers
  against it. `grep -r "trueppm_enterprise" packages/` stays zero.

### Durable Execution
1. **Broker-down behaviour:** N/A. Telemetry export is not Celery/broker work — the
   OTel `BatchSpanProcessor` / `PeriodicExportingMetricReader` own their background
   threads and export directly over OTLP. No DB write, no `.delay()`, no outbox.
2. **Drain task:** N/A. No Celery task is introduced; the SDK's own batch loop is the
   only asynchronous mechanism.
3. **Orphan window:** N/A. No outbox rows or `transaction.on_commit()` dispatch.
4. **Service layer:** `trueppm_api.apps.observability.otel.bootstrap()` is the single
   startup entry; `register_provider_hook()` / `get_tracer()` / `get_meter()` are the
   public functions. No DB service layer is involved.
5. **API response on best-effort dispatch:** N/A. No API endpoint; nothing is
   dispatched in a request path.
6. **Outbox cleanup:** N/A. No outbox rows are produced.
7. **Idempotency:** `bootstrap()` is guarded — if it has already installed an SDK
   `TracerProvider`/`MeterProvider` (or already ran), it returns without building a
   second export pipeline, so double-import under the test runner or autoreloader is
   safe. Hook invocation is exactly-once per hook via the stored context.
8. **Dead-letter / failure handling:** Export failures are handled inside the OTel SDK
   (bounded batch queue; on overflow or exporter error the batch is logged and
   dropped). A telemetry failure must never fail a request — this is the explicit
   design contract and is covered by test. A raising enterprise hook is caught,
   logged, and swallowed so startup proceeds.

## Tracking
Issue #708 (foundation). Epic #707. Blocks Phase 1 (#709) and Phase 2 (#710).

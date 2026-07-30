---
name: devops
model: sonnet
description: >
  Infrastructure, deployment, CI/CD, and Kubernetes operations for TruePPM. Use when
  working on Helm charts, Docker configuration, GitHub Actions / GitLab CI pipelines,
  monitoring setup, or database operations. Targets Kubernetes (RKE2/Rancher, k3s, EKS,
  GKE) with Helm 3, PostgreSQL 16+, and Redis 7+.
---

# DevOps Skill

## Deployment Architecture
- **Production**: Helm 3 chart on Kubernetes (any distribution)
- **Development**: Docker Compose (PostgreSQL, Redis, Django, Celery, React dev server)
- **CI/CD**: GitHub Actions (OSS repo), GitLab CI (Enterprise repo)

## Helm Chart Standards
- All secrets via Kubernetes Secrets (never inline in values.yaml)
- Resource requests AND limits on every container
- Liveness + readiness probes on every deployment
- HPA (Horizontal Pod Autoscaler) on API and Celery workers
- PodDisruptionBudget for zero-downtime upgrades
- Ingress with cert-manager annotations for auto TLS
- PostgreSQL and Redis: Bitnami subcharts or external references

## Boot-Config Contract

Production settings (`packages/api/src/trueppm_api/settings/prod.py`) enforce several **fail-closed, import-time** boot guards: they `raise` ("Refusing to start…") when a required env var is empty/missing in non-DEBUG — `SECRET_KEY`, `INTEGRATION_ENCRYPTION_KEY`, the attachment-storage backend. gunicorn/asgi workers never run `manage.py check`, so these execute at module import — a missing value crash-loops the pod, not just a `check --deploy` warning.

When reviewing any change that adds or modifies such a guard — or any change to `.env.example` or the Helm chart — verify the **documented install path can satisfy every guard**:
- [ ] Every import-time-required env var has a `.env.example` entry that is *unmissable* — a `REQUIRED` banner with generation guidance, not a silent empty value or a commented-out line.
- [ ] The Helm chart actually **renders** that var into the api + worker deployments (via a Secret the values document) — a value referenced only in README/`values.yaml` prose, or behind an `envFrom:`/secret pattern that no deployment template renders, is silently never injected.
- [ ] A fresh config derived from `.env.example` (and a default `helm install`) boots without tripping a `Refusing to start` guard. A guard whose only documented config path is commented-out or non-functional is an install-blocker, not a hardening win.

## The Chart Must Be Able To Express What The Docs Prescribe

Every operator instruction in `docs/administration/` must be executable through **values alone** — that is the Helm contract. An operator who must fork the chart, hand-patch a template, or run a post-renderer to follow our own sizing guide has no supported path.

- [ ] **Any flag or setting the docs tell an operator to tune has a values key.** A hardcoded `command:`/`args:` list cannot be overridden by values, so a doc that says "append `--flag=N` to the container command" prescribes something impossible. When adding a `command:` to a template, add an `extraArgs` escape hatch alongside it. Grep the chart for the flag the docs name and confirm a key exists — the failure mode is a docs page and a template that were each individually reasonable and never checked against one another.
- [ ] **Defaults are safe on the hardware people actually run.** Process-count defaults that auto-detect (`cpu_count()`, `nproc`, worker auto-scaling) read the **node's** cores, not the pod's cgroup CPU limit. On a many-core node this forks far more children than the memory limit allows and OOMKills at zero load. Pin an explicit, modest default rather than inheriting host detection, and sanity-check it against the chart's own default memory limit.
- [ ] **Transport limits are reconciled with application limits.** Every proxy, ingress, and gateway in the request path imposes its own body-size, timeout, and header caps, and their defaults are small (ingress-nginx and nginx both default to 1 MB bodies). For each application-level cap (`*_MAX_UPLOAD_MB`, request timeouts, long-poll durations), confirm every hop in front of it permits at least that much — otherwise the app-level limit and its friendly error are unreachable and users get a bare 413/504. State the full chain when reviewing: ingress → in-cluster proxy → app.
- [ ] **Read BOTH branches of every conditional template block.** A control inside `{{- if .Values.demo }}` is *absent* from production, which is the opposite of what skimming suggests. When a template forks on demo/dev/prod, review each branch as a separate deployment and compare them: a setting present in only one is either a deliberate difference you can name, or a gap.
- [ ] **Assert the rendered production template in CI, not just the demo one.** `helm template` tests that only exercise the demo render prove nothing about what operators deploy. Every security-relevant assertion (access restrictions, body sizes, probes) needs a production-render counterpart.

## CI/CD Pipeline
```
PR → lint → type-check → unit-test → integration-test → build-image → deploy-preview
Merge → all above + E2E test → push to registry → deploy staging
Tag → all above + deploy production + publish PyPI (scheduler)
```

## Database Operations
- Migrations: always run in CI before deployment
- Backups: pg_dump daily, WAL archiving for point-in-time recovery
- Schema changes: online-only (no exclusive locks on large tables)

## Monitoring
- Prometheus metrics: django-prometheus middleware + custom business metrics
- Grafana dashboards: API latency (p50/p95/p99), Celery queue depth, WS connections
- Alerts: error rate >1%, p99 >2s, Celery queue >100, disk >80%

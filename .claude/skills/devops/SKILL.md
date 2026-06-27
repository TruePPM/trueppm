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

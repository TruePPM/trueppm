---
name: devops
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

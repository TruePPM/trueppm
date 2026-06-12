---
title: Deployment Sizing
description: Preliminary hardware sizing best-guesses for 50, 100, and 200 concurrent users.
---

:::caution[Preliminary best-guesses — not benchmarked guarantees]
These numbers are **preliminary best-guesses, not benchmarked guarantees.** TruePPM has no published load-testing data yet, and autoscaling plus large-scale hardening are on the pre-1.0 roadmap. Treat every figure on this page as a starting point to **load-test against your own workload**, and validate before committing budget or hardware.
:::

This page offers rough sizing guidance for self-hosted deployments at three scales. Because there is no benchmark data behind these figures yet, they are derived from the shipped Helm defaults and the shape of the workload — not from measured capacity. Expect to adjust them once you have run TruePPM against your real schedules.

## "Users" means concurrent active users

Throughout this page, **users** means *concurrent active* users, not named seats. PPM tools typically run at **~30–40% concurrency** — a 200-seat license rarely has 200 people clicking at once. If the numbers you are planning against are named seats rather than simultaneous sessions, divide expected load by roughly three before reading the tables below.

## What the shipped defaults give you

The Helm chart (`packages/helm/values.yaml`) ships these defaults:

- **API pod** (Django + uvicorn) and **Celery worker** each request `250m CPU / 512Mi` and limit at `1 CPU / 2Gi`. The production overlay runs **2 API replicas**.
- **Bundled PostgreSQL** requests `250m / 1Gi`, limits `2 CPU / 4Gi`, with an 8Gi PVC.
- **Bundled Valkey** requests `100m / 256Mi`, limits `1 CPU / 1Gi`, with a 2Gi PVC.

The key constraint to understand: uvicorn runs a **single worker per pod** (`packages/api/Dockerfile`, no `--workers` flag), so request throughput scales by **replica count**. Celery concurrency auto-detects the CPU count when left unset.

## Sizing tiers

| | 50 concurrent | 100 concurrent | 200 concurrent |
|---|---|---|---|
| API (uvicorn) replicas | 2 | 3 | 4–6 |
| Celery worker replicas | 1 (concurrency 2–4) | 2 (concurrency 4) | 3–4 (concurrency 4) |
| API total CPU / RAM | ~1 vCPU / 2Gi | ~1.5 vCPU / 3Gi | ~3 vCPU / 6Gi |
| Celery total CPU / RAM | ~1 vCPU / 2Gi | ~2 vCPU / 4Gi | ~4 vCPU / 8Gi |
| PostgreSQL | 2 vCPU / 4Gi, 20Gi disk | 2–4 vCPU / 8Gi, 50Gi | 4 vCPU / 16Gi, 100Gi |
| Valkey / Redis | 1 vCPU / 1Gi | 1 vCPU / 2Gi | 2 vCPU / 4Gi |
| **Cluster total (with headroom)** | **~4 vCPU / 8 GB, 1 node** | **~8 vCPU / 16 GB, 2 nodes** | **~16 vCPU / 32 GB, 2–3 nodes** |

## Bottlenecks, in the order they bite

1. **Celery / Monte Carlo CPU.** The scheduler is the heavy part. A portfolio reforecast or a Monte Carlo run (P50/P80/P95) is a CPU-bound burst. At 100+ concurrent users triggering recalculations, this is the first wall you hit. Scale Celery replicas, and pin `--concurrency` to the pod's CPU limit rather than letting it auto-detect — auto-detect over-allocates and gets OOM-killed (the dev compose file caps it at 2 for exactly this reason).
2. **Single uvicorn worker per pod.** WebSocket collaboration keeps connections open (the Channels capacity of 1500 is fine), but request CPU is a single worker. Add `--workers` (roughly 2× vCPU) or scale replicas before reaching 100 users. **This is the single most important non-default change.**
3. **Postgres connection ceiling.** `CONN_MAX_AGE=60` and `ATOMIC_REQUESTS=true` mean every request runs inside a transaction and holds a connection. With many API and Celery workers, you approach PostgreSQL's default `max_connections=100` at the 200-user tier — add **PgBouncer** or raise `max_connections`.

## Production-vs-default caveats

These defaults are tuned for evaluation, not scale. At every tier above:

- The **bundled PostgreSQL and Valkey sub-charts are dev/demo only** — single replica, small PVCs, and a non-persistent Valkey that loses in-flight Celery tasks on restart. Use a **managed PostgreSQL** (RDS, CloudSQL, etc.) and **managed Redis** instead.
- **File attachments default to the local filesystem** and are lost on pod restart. Set `TRUEPPM_DEFAULT_FILE_STORAGE` to an S3-compatible or MinIO backend.
- There is **no Horizontal Pod Autoscaler** — scale replicas manually. HPA is on the pre-1.0 roadmap.

## Per-tier recommendation summary

- **50 users:** single node, 4 vCPU / 8 GB, a small managed PostgreSQL; run the API at 2 replicas × 2 uvicorn workers.
- **100 users:** 2 nodes, 8 vCPU / 16 GB total; scale Celery separately from the API; PgBouncer optional.
- **200 users:** 2–3 nodes, 16 vCPU / 32 GB; a dedicated Celery node pool; PgBouncer required; managed Redis with persistence.

## Before you commit

Load-test against your own workload before committing budget or hardware. The dominant cost is workload-specific — how many schedules are active and how often reforecasts and Monte Carlo runs fire matters far more than raw user count. Until real benchmarks exist, **every figure on this page is a best-guess.**

See [Deployment](/administration/deployment/) for the underlying Helm chart and Docker Compose topology.

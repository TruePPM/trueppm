---
title: Upgrading
description: How to upgrade TruePPM — Docker Compose, single-server, and Helm paths.
---

## Before you upgrade

1. **Read the changelog** for the target version — check `CHANGELOG.md` or the [release notes](https://gitlab.com/trueppm/trueppm/-/releases) for breaking changes and migration notes.
2. **Back up PostgreSQL.** Valkey state is ephemeral (broker + cache); PostgreSQL is the only stateful service.
   ```bash
   pg_dump -U trueppm trueppm > trueppm-backup-$(date +%F).sql
   # Or via Docker:
   docker exec trueppm-db-1 pg_dump -U trueppm trueppm \
     > trueppm-backup-$(date +%F).sql
   ```
3. **Note your current version** before starting.
   ```bash
   docker inspect ghcr.io/trueppm/api:latest --format '{{.Config.Labels}}'
   # Or: helm list -n trueppm
   ```

---

## Docker Compose (development)

```bash
git pull origin main
docker compose pull
docker compose up -d
```

Migrations run automatically when the `api` container starts.

---

## Single-server with Docker Compose

```bash
cd /opt/trueppm
git pull origin main

# Update the target version in .env:
# APP_VERSION=0.2.0

docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The `api-init` service runs `migrate --noinput` before the API starts. Watch it complete:

```bash
docker compose -f docker-compose.prod.yml logs -f api-init
# Should end with: "0 unapplied migration(s)." or a list of applied migrations.
```

---

## Helm / Kubernetes

```bash
helm upgrade trueppm oci://ghcr.io/trueppm/charts/trueppm \
  --version 0.2.0 \
  --namespace trueppm \
  -f my-values.yaml
```

Migrations run in a Kubernetes Job before the new Deployment rolls out. Check status:

```bash
kubectl get jobs -n trueppm
kubectl logs -n trueppm job/trueppm-migrate
```

---

## Rollback

:::caution
Rolling back database migrations is risky and should be a last resort. Prefer rolling forward with a fix unless data integrity is at immediate risk.
:::

### Docker Compose rollback

```bash
# Restore the previous APP_VERSION in .env, then:
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

If the migration applied schema changes, restore from the pre-upgrade backup:

```bash
docker compose -f docker-compose.prod.yml down
docker volume rm trueppm_postgres_data
docker compose -f docker-compose.prod.yml up db -d
docker exec -i trueppm-db-1 psql -U trueppm trueppm < trueppm-backup-<date>.sql
# Then bring up the full stack at the previous version.
```

### Helm rollback

```bash
helm rollback trueppm -n trueppm
```

This restores the previous chart revision. If the migration applied schema changes, restore from backup and trigger a fresh `migrate` run.

---

## Post-upgrade verification

```bash
# Check all containers are healthy
docker compose -f docker-compose.prod.yml ps
# or
kubectl get pods -n trueppm

# Hit the health endpoint
curl https://trueppm.example.com/api/v1/health/

# Confirm the expected version is running
curl https://trueppm.example.com/api/v1/health/ | python3 -m json.tool
```

---

## Common issues

**Migrations fail on startup**

Check that `DATABASE_URL` is correct and the database is reachable. Run migrations manually to see the full traceback:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py migrate --noinput
```

**Static files not updating**

Trigger a `collectstatic` run:

```bash
docker compose -f docker-compose.prod.yml exec api python manage.py collectstatic --noinput --clear
```

**WebSocket connections drop after upgrade**

Expected — clients reconnect automatically within a few seconds. The Channels layer (Valkey) is not drained between upgrades; in-flight messages are lost but clients recover via the reconnect loop.

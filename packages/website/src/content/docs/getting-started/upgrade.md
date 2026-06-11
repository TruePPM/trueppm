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

Migrations run in a `migrate` init container of the api Deployment before the new pods start serving. Check its logs:

```bash
kubectl logs -n trueppm deployment/trueppm-api -c migrate
```

---

## Upgrading to the hardened Helm chart

The Helm chart now installs secure by default: it generates the PostgreSQL and
Valkey passwords and stores them in a chart-owned **connection Secret**
(`<release>-trueppm-connection`, annotated `helm.sh/resource-policy: keep`),
injects `DATABASE_URL` / `REDIS_URL` via `secretKeyRef`, enables Valkey auth by
default, and applies restricted container security contexts. A few notes when
upgrading **from a pre-hardening release**:

- **Rotate the old default password.** Earlier chart versions shipped a default
  database/cache password of `trueppm`. If you ran with that default, rotate it.
  The simplest path is to set explicit, strong passwords on the upgrade so the
  chart writes them into the connection Secret and the bundled datastores pick
  them up:
  ```bash
  helm upgrade trueppm oci://ghcr.io/trueppm/charts/trueppm \
    --namespace trueppm \
    -f my-values.yaml \
    --set postgresql.auth.password="<new-strong-password>" \
    --set valkey.auth.password="<new-strong-password>"
  ```
  Prefer supplying these through an external Secret over `--set`. After the
  rollout settles you can clear the explicit values and let the chart manage the
  password from the connection Secret going forward.
- **Leave the passwords blank to keep the generated ones.** On an upgrade where a
  connection Secret already exists, leaving `postgresql.auth.password` /
  `valkey.auth.password` empty makes the chart **read the existing password back**
  rather than minting a new one — so re-running `helm upgrade` never churns the
  credential or orphans the database PVC.
- **The connection Secret survives `helm uninstall`.** The `resource-policy: keep`
  annotation means an accidental uninstall/reinstall reuses the same password and
  keeps the existing data reachable. If you intend a clean wipe, delete the Secret
  and the PersistentVolumeClaims explicitly.
- **Using managed datastores?** When `postgresql.enabled` / `valkey.enabled` are
  `false`, `env.DATABASE_URL` and `env.REDIS_URL` are now **required** — the chart
  fails the render if either is missing. Add them (ideally via an external Secret)
  before upgrading.
- **App-side auth/CSP defaults.** The refresh token now rides an httpOnly Secure
  cookie and a strict CSP header is sent on every response. A standard same-origin
  deploy needs no changes. Split-origin deploys must set
  `AUTH_REFRESH_COOKIE_SAMESITE` and `CSP_CONNECT_SRC` — see
  [Configuration](/administration/configuration/#split-origin-deploys).

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
# → {"status": "ok"}

# Confirm the expected version is running — check the deployed image tag
kubectl get deployment -n trueppm trueppm-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
# or: helm list -n trueppm
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

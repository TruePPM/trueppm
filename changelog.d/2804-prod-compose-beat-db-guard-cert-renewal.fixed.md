Fixed three defects on the Docker Compose production path. The stack now runs a
`celery-beat` service, so periodic work (outbox and email drains, retention purge,
burndown and forecast snapshots) actually runs and `/api/v1/health/beat/` reports
healthy instead of 503. The bundled-database services set
`TRUEPPM_ALLOW_UNENCRYPTED_DB=true` — matching what the Helm chart already does for
its bundled PostgreSQL — so the documented setup no longer crash-loops on the
`sslmode` boot guard against a database that cannot serve TLS. Let's Encrypt
certificates now renew: `init-prod.sh` writes `COMPOSE_PROFILES=letsencrypt` into
`.env` so the certbot service survives every later restart, renewal runs through the
webroot instead of a port that nginx already holds, and nginx reloads periodically to
pick up the renewed certificate. Deployment docs gained the two startup-blocking
values their "Required minimums" omitted (`INTEGRATION_ENCRYPTION_KEY` and the
attachment-storage choice).

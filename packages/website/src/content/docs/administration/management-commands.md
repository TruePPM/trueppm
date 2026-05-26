---
title: Management Commands
description: Django management commands for bootstrapping an admin account and seeding demo data, plus the maintenance commands that ship with TruePPM.
---

TruePPM ships a small set of Django management commands. Run them with
`python manage.py <command>` inside the API container, for example:

```bash
docker compose exec api python manage.py seed_demo_project --with-personas
```

## `create_admin`

Bootstraps the first Django superuser. This runs **automatically** on container
startup, so most operators never invoke it directly. It is **idempotent** — if a
superuser already exists, it exits without changing anything (it never resets an
existing password).

Configured entirely through environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DJANGO_SUPERUSER_EMAIL` | `admin@trueppm.dev` | Admin email |
| `DJANGO_SUPERUSER_USERNAME` | local part of the email | Admin username |
| `DJANGO_SUPERUSER_PASSWORD` | secure random | Explicit password; if unset, a random one is generated |
| `TRUEPPM_ADMIN_PASSWORD_FILE` | `/tmp/trueppm_admin_password` | Where the generated password is written (mode `0600`) |

When a password is generated rather than supplied, it is written to the password file
(not the logs). See [Admin Password](/administration/admin-password/) for how to
retrieve it on first boot.

## `seed_demo_project`

Builds the **"Platform Migration"** demo project — a complete narrative covering the
full hybrid PM flow (charter → decompose → schedule → capacity → stories → sprint
planning → execute → forecast → close), with a WBS, a CPM schedule, a baseline,
planned/active/closed sprints with burndown, board state, and a retrospective.

| Flag | Effect |
|------|--------|
| `--with-personas` | Also creates six demo user logins (Maya, Raj, Diana, Sarah, Carlos, Tom) bound to the project with role-appropriate membership |

The command is **idempotent** — re-running clears any prior "Platform Migration"
project and re-seeds it from scratch, so it is safe to run repeatedly while exploring.

## Maintenance commands

These exist for specific operational situations and are not part of routine use:

- **`backfill_in_progress_status`** — a one-time data-correction command that
  transitions `NOT_STARTED` tasks whose planned start is in the past to `IN_PROGRESS`
  (pinning their actual start to the planned date). Run it once after upgrading from a
  version that predated automatic in-progress transitions. Pass `--dry-run` to preview
  the affected rows without writing. It is idempotent and transaction-safe.
- **`seed_integration_fixtures`** — seeds stable fixtures for the integration-test CI
  job. It is intended for CI and local test runs, not production.

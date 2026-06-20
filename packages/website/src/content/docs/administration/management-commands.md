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

## Sample data & JSON seed

Three commands cover bundled sample projects and the canonical JSON seed format
(ADR-0109). See [Sample projects](/getting-started/sample-projects/) for the
user-facing guide.

- **`load_sample_project [--sample <key>] [--owner <username>]`** — imports a
  bundled sample seed (default: the Atlas hybrid-large launch demo) and flags its
  projects as sample data. Idempotent — re-running replaces the sample. The owner
  defaults to the first superuser.
- **`import_seed <path> [--owner <username>] [--create-users]`** — imports a
  TruePPM JSON seed file into the database. Re-running with the same file rebuilds
  the program subtree idempotently on the program slug. `--create-users` mints any
  accounts the seed references that do not yet exist (intended for local demos,
  not production).
- **`export_program <slug> [--out <path>]`** — exports a program (matched by
  `Program.code`) to the canonical JSON seed format, to `--out` or stdout. The
  output round-trips: re-importing it reproduces the program.

## Maintenance commands

These exist for specific operational situations and are not part of routine use:

- **`backfill_in_progress_status`** — a one-time data-correction command that
  transitions `NOT_STARTED` tasks whose planned start is in the past to `IN_PROGRESS`
  (pinning their actual start to the planned date). Run it once after upgrading from a
  version that predated automatic in-progress transitions. Pass `--dry-run` to preview
  the affected rows without writing. It is idempotent and transaction-safe.
- **`prune_forecast_snapshots`** — applies the tiered retention curve to project
  forecast snapshots (ships in 0.3): keeps every snapshot younger than `daily_days`,
  one-per-ISO-week up to `weekly_days`, and one-per-calendar-month beyond that. TruePPM
  runs this automatically via the `scheduling.prune_forecast_snapshots` Celery Beat job
  (nightly, 04:15 UTC); run it manually only to reclaim space on demand or if you operate
  the API without Beat. Pass `--dry-run` to report the current snapshot count without
  deleting. The windows come from the `FORECAST_SNAPSHOT_RETENTION` setting — see
  [Outbox & Record Retention → Forecast snapshots](/administration/retention/#forecast-snapshots).
- **`seed_integration_fixtures`** — seeds stable fixtures for the integration-test CI
  job. It is intended for CI and local test runs, not production.
- **`flushexpiredtokens`** — deletes expired `OutstandingToken`/`BlacklistedToken`
  rows created by JWT refresh-token rotation and logout (provided by the
  `token_blacklist` app). TruePPM runs this automatically via the
  `access.flush_expired_blacklisted_tokens` Celery Beat job (nightly, 04:30 UTC);
  run it manually only if you operate the API without Beat. See
  [Security → Blacklist tables and cleanup](/administration/security/#blacklist-tables-and-cleanup).

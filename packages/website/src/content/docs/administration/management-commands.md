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
| `DJANGO_SUPERUSER_EMAIL` | `admin@trueppm.com` | Admin email |
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

The persona password is resolved so a fixed weak password never reaches a public
instance: `TRUEPPM_DEMO_PASSWORD` env var if set, otherwise `demo` under
`DEBUG=True`, otherwise a random token printed once at seed time. A value supplied
via `TRUEPPM_DEMO_PASSWORD` is not echoed back to stdout — only the generated
random token (or the dev `demo` default) is printed.

The command is **idempotent** — re-running clears any prior "Platform Migration"
project and re-seeds it from scratch, so it is safe to run repeatedly while exploring.

## `create_demo_share_link`

Mints (or pins) the public read-only **schedule share link** used by the hosted
demo (`try.trueppm.com`) and prints its URL. The demo dogfoods the product's own
tokenized, read-only share link (#283 / #1486) rather than a bespoke read-only
mode — no login, no write path, near-zero abuse surface. Run it after
`seed_demo_project`; the [demo compose stack](/getting-started/try-it/) runs both
automatically.

| Flag | Effect |
|------|--------|
| `--project <name>` | Demo project to share (default: `Platform Migration`) |
| `--token <token>` | Pin a fixed raw token for a stable, reprintable URL (falls back to the `TRUEPPM_DEMO_SHARE_TOKEN` env var). Omit to mint a random token once |
| `--base-url <url>` | Public base URL of the demo host (falls back to `TRUEPPM_DEMO_BASE_URL`, else `https://try.trueppm.com`) |

With a pinned token the command is **idempotent and reprintable** — it upserts a
link whose hash matches the token and prints the same stable URL on every run, so
the demo has one deep-linkable address that survives restarts. Without a token, a
random link is minted once; because the raw token is stored only as a hash it
cannot be reprinted, so re-running reuses the existing link and prompts you to pin
a token. This command never creates persona logins and never touches the
`TRUEPPM_DEMO_PASSWORD` path.

## `seed_ga_launch_program`

Builds the **"1.0 GA Launch"** hybrid sample *program* — one OSS program of four
workstream projects (Platform Hardening & Scale, SOC 2 Type II Readiness, Security
Pen-Test & Remediation, and GA Marketing & Launch) that together ship a single
outcome. Where `seed_demo_project` tells a standalone-project story, this seed
demonstrates what only a program can: **real accepted cross-project dependencies**
that form a critical path running *across* projects, and **shared people who
over-allocate in overlapping windows**. The critical path is genuinely computed by
the program-scoped CPM pass — it stays correct when a task is dragged, rather than
being hard-coded.

Alongside the four projects it seeds seven persona accounts and their linked
resources, the per-project **5-role RBAC matrix** (Owner/Admin/Scheduler/Member/
Viewer), two sprints on the Marketing project (a closed one with a burndown and a
live one bound to the go-live milestone), a Kanban board on the Security project,
and a shared 5-day calendar with one company holiday. Every project is flagged as
**sample data**.

| Flag | Effect |
|------|--------|
| `--with-personas` | Gives the seven persona accounts the resolved demo password so they are loginable — same resolution as `seed_demo_project` (`TRUEPPM_DEMO_PASSWORD` if set, otherwise `demo` under `DEBUG=True`, otherwise a random token printed once at seed time) |

Without `--with-personas` the persona accounts still exist — the RBAC matrix,
project leads, and task assignees reference them — but they carry unusable passwords
and cannot be logged into. The command is **idempotent**: re-running clears any prior
"1.0 GA Launch" program and re-seeds it, so it is safe to run repeatedly.

## Sample data & JSON seed

Three commands cover bundled sample projects and the canonical JSON seed format
(ADR-0109). See [Sample projects](/getting-started/sample-projects/) for the
user-facing guide.

- **`load_sample_project [--sample <key>] [--owner <username>] [--with-personas]`** —
  imports a bundled sample seed (default: the Atlas hybrid-large launch demo) and
  flags its projects as sample data. Idempotent — re-running replaces the sample. The
  owner defaults to the first superuser. `--with-personas` gives the sample's persona
  accounts the resolved demo password so they are loginable and prints their real,
  namespaced usernames (e.g. `atlas-alex`) — same resolution as `seed_demo_project`
  (`TRUEPPM_DEMO_PASSWORD` if set, else `demo` under `DEBUG=True`, else a random token
  printed once). Without it the personas exist but carry unusable passwords.
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
  forecast snapshots (added in 0.3): keeps every snapshot younger than `daily_days`,
  one-per-ISO-week up to `weekly_days`, and one-per-calendar-month beyond that. TruePPM
  runs this automatically via the `scheduling.prune_forecast_snapshots` Celery Beat job
  (nightly, 04:15 UTC); run it manually only to reclaim space on demand or if you operate
  the API without Beat. Pass `--dry-run` to report the current snapshot count without
  deleting. The windows come from the `FORECAST_SNAPSHOT_RETENTION` setting — see
  [Outbox & Record Retention → Forecast snapshots](/administration/retention/#forecast-snapshots).
- **`audit_verify`** — verifies the integrity of the append-only, hash-chained
  [agent-action audit log](/administration/mcp-server/#agent-action-audit-log). It walks
  the chain in `sequence` order, recomputes each row's `record_hash` from its predecessor,
  and exits non-zero on the first break (a tampered field, a deleted/reordered row, or a
  broken link); an intact or empty chain exits `0`. If the oldest rows have been pruned
  with `audit_prune`, the walk re-anchors from the latest prune checkpoint instead of the
  chain genesis, so the surviving records still verify. Pass `--quiet` to suppress the
  summary on success — handy for a cron/CI integrity check. It only reads, so it is always
  safe to run.
- **`audit_prune`** — bounds the size of the append-only
  [agent-action audit log](/administration/mcp-server/#agent-action-audit-log), which
  otherwise grows without limit. It deletes a contiguous block of the **oldest** records
  and writes an immutable checkpoint so `audit_verify` still verifies the records that
  remain — a plain `DELETE` would break the chain. Choose exactly one window: `--before
  <ISO-8601>`, `--keep-days <N>`, or `--keep-last <K>` (keep the newest K records). It is a
  **dry-run by default** — it prints what would be removed and changes nothing; pass
  `--commit` to actually delete (add `--yes` to skip the confirmation prompt). Deletion is
  irreversible, so review the dry-run first. This is a manual, operator-initiated command:
  TruePPM never prunes the audit log automatically, and there is no default schedule — if
  you want periodic rotation, run it from your own cron. Enforced retention, legal hold,
  and off-server archival are part of TruePPM Enterprise.
- **`seed_integration_fixtures`** — seeds stable fixtures for the integration-test CI
  job. It is intended for CI and local test runs, not production.
- **`flushexpiredtokens`** — deletes expired `OutstandingToken`/`BlacklistedToken`
  rows created by JWT refresh-token rotation and logout (provided by the
  `token_blacklist` app). TruePPM runs this automatically via the
  `access.flush_expired_blacklisted_tokens` Celery Beat job (nightly, 04:30 UTC);
  run it manually only if you operate the API without Beat. See
  [Security → Blacklist tables and cleanup](/administration/security/#blacklist-tables-and-cleanup).

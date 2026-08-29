---
title: Management Commands
description: Django management commands for bootstrapping an admin account and seeding demo data, plus the maintenance commands that ship with TruePPM.
documentedFor: "0.4"
---

:::note[Ships in 0.4]
One command on this page — **`revoke_api_tokens`**, under
[Maintenance commands](#maintenance-commands) — ships in **TruePPM 0.4**. It is not
in `v0.3.0-alpha.3`, the latest release; on 0.3 there is no bulk API-token
revocation lever, and tokens must be revoked one at a time from each owner's
personal settings page. Everything else on this page is in the current release.
:::

TruePPM ships a small set of Django management commands. Run them with
`python manage.py <command>` inside the API container, for example:

```bash
docker compose exec api python manage.py load_sample_project --with-personas
```

## `create_admin`

Bootstraps the first Django superuser. This runs **automatically** on container
startup, so most operators never invoke it directly. It is **idempotent** — if a
superuser already exists, it exits without changing anything (it never resets an
existing password).

Configured entirely through environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DJANGO_SUPERUSER_EMAIL` | `admin@example.com` | Admin email. The default is a reserved domain and cannot receive mail — set it to an address you control. |
| `DJANGO_SUPERUSER_USERNAME` | local part of the email | Admin username |
| `DJANGO_SUPERUSER_PASSWORD` | secure random | Explicit password; if unset, a random one is generated |
| `TRUEPPM_ADMIN_PASSWORD_FILE` | `/tmp/trueppm_admin_password` | Where the generated password is written (mode `0600`) |

When a password is generated rather than supplied, it is written to the password file
(not the logs). See [Admin Password](/administration/admin-password/) for how to
retrieve it on first boot.

## `load_sample_project`

Loads one of the bundled sample programs from its JSON fixture and flags every
project it creates as sample data. This replaced the two Python seeders
(`seed_demo_project`, `seed_ga_launch_program`): because a sample is now a
declared document rather than procedural code, it can be downloaded, hashed,
inspected, round-tripped through export/import, and loaded from **Settings →
System → Demo data** — none of which was possible while the story lived in Python.

| Flag | Effect |
|------|--------|
| `--sample <key>` | Which sample to load. Default: `atlas-platform-launch`. See [sample projects](/getting-started/sample-projects/) for the full catalog |
| `--owner <username>` | Who owns the loaded program. Defaults to the first superuser; failing that, the sample's own OWNER persona (created with an unusable password) |
| `--with-personas` | Gives the sample's persona accounts the resolved demo password so they are loginable, and prints their namespaced usernames (e.g. `atlas-alex`) |

The persona password is resolved so a fixed weak password never reaches a public
instance: `TRUEPPM_DEMO_PASSWORD` env var if set, otherwise `demo` under
`DEBUG=True`, otherwise a random token printed once at load time. A value supplied
via `TRUEPPM_DEMO_PASSWORD` is not echoed back to stdout — only the generated
random token (or the dev `demo` default) is printed.

Without `--with-personas` the persona accounts still exist — task assignees, risk
owners and the per-project RBAC matrix all reference them — but they carry unusable
passwords and cannot be logged into. That is the property the [hosted demo's
read-only posture](/getting-started/try-it/) rests on.

The command is **idempotent** — re-running replaces the prior copy of that sample
and re-seeds it, so it is safe to run repeatedly while exploring. The replace is
scoped by the internal `is_sample` flag the importer sets, so a real project that
happens to share a name with a sample project is never touched.

## `create_demo_share_link`

Mints (or pins) the public read-only **share links** used by the hosted demo
(`try.trueppm.com`) and prints their URLs. The demo dogfoods the product's own
tokenized, read-only share links (#283 / #1486) rather than a bespoke read-only
mode — no login, no write path, near-zero abuse surface. Run it after
`load_sample_project`; the [demo compose stack](/getting-started/try-it/) runs both
automatically.

| Flag | Effect |
|------|--------|
| `--project <name>` | Demo project to share (default: `Platform Core`, from the Atlas sample) |
| `--token <token>` | Pin a fixed raw token for a stable, reprintable **schedule** URL (falls back to the `TRUEPPM_DEMO_SHARE_TOKEN` env var). Omit to mint a random token once |
| `--token-board <token>` | Pin a fixed raw token for a **board** URL (falls back to `TRUEPPM_DEMO_SHARE_TOKEN_BOARD`). Omit and no board link is minted |
| `--base-url <url>` | Public base URL of the demo host (falls back to `TRUEPPM_DEMO_BASE_URL`, else `http://localhost`) |

A schedule link is always minted. A **board** link is minted only when you supply a
board token, so an existing invocation that passes only the schedule token keeps its
previous single-link behavior. The two tokens must differ: share-link hashes are
globally unique, so one token cannot back both links, and reusing a token already
bound to the other kind is refused rather than silently reusing the wrong row.
There is no generated-token mode for the board link — a board link is only worth
having if its URL is stable.

The base URL only decides what host the *printed* URL names; it does not affect
the link itself. It defaults to `http://localhost` — correct for the local
[demo compose stack](/getting-started/try-it/), which publishes there — so set
`TRUEPPM_DEMO_BASE_URL` (or `--base-url`) whenever you serve the demo on a public
origin, or the logs will advertise a loopback address to your visitors. The Helm
demo path requires `demo.baseUrl` and fails its render if it is empty, so it
never falls back.

With a pinned token the command is **idempotent and reprintable** — it upserts a
link whose hash matches the token and prints the same stable URL on every run, so
the demo has one deep-linkable address that survives restarts. Without a token, a
random link is minted once; because the raw token is stored only as a hash it
cannot be reprinted, so re-running reuses the existing link and prompts you to pin
a token. This command never creates persona logins and never touches the
`TRUEPPM_DEMO_PASSWORD` path.

:::caution[Pinning is mandatory under Helm]
The [chart's demo mode](/administration/helm-values/#public-read-only-demo-mode)
re-runs `load_sample_project` on every upgrade, and that load is destructive — share
links cascade away with their project. Pinned tokens recreate the same URLs; unpinned
ones would silently change the public URL on every upgrade, so the chart refuses to
render without them.
:::

### It turns public sharing on for the demo project

Minting a link and *serving* it are two different gates. A link resolves only when the
["Public sharing" policy](/features/board-sharing/) is on for the project, and the
workspace default is **off** — so the command enables it on the demo project as part of
minting, or it would print URLs that answer `410 Gone`.

The override is written on the **demo project only**, never on the workspace. Every other
project on the instance keeps inheriting the workspace default, so seeding the sample onto
a real install does not loosen your sharing posture. The command picks its project by the
importer's internal `is_sample` flag, so it cannot touch a real project of the same name.

Two things still outrank it, and the command reports either one instead of printing a URL
it knows will not work:

- `TRUEPPM_PUBLIC_BOARD_SHARING_ENABLED=false` — the instance-wide kill switch. Share URLs
  return `404`. Set it to `true` to run a public demo.
- A workspace **Enforce** sharing policy with public sharing off (Enterprise). Share URLs
  return `410` until a workspace admin turns it on or relaxes the override policy.

## The "1.0 GA Launch" sample

The **"1.0 GA Launch"** program — four workstream projects (Platform Hardening &
Scale, SOC 2 Type II Readiness, Security Pen-Test & Remediation, GA Marketing &
Launch) shipping a single outcome — used to have its own `seed_ga_launch_program`
command. It is now a bundled sample like every other:

```bash
python manage.py load_sample_project --sample ga-launch
```

It demonstrates what only a program can: **cross-project dependencies** forming a
critical path that runs *across* projects, and **shared people who over-allocate in
overlapping windows**. The critical path is genuinely computed by the
program-scoped CPM pass, so it stays correct when a task is dragged rather than
being hard-coded. It also carries the per-project **5-role RBAC matrix**
(Owner/Admin/Scheduler/Member/Viewer), a WIP-limited Kanban board on the Security
workstream, two sprints on the Marketing workstream, and a shared calendar with a
company holiday.

## `seed_capacity`

Generates a **synthetic** program at a chosen scale, for capacity testing rather than
demonstration. Where `load_sample_project` loads a *fixed-size* curated fixture,
`seed_capacity` builds an
arbitrarily large, structurally realistic program so the [published scale
envelope](/administration/sizing/#tested-envelope) can be measured to its first sustained
breach rather than against a fixed load. It is the seeder the [capacity
harness](/administration/sizing/#re-running-this) drives on every step.

```bash
export TRUEPPM_CAPACITY_PASSWORD=$(python3 -c \
  'import secrets; print(secrets.token_urlsafe(16))')
python manage.py seed_capacity --projects 1 --tasks 4000 --edge-ratio 1.2
python manage.py seed_capacity --reset
```

| Flag | Effect |
|------|--------|
| `--projects <N>` | Projects to create under the seeded `CAPACITY` program (default `1`) |
| `--tasks <N>` | Tasks per project, not the total across all projects (default `1000`) |
| `--edge-ratio <F>` | Dependency edges per task. `1.0` is a single forward chain; above `1.0` adds forward cross-links. CPM recompute cost is edge-driven, so this is the dimension that moves recompute time (default `1.0`) |
| `--breadth <N>` | Children per WBS summary row, setting how deep the task hierarchy runs (default `12`) |
| `--reset` | Delete the existing capacity program's projects first, leaving all other data alone |
| `--member-email <EMAIL>` | Also grant an **existing** user `Owner` on every created project, so a harness that authenticates as some other seeded account can read the fixture. Fails if no such user exists — it never creates one |

Reach for `--member-email` when the thing measuring the fixture signs in as somebody
other than `capacity@trueppm.local`. Project reads are membership-scoped, so without a
membership row the caller gets a `200` with an empty page and silently measures nothing.
The nightly `perf:load` job uses it for exactly this reason: it authenticates as the
account `seed_integration_fixtures` created, then seeds the capacity project alongside it.

`TRUEPPM_CAPACITY_PASSWORD` is **required** and has no default — the command creates (or
resets the password on) a real, loginable `capacity@trueppm.local` account the load driver
authenticates as, and a fixed committed password for a real account is a secret-scanner
finding regardless of how disposable the stack it runs against is. The supplied value is
still checked against the configured password validators.

**Not a demo seed — rows are synthetic filler.** Two fidelity caveats are worth knowing
before reading capacity numbers off it: rows are written with `bulk_create()`, so they
carry no `django-simple-history` rows and leave `server_version` at `0` (a schedule read
touches neither, so read-latency measurements are unaffected, but on-disk size and any
sync-delta timing would understate an organically grown database); and generated
dependencies are strictly forward-linked (a lower task index always precedes a higher
one), which is acyclic by construction but tidier than a real plan's topology.

This command must never be pointed at a real deployment — it is intended only for the
disposable local capacity stack described in `packages/api/perf/capacity/README.md`.

## Sample data & JSON seed

Three commands cover bundled sample projects and the canonical JSON seed format
(ADR-0109). See [Sample projects](/getting-started/sample-projects/) for the
user-facing guide.

- **`load_sample_project [--sample <key>] [--owner <username>] [--with-personas]`** —
  imports a bundled sample seed (default: the Atlas hybrid-large launch demo) and
  flags its projects as sample data. Idempotent — re-running replaces the sample. The
  owner defaults to the first superuser. `--with-personas` gives the sample's persona
  accounts the resolved demo password so they are loginable and prints their real,
  namespaced usernames (e.g. `atlas-alex`) — same resolution as `load_sample_project`
  (`TRUEPPM_DEMO_PASSWORD` if set, else `demo` under `DEBUG=True`, else a random token
  printed once). Without it the personas exist but carry unusable passwords.
- **`import_seed <path> [--owner <username>] [--create-users] [--no-replace]`** —
  imports a TruePPM JSON seed file into the database. Re-running with the same file
  rebuilds the program subtree idempotently on the program slug. `--create-users`
  mints any accounts the seed references that do not yet exist (intended for local
  demos, not production).

  The command **defaults to replacing** a live program of the owner's that already
  uses the seed's slug — re-running `make seed` in place is what it is for, and an
  operator at a shell has `--check` (below) available to look first. `--no-replace`
  inverts that: the command reports the collision and exits with an error instead of
  overwriting. The REST endpoint defaults the opposite way and refuses until the
  caller confirms.

  The replaced program's projects move to project Trash, where each can be restored
  individually as a standalone project — the program shell itself is **not**
  recoverable, and a restored project does not return to it. `load_sample_project`
  is the exception: it still deletes the previous sample copy outright, because
  demo data is disposable.
- **`import_seed <path> --check`** — validates the file and reports every problem
  **without importing it**. Writes nothing, exits `0` when the document is valid
  and `1` when it is not, so it can gate a CI job. Because a real import replaces
  a matching program rather than merging into it, this is how you answer *"will
  this be accepted?"* before pointing a destructive operation at a live program.
  Output
  leads with what the file claims to be — schema version, program name and slug,
  and the project / task / resource counts — then lists each diagnostic anchored
  to its JSON path:

  ```console
  $ python manage.py import_seed atlas.json --check
  Checked atlas.json
    schema_version: 2.0
    program:        Atlas Platform Launch
    slug:           atlas
    contents:       3 project(s), 214 task(s), 9 resource(s)

    $.projects[0].tasks[2].predecessors[0]: unknown task ref 'design'
  CommandError: Invalid seed document: 1 problem found.
  ```

  Needs no superuser, so it works on a fresh instance before the first import.
  The same check is available over the API as
  `POST /api/v1/programs/import/validate/`.
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
- **`revoke_api_tokens`** — the breach-recovery lever for
  [API tokens](/features/personal-access-tokens/). Rotating `JWT_SIGNING_KEY` signs
  every *session* out, but an API token carries no signature — it is resolved by a
  SHA-256 hash lookup — so key rotation leaves every leaked token live. This command
  is the other half of that procedure. Choose exactly one scope: `--user
  <username-or-email>` (one account's personal tokens — the off-boarding or stolen-
  laptop case), `--all-personal` (every personal token on the instance, leaving team
  integration tokens working), or `--all` (**every** token including project- and
  program-scoped ones, which breaks all inbound sync until an admin re-mints). It is
  a **dry-run by default**: it lists what it would revoke and changes nothing until
  you pass `--commit` (add `--yes` to skip the confirmation prompt). Revocation is
  one-way — nothing un-revokes a token — so review the dry run first. Every revoked
  token gets an audit row tagged `operator_bulk_revoke`, so an incident timeline can
  tell a containment sweep apart from a user's routine rotation. See
  [Security → forcing a global sign-out](/administration/security/#separating-the-jwt-signing-key-and-forcing-a-global-sign-out).
- **`seed_integration_fixtures`** — seeds stable fixtures for the integration-test CI
  job. It is intended for CI and local test runs, not production.
- **`seed_sso_keycloak`** — provisions a `keycloak` OIDC provider (an allauth
  `SocialApp` plus its `SsoProviderPolicy`) pointing at a live Keycloak instance, plus a
  workspace-admin account, for the `sso:integration` nightly CI job. Idempotent —
  re-running updates the existing rows rather than duplicating them. Configured entirely
  through environment variables (`SSO_KEYCLOAK_ISSUER`, `SSO_KEYCLOAK_CLIENT_ID`,
  `SSO_KEYCLOAK_CLIENT_SECRET`, `SSO_KEYCLOAK_ALLOWED_DOMAIN`, `SSO_ADMIN_EMAIL`,
  `INTEGRATION_USER_PASSWORD`), all with CI-friendly defaults; the CI job sets them
  explicitly so the values match the baked realm export. Like
  `seed_integration_fixtures`, it is intended for CI and local test runs, not
  production — the issuer host must also be present in the SSRF egress
  allow-list ([`TRUEPPM_EGRESS_ALLOWLISTED_HOSTS`](/administration/single-sign-on/),
  ADR-0590), which the CI job sets alongside it.
- **`flushexpiredtokens`** — deletes expired `OutstandingToken`/`BlacklistedToken`
  rows created by JWT refresh-token rotation and logout (provided by the
  `token_blacklist` app). TruePPM runs this automatically via the
  `access.flush_expired_blacklisted_tokens` Celery Beat job (nightly, 04:30 UTC);
  run it manually only if you operate the API without Beat. See
  [Security → Blacklist tables and cleanup](/administration/security/#blacklist-tables-and-cleanup).

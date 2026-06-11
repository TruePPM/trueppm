---
title: MS Project configuration
description: Operator reference for TruePPM's MS Project import / export — upload size cap, the optional MPXJ toolchain for .mpp files, the import-history retention window, and security boundaries on parsed input.
---

This page is the operator's reference for TruePPM's [MS Project import / export](/features/msproject-import-export/) surface. The user-facing flows ship with sensible defaults — most deployments do not need to change anything here — but the four knobs below cover upload size, the optional `.mpp` toolchain, history retention, and what's enforced on parsed input.

## Upload size cap

The per-file import cap defaults to **50 MB** and is set by the `MSPROJECT_MAX_UPLOAD_MB` environment variable.

| Setting | Default | Unit | What it bounds |
|---|---|---|---|
| `MSPROJECT_MAX_UPLOAD_MB` | `50` | megabytes | Maximum file size accepted by the import endpoints (`.xml` and `.mpp`). Files larger than this are rejected with HTTP 400 before any parsing happens. |

The cap is **deliberately lower** than the 100 MB attachment ceiling. An import is read fully into memory and stored base64-encoded in a single `ImportRequest` database row (~33% inflation), so a 50 MB upload already costs ~67 MB of RAM and row size during the import window. 50 MB is also the practical MS Project file ceiling — schedules larger than that degrade in MS Project itself.

:::caution[Do not raise above the global hard caps]
`DATA_UPLOAD_MAX_MEMORY_SIZE` (Django; default 100 MB) and `client_max_body_size`
(nginx; the reference single-server templates ship `20M` — raise it to at least
your `MSPROJECT_MAX_UPLOAD_MB`) are the absolute edge caps.
Setting `MSPROJECT_MAX_UPLOAD_MB` above either has no effect — the upload is
rejected at the upstream layer first. If you genuinely need bigger files, raise
all three together and budget for the memory cost per concurrent import.
:::

Setting it lower is safe — TruePPM will reject larger uploads with a clear error message naming the configured cap.

## `.mpp` and Java

The `.xml` (MSPDI) format is parsed by TruePPM directly and **always works** — no Java dependency. Binary `.mpp` files need the optional [MPXJ](https://www.mpxj.org/) command-line JAR and a Java 11+ runtime.

| Setting | Default | Notes |
|---|---|---|
| `MPXJ_JAR_PATH` | `/opt/mpxj/mpxj-cli.jar` | Path to the MPXJ CLI JAR inside the API container. Set via a Django settings override only — an environment-variable binding is not yet wired. |

If a user uploads a `.mpp` and the JAR isn't at the configured path, the import fails with `"MPXJ JAR not found … Expected at: {jar_path}. Set MPXJ_JAR_PATH in settings to override."` The user-facing import dialog and the format picker both recommend "**File → Save As → XML Format**" in MS Project as the workaround — `.xml` round-trips with everything `.mpp` round-trips, with the exception of MS Project's binary-only formatting / view state (which TruePPM never reads anyway).

The reference TruePPM Docker image **does not bundle** the MPXJ JAR or a JRE. To enable `.mpp` import on a self-hosted deployment, you have two options:

1. **Build a custom API image** that installs OpenJDK 11+ and downloads the MPXJ CLI JAR into `/opt/mpxj/`. This is the cleanest path for production.
2. **Mount the JAR via a Helm value-supplied volume** and add a Java sidecar or init-installer. Heavier setup; usually only worth it if you cannot rebuild images.

Helm values are not currently pre-wired for either. Because `MPXJ_JAR_PATH` is read from Django settings (not the environment), override it in a settings module baked into your custom image — for example a `trueppm_api.settings.custom` module that imports the prod settings and sets `MPXJ_JAR_PATH = "/opt/mpxj/mpxj-cli.jar"`, selected via `DJANGO_SETTINGS_MODULE`. The default path already matches option 1 above, so a custom image that installs the JAR at `/opt/mpxj/mpxj-cli.jar` needs no override at all.

The subprocess timeout for MPXJ conversion is fixed at 120 seconds. A timed-out conversion marks the `ImportRequest` row DEAD and reports a clear error in the import summary.

## Import history retention

After every import attempt — successful or failed — TruePPM persists an `ImportRequest` row that powers the [project history](/features/msproject-import-export/#project-history) section on each project Overview and the `GET /projects/{pk}/imports/` endpoint.

| Setting | Default | Unit | What it bounds |
|---|---|---|---|
| `TRUEPPM_IMPORT_RETENTION_DAYS` | `7` | days | How long an `ImportRequest` row (and its uploaded file content) is kept after the import reaches a terminal state. Older rows are removed by the retention purge coordinator (default daily at 02:00 UTC — see [Retention](/administration/retention/)). |

Two reasons to consider tuning this:

- **Lower** — you have a privacy or storage constraint and don't want uploaded file contents lingering. The minimum useful value is `1` (one full day, so an end-of-day import is still visible the next morning); `0` disables retention entirely and is not recommended (it strips the surface that makes a failed import recoverable).
- **Higher** — you want longer ad-hoc visibility of who imported what. Up to ~30 days is reasonable; beyond that, build durable audit on top of the enterprise audit overlay, which consumes the `history_record_created` signal rather than relying on the outbox row.

Keep in mind that the `file_content_b64` column stores the *entire* uploaded file (base64-encoded). A 50 MB upload retained for 30 days under churn can grow the table fast; if you raise this setting, watch table size.

## What's enforced on parsed input

Two boundaries protect the API container from a hostile upload, independent of the size cap:

- **XML entity expansion is disabled.** All MSPDI parsing goes through `defusedxml`, which refuses entity declarations and external-entity resolution. A "billion laughs" or XXE payload is rejected at parse time. This is a hard guarantee — there is no setting to relax it. Verified by `tests/apps/msproject/test_parser_security.py`.
- **Parsed `Duration` values are clamped** to the model's `MaxValueValidator(36_525)` (~100 years). A crafted file encoding `PT9999999999H` would otherwise smuggle astronomical integers past the bulk-create path (which skips Django field validators). The clamp is in the parser helper, so it covers the primary `Duration` field and the three PERT `Duration1`–`Duration3` values uniformly.

Both protections are unit-tested and are not opt-out. They exist because the import surface is **project-admin authenticated, not public** — but project admin is not a security-sensitive role and the file content is user-supplied, so the parser treats every byte as hostile.

## Quick reference

```bash
# Common production values; all four below have safe defaults
MSPROJECT_MAX_UPLOAD_MB=50                  # default
TRUEPPM_IMPORT_RETENTION_DAYS=7             # default
# MPXJ_JAR_PATH defaults to /opt/mpxj/mpxj-cli.jar — Django settings override
# only (no env-var binding); only matters if you support .mpp
# (no env var) defusedxml + duration clamp are unconditional
```

See [MS Project import & export](/features/msproject-import-export/) for the user-facing guide; [Configuration](/administration/configuration/) for the full TruePPM environment-variable reference.

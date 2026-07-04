#!/usr/bin/env bash
#
# backup.sh — take a single timestamped TruePPM backup artifact.
#
# Contents of the artifact (a tarball):
#   - db.dump          PostgreSQL logical backup (pg_dump --format=custom)
#   - media.tar.gz     the attachment/media directory (only when it exists and
#                      is local-disk; object-storage backends are backed up by
#                      the object store itself — see docs/administration/backup-restore.md)
#   - redis.rdb        OPTIONAL Redis/Valkey point-in-time snapshot (only with
#                      --redis AND a readable RDB path). The cache/broker is
#                      reconstructible from PostgreSQL, so it is excluded by
#                      default; see the runbook for the rationale.
#   - MANIFEST         plaintext metadata (timestamp, tool versions, what's inside)
#
# Connection is parameterized entirely through env vars / flags so the same
# script runs against the Docker Compose dev stack AND a Helm-deployed cluster:
#   - Compose:  DATABASE_URL=postgres://trueppm:trueppm@localhost:5432/trueppm ./scripts/backup.sh
#               (or `docker compose exec -T api scripts/backup.sh` inside the api container)
#   - Helm:     runs inside the backup CronJob pod with DATABASE_URL / REDIS_URL
#               injected from the chart-owned connection Secret.
#
# The custom (-Fc) dump format is compressed and lets restore.sh reload
# selectively; it preserves the ltree / pg_trgm extensions and the wbs_path
# GiST index required by the schema.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage: backup.sh [options]

Take a single timestamped TruePPM backup artifact (PostgreSQL + optional media
+ optional Redis snapshot) and write it to the output directory.

Options:
  -o, --output-dir DIR   Directory to write the artifact into (default: ./backups
                         or $TRUEPPM_BACKUP_DIR).
  -d, --db-url URL       PostgreSQL connection URL (default: $DATABASE_URL).
  -m, --media-dir DIR    Local media/attachment directory to include (default:
                         $TRUEPPM_MEDIA_ROOT; skipped when unset or absent).
      --redis            Include a Redis/Valkey snapshot: issue SAVE against
                         --redis-url, then bundle the RDB from --redis-rdb-path
                         if it is readable. Off by default.
      --redis-url URL    Redis/Valkey connection URL (default: $REDIS_URL).
      --redis-rdb-path P Path to the server's dump.rdb to bundle (default:
                         $TRUEPPM_REDIS_RDB_PATH, else /data/dump.rdb).
  -k, --keep-daily N     Prune local *.tar.gz backups in the output dir, keeping
                         the N newest (default: $TRUEPPM_KEEP_DAILY, else no prune).
  -h, --help             Show this help and exit.

Environment variables (flags take precedence):
  DATABASE_URL, REDIS_URL, TRUEPPM_MEDIA_ROOT, TRUEPPM_BACKUP_DIR,
  TRUEPPM_REDIS_RDB_PATH, TRUEPPM_KEEP_DAILY

Exit codes: 0 success; non-zero on any failure (the artifact is only finalized
after every step succeeds — a partial backup is never left behind).
EOF
}

die() {
  echo "$SCRIPT_NAME: error: $*" >&2
  exit 1
}

log() {
  echo "$SCRIPT_NAME: $*"
}

# ---- defaults (env-driven, flag-overridable) -------------------------------
OUTPUT_DIR="${TRUEPPM_BACKUP_DIR:-./backups}"
DB_URL="${DATABASE_URL:-}"
MEDIA_DIR="${TRUEPPM_MEDIA_ROOT:-}"
INCLUDE_REDIS="false"
REDIS_URL_ARG="${REDIS_URL:-}"
REDIS_RDB_PATH="${TRUEPPM_REDIS_RDB_PATH:-/data/dump.rdb}"
KEEP_DAILY="${TRUEPPM_KEEP_DAILY:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output-dir) OUTPUT_DIR="${2:?--output-dir needs a value}"; shift 2 ;;
    -d|--db-url)     DB_URL="${2:?--db-url needs a value}"; shift 2 ;;
    -m|--media-dir)  MEDIA_DIR="${2:?--media-dir needs a value}"; shift 2 ;;
    --redis)         INCLUDE_REDIS="true"; shift ;;
    --redis-url)     REDIS_URL_ARG="${2:?--redis-url needs a value}"; shift 2 ;;
    --redis-rdb-path) REDIS_RDB_PATH="${2:?--redis-rdb-path needs a value}"; shift 2 ;;
    -k|--keep-daily) KEEP_DAILY="${2:?--keep-daily needs a value}"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown argument: $1" ;;
  esac
done

# ---- context detection (informational; connection is via DB_URL) -----------
CONTEXT="host"
if [ -n "${KUBERNETES_SERVICE_HOST:-}" ]; then
  CONTEXT="kubernetes"
elif [ -f /.dockerenv ]; then
  CONTEXT="container"
fi
log "detected run context: $CONTEXT"

# ---- preconditions ---------------------------------------------------------
[ -n "$DB_URL" ] || die "no database URL — set DATABASE_URL or pass --db-url"
command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found (install postgresql-client)"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT="$OUTPUT_DIR/trueppm-backup-$TIMESTAMP.tar.gz"

mkdir -p "$OUTPUT_DIR"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/trueppm-backup.XXXXXX")"
# Always clean up the scratch dir, success or failure — a partial staging tree
# must never leak into the output directory.
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---- 1. PostgreSQL (authoritative) -----------------------------------------
log "waiting for PostgreSQL to accept connections..."
# Pure-shell bounded wait (no GNU `timeout` dependency — it is absent on macOS,
# where an operator may run this against the Docker Compose dev stack).
wait_i=0
until pg_isready --dbname "$DB_URL" >/dev/null 2>&1; do
  wait_i=$((wait_i + 1))
  [ "$wait_i" -ge 30 ] && die "PostgreSQL not reachable after 30s at the configured DATABASE_URL"
  sleep 1
done

log "dumping database (pg_dump --format=custom)..."
# --no-owner / --no-privileges keep the dump role-portable so it restores under
# whatever role owns the target database (the CI role, a fresh Compose stack, or
# the chart-managed prod role) without ALTER OWNER failures.
pg_dump --format=custom --no-owner --no-privileges \
  --dbname "$DB_URL" --file "$WORKDIR/db.dump"
log "database dump: $(du -h "$WORKDIR/db.dump" | cut -f1)"

# ---- 2. Media / attachments (only when local-disk) -------------------------
MEDIA_INCLUDED="no"
if [ -n "$MEDIA_DIR" ] && [ -d "$MEDIA_DIR" ]; then
  if find "$MEDIA_DIR" -mindepth 1 -print -quit | grep -q .; then
    log "archiving media directory: $MEDIA_DIR"
    tar -czf "$WORKDIR/media.tar.gz" -C "$MEDIA_DIR" .
    MEDIA_INCLUDED="yes ($MEDIA_DIR)"
  else
    log "media directory $MEDIA_DIR is empty — skipping"
    MEDIA_INCLUDED="no (empty)"
  fi
elif [ -n "$MEDIA_DIR" ]; then
  log "media directory $MEDIA_DIR does not exist — skipping"
  MEDIA_INCLUDED="no (absent)"
else
  log "no media directory configured (object-storage backend?) — skipping media; see runbook"
  MEDIA_INCLUDED="no (not configured)"
fi

# ---- 3. Redis / Valkey snapshot (opt-in, best-effort) ----------------------
REDIS_INCLUDED="no"
if [ "$INCLUDE_REDIS" = "true" ]; then
  [ -n "$REDIS_URL_ARG" ] || die "--redis given but no Redis URL — set REDIS_URL or pass --redis-url"
  command -v redis-cli >/dev/null 2>&1 || die "--redis given but redis-cli not found"
  log "issuing SAVE against Redis/Valkey..."
  redis-cli -u "$REDIS_URL_ARG" SAVE >/dev/null || die "Redis SAVE failed"
  if [ -r "$REDIS_RDB_PATH" ]; then
    cp "$REDIS_RDB_PATH" "$WORKDIR/redis.rdb"
    REDIS_INCLUDED="yes ($REDIS_RDB_PATH)"
    log "bundled Redis RDB from $REDIS_RDB_PATH"
  else
    # The SAVE persisted the snapshot on the Redis server's own volume, but this
    # process cannot read the RDB file to bundle it. That is expected for a
    # remote Redis; the cache/broker is reconstructible, so we do not fail.
    REDIS_INCLUDED="no (SAVE issued; RDB at $REDIS_RDB_PATH not readable here)"
    log "Redis RDB not readable at $REDIS_RDB_PATH — SAVE issued server-side, RDB not bundled"
  fi
fi

# ---- 4. Manifest + finalize ------------------------------------------------
{
  echo "TruePPM backup manifest"
  echo "created_utc: $TIMESTAMP"
  echo "run_context: $CONTEXT"
  echo "pg_dump_version: $(pg_dump --version | head -n1)"
  echo "db_included: yes"
  echo "media_included: $MEDIA_INCLUDED"
  echo "redis_included: $REDIS_INCLUDED"
} > "$WORKDIR/MANIFEST"

log "creating artifact: $ARTIFACT"
tar -czf "$ARTIFACT" -C "$WORKDIR" .
log "backup complete: $ARTIFACT ($(du -h "$ARTIFACT" | cut -f1))"

# ---- 5. Local retention prune (optional) -----------------------------------
if [ -n "$KEEP_DAILY" ]; then
  case "$KEEP_DAILY" in
    ''|*[!0-9]*) die "--keep-daily must be a non-negative integer, got: $KEEP_DAILY" ;;
  esac
  log "pruning local backups, keeping the $KEEP_DAILY newest in $OUTPUT_DIR"
  # Artifact names embed a UTC timestamp (trueppm-backup-YYYYmmddTHHMMSSZ.tar.gz)
  # that sorts lexicographically in chronological order and contains no spaces,
  # so a plain name sort is a safe newest-first ordering with no GNU-only find
  # flags. Skip the N newest, delete the rest. The glob only matches our own
  # timestamped artifacts (no spaces), so `ls` is safe here (SC2012 accepted).
  # shellcheck disable=SC2012
  ls -1 "$OUTPUT_DIR"/trueppm-backup-*.tar.gz 2>/dev/null \
    | sort -r \
    | tail -n "+$((KEEP_DAILY + 1))" \
    | while IFS= read -r f; do
        log "pruning old backup: $f"
        rm -f "$f"
      done
fi

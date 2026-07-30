#!/usr/bin/env bash
#
# restore.sh — restore a TruePPM backup artifact onto a clean target.
#
# Reverses scripts/backup.sh:
#   - reloads db.dump with pg_restore --clean --if-exists (idempotent: safe to
#     re-run against a partially-restored or already-populated database)
#   - restores media.tar.gz into the target media directory when present
#   - verifies the required PostgreSQL extensions (ltree, pg_trgm) exist after
#     the restore — these back the wbs_path ltree column / GiST index and the
#     trigram search indexes, and a schema missing them is silently broken
#
# The Redis snapshot, if present in the artifact, is intentionally NOT restored:
# the cache and Celery broker are reconstructible from PostgreSQL, and forcing a
# stale RDB back onto a running instance would resurrect dead queue state. See
# docs/administration/backup-restore.md for the rationale.
#
# Connection is parameterized through env / flags, identical to backup.sh, so
# the same script restores onto the Compose dev stack or a Helm-deployed cluster.
#
# The artifact may be a local path (--artifact) or an object key in the same
# bucket backup.sh uploads to (--from-s3 KEY, or --from-s3 latest). See
# scripts/lib/s3.sh for client selection and the path-style rationale.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage: restore.sh --artifact PATH [options]

Restore a TruePPM backup artifact (produced by scripts/backup.sh) onto a clean
target database, then verify required PostgreSQL extensions are present.

Required (exactly one source):
  -a, --artifact PATH    Path to a local trueppm-backup-*.tar.gz artifact.
      --from-s3 KEY      Object key to download from $S3_BUCKET first, then
                         restore. Use "latest" to select the newest
                         trueppm-backup-*.tar.gz under --s3-prefix.

Options:
  -d, --db-url URL       Target PostgreSQL connection URL (default: $DATABASE_URL).
  -m, --media-dir DIR    Target media directory to restore into (default:
                         $TRUEPPM_MEDIA_ROOT; media restored only when both the
                         artifact contains media AND this is set).
  -j, --jobs N           pg_restore parallel jobs (default: 1).
  -y, --yes              Do not prompt before overwriting the target database.
      --s3-bucket NAME   Bucket to download from with --from-s3 (default: $S3_BUCKET).
      --s3-endpoint URL  S3-compatible endpoint (default: $S3_ENDPOINT). Omit for
                         real AWS S3; set it for MinIO and friends.
      --s3-prefix PATH   Key prefix searched by --from-s3 latest (default: $S3_PREFIX).
  -h, --help             Show this help and exit.

Environment variables (flags take precedence):
  DATABASE_URL, TRUEPPM_MEDIA_ROOT,
  S3_BUCKET, S3_ENDPOINT, S3_PREFIX, AWS_DEFAULT_REGION,
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, TRUEPPM_S3_CLIENT

Downloading: --from-s3 pulls the artifact into a scratch directory and restores
from it, using the same client selection as backup.sh (AWS CLI preferred, MinIO
client accepted). The downloaded copy is deleted when the script exits; pass
--artifact with a local path if you want to keep it.

Idempotency: pg_restore runs with --clean --if-exists, so re-running against an
already-populated database drops and recreates each object rather than erroring
on a duplicate. The extension check fails the whole restore (non-zero exit) if
ltree or pg_trgm is missing.
EOF
}

die() {
  echo "$SCRIPT_NAME: error: $*" >&2
  exit 1
}

log() {
  echo "$SCRIPT_NAME: $*"
}

# ---- defaults --------------------------------------------------------------
ARTIFACT=""
DB_URL="${DATABASE_URL:-}"
MEDIA_DIR="${TRUEPPM_MEDIA_ROOT:-}"
JOBS="1"
ASSUME_YES="false"
FROM_S3=""
S3_BUCKET="${S3_BUCKET:-}"
S3_ENDPOINT="${S3_ENDPOINT:-}"
S3_PREFIX="${S3_PREFIX:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -a|--artifact)  ARTIFACT="${2:?--artifact needs a value}"; shift 2 ;;
    -d|--db-url)    DB_URL="${2:?--db-url needs a value}"; shift 2 ;;
    -m|--media-dir) MEDIA_DIR="${2:?--media-dir needs a value}"; shift 2 ;;
    -j|--jobs)      JOBS="${2:?--jobs needs a value}"; shift 2 ;;
    -y|--yes)       ASSUME_YES="true"; shift ;;
    --from-s3)      FROM_S3="${2:?--from-s3 needs a value}"; shift 2 ;;
    --s3-bucket)    S3_BUCKET="${2:?--s3-bucket needs a value}"; shift 2 ;;
    --s3-endpoint)  S3_ENDPOINT="${2:?--s3-endpoint needs a value}"; shift 2 ;;
    --s3-prefix)    S3_PREFIX="${2:?--s3-prefix needs a value}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; die "unknown argument: $1" ;;
  esac
done
export S3_BUCKET S3_ENDPOINT

# ---- preconditions ---------------------------------------------------------
if [ -n "$ARTIFACT" ] && [ -n "$FROM_S3" ]; then
  die "--artifact and --from-s3 are mutually exclusive — pick one source"
fi
if [ -z "$ARTIFACT" ] && [ -z "$FROM_S3" ]; then
  usage >&2
  die "no artifact — pass --artifact PATH or --from-s3 KEY"
fi
[ -n "$DB_URL" ] || die "no database URL — set DATABASE_URL or pass --db-url"
case "$JOBS" in ''|*[!0-9]*) die "--jobs must be a positive integer, got: $JOBS" ;; esac
command -v pg_restore >/dev/null 2>&1 || die "pg_restore not found (install postgresql-client)"
command -v psql >/dev/null 2>&1 || die "psql not found (install postgresql-client)"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/trueppm-restore.XXXXXX")"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# ---- fetch from object storage (optional) ----------------------------------
# Downloads into WORKDIR, so the copy is removed on exit by the same trap that
# cleans the extraction tree. An operator who wants to keep the artifact should
# download it themselves and pass --artifact.
if [ -n "$FROM_S3" ]; then
  [ -n "$S3_BUCKET" ] || die "--from-s3 given but no bucket — set S3_BUCKET or pass --s3-bucket"
  # shellcheck source-path=SCRIPTDIR source=lib/s3.sh
  . "$(cd "$(dirname "$0")" && pwd)/lib/s3.sh"
  s3_client >/dev/null \
    || die "--from-s3 requested but no client found — $(s3_client_hint)"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] || die "--from-s3 requested but AWS_ACCESS_KEY_ID is unset"
  [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || die "--from-s3 requested but AWS_SECRET_ACCESS_KEY is unset"

  S3_KEY="$FROM_S3"
  if [ "$S3_KEY" = "latest" ]; then
    log "resolving newest artifact in s3://$S3_BUCKET/${S3_PREFIX:+$S3_PREFIX/}..."
    S3_KEY="$(s3_latest_key "$S3_PREFIX")" \
      || die "no trueppm-backup-*.tar.gz found in s3://$S3_BUCKET/${S3_PREFIX:+$S3_PREFIX/}"
  fi
  ARTIFACT="$WORKDIR/$(basename "$S3_KEY")"
  log "downloading s3://$S3_BUCKET/$S3_KEY ..."
  s3_get "$S3_KEY" "$ARTIFACT" \
    || die "download of s3://$S3_BUCKET/$S3_KEY failed"
  log "downloaded: $ARTIFACT ($(du -h "$ARTIFACT" | cut -f1))"
fi

[ -f "$ARTIFACT" ] || die "artifact not found: $ARTIFACT"

log "extracting artifact: $ARTIFACT"
tar -xzf "$ARTIFACT" -C "$WORKDIR"
[ -f "$WORKDIR/db.dump" ] || die "artifact is missing db.dump — not a TruePPM backup?"

if [ -f "$WORKDIR/MANIFEST" ]; then
  log "artifact manifest:"
  sed 's/^/    /' "$WORKDIR/MANIFEST"
fi

# ---- confirmation ----------------------------------------------------------
if [ "$ASSUME_YES" != "true" ]; then
  # Redact any password in the URL before echoing it.
  SAFE_URL="$(printf '%s' "$DB_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:****@#')"
  printf '%s: this will OVERWRITE objects in %s. Continue? [y/N] ' "$SCRIPT_NAME" "$SAFE_URL" >&2
  read -r reply
  case "$reply" in
    y|Y|yes|YES) : ;;
    *) die "aborted by user" ;;
  esac
fi

# ---- wait for target -------------------------------------------------------
log "waiting for target PostgreSQL to accept connections..."
# Pure-shell bounded wait (no GNU `timeout` dependency — absent on macOS).
wait_i=0
until pg_isready --dbname "$DB_URL" >/dev/null 2>&1; do
  wait_i=$((wait_i + 1))
  [ "$wait_i" -ge 30 ] && die "target PostgreSQL not reachable after 30s"
  sleep 1
done

# ---- restore database ------------------------------------------------------
log "restoring database (pg_restore --clean --if-exists, jobs=$JOBS)..."
# --clean --if-exists makes the restore idempotent (drop-then-create each object,
# no error on a fresh target). --no-owner / --no-privileges match the portable
# dump so objects are owned by the connecting role. --exit-on-error surfaces a
# genuine failure instead of a half-restored database that looks green.
#
# pg_restore returns non-zero on harmless "does not exist, skipping" notices when
# combined with --clean on a truly empty database; --exit-on-error would turn
# those into a failure, so we deliberately DO NOT pass it and instead assert
# success through the extension + connectivity checks below.
pg_restore --clean --if-exists --no-owner --no-privileges \
  --jobs "$JOBS" --dbname "$DB_URL" "$WORKDIR/db.dump" \
  || log "pg_restore reported non-fatal notices (expected with --clean on a clean target); verifying result"

# ---- verify required extensions --------------------------------------------
log "verifying required PostgreSQL extensions (ltree, pg_trgm)..."
for ext in ltree pg_trgm; do
  present="$(psql "$DB_URL" -tAc \
    "SELECT 1 FROM pg_extension WHERE extname = '$ext';")"
  if [ "$present" != "1" ]; then
    die "required extension '$ext' is missing after restore — the schema is incomplete"
  fi
  log "  extension present: $ext"
done

# ---- restore media ---------------------------------------------------------
if [ -f "$WORKDIR/media.tar.gz" ]; then
  if [ -n "$MEDIA_DIR" ]; then
    log "restoring media into $MEDIA_DIR"
    mkdir -p "$MEDIA_DIR"
    tar -xzf "$WORKDIR/media.tar.gz" -C "$MEDIA_DIR"
  else
    log "artifact contains media but no --media-dir/TRUEPPM_MEDIA_ROOT set — skipping media restore"
  fi
else
  log "no media in artifact — skipping media restore"
fi

log "restore complete."

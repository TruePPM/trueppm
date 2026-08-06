#!/usr/bin/env bash
# scripts/tests/backup-s3.test.sh
#
# Unit test for scripts/lib/s3.sh — the off-cluster upload path backup.sh and
# restore.sh share (#2611). Before this, the chart injected a full S3 env
# contract and the job answered it with an `echo`, so "backups are off-cluster"
# was true in the runbook and false in the cluster. These cases pin the parts of
# that path that are easy to regress and invisible when they break.
#
# No network and no object store: `aws` and `mc` are replaced with stubs on PATH
# that record their argv and the environment they were invoked with. That makes
# the *shape* of the request assertable — which is where the real bugs live
# (addressing style, key construction, credential handling). The genuine
# end-to-end proof against a live MinIO is the backup:s3-drill CI job.
#
# Run: bash scripts/tests/backup-s3.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/s3.sh"
BACKUP="$REPO_ROOT/scripts/backup.sh"
RESTORE="$REPO_ROOT/scripts/restore.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
check() { # check "<description>" <condition-exit-code>
  local desc="$1" rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    pass=$((pass + 1))
  else
    echo "  FAIL: $desc"
    fail=$((fail + 1))
  fi
}

# A stub bin dir holding fake clients that log invocation + relevant env.
STUB="$TMP/bin"
mkdir -p "$STUB"
LOG="$TMP/calls.log"

cat > "$STUB/aws" <<'STUBEOF'
#!/usr/bin/env bash
{
  echo "ARGV: $*"
  echo "ENV_ADDRESSING: ${AWS_S3_ADDRESSING_STYLE:-<unset>}"
  echo "ENV_KEY: ${AWS_ACCESS_KEY_ID:-<unset>}"
  echo "ENV_SECRET: ${AWS_SECRET_ACCESS_KEY:-<unset>}"
} >> "$STUB_LOG"
# `s3api list-objects-v2` is the only call whose stdout is parsed.
case "$*" in
  *list-objects-v2*)
    printf 'p/trueppm-backup-20260101T000000Z.tar.gz\tp/trueppm-backup-20260715T090000Z.tar.gz\tp/notes.txt\n'
    ;;
esac
exit 0
STUBEOF

cat > "$STUB/mc" <<'STUBEOF'
#!/usr/bin/env bash
{
  echo "ARGV: $*"
  # MC_HOST_* is the trap this test exists to prevent — record any that leak in.
  echo "ENV_MC_HOST: $(env | grep -c '^MC_HOST_' || true)"
} >> "$STUB_LOG"
exit 0
STUBEOF
chmod +x "$STUB/aws" "$STUB/mc"
export STUB_LOG="$LOG"

reset_log() { : > "$LOG"; }

# --- 1. aws is preferred, endpoint + path-style are forced -------------------
(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio.local:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY='ab/cd+ef:gh'
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  reset_log
  echo data > "$TMP/art.tar.gz"
  s3_put "$TMP/art.tar.gz" "prod/art.tar.gz"
)
check "aws is chosen when both clients are installed" \
  "$(grep -q 'ARGV: --endpoint-url http://minio.local:9000 s3 cp' "$LOG" && echo 0 || echo 1)"
check "custom endpoint forces path-style addressing" \
  "$(grep -q 'ENV_ADDRESSING: path' "$LOG" && echo 0 || echo 1)"
check "object key is bucket-relative and keeps the given prefix" \
  "$(grep -q 's3://bk/prod/art.tar.gz' "$LOG" && echo 0 || echo 1)"
# The regression this guards: a secret containing / + : must survive verbatim.
# Routing it through a URL (as MC_HOST does) corrupts the signature.
check "secret reaches the client verbatim, not URL-encoded" \
  "$(grep -q 'ENV_SECRET: ab/cd+ef:gh' "$LOG" && echo 0 || echo 1)"

# --- 2. no custom endpoint (real AWS) must NOT force path-style --------------
(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  unset S3_ENDPOINT
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  reset_log
  echo data > "$TMP/art.tar.gz"
  s3_put "$TMP/art.tar.gz" "art.tar.gz"
)
check "no endpoint means no --endpoint-url flag" \
  "$(grep -q -- '--endpoint-url' "$LOG" && echo 1 || echo 0)"
check "real AWS keeps virtual-hosted addressing (path-style not forced)" \
  "$(grep -q 'ENV_ADDRESSING: <unset>' "$LOG" && echo 0 || echo 1)"

# --- 3. mc path uses `alias set` argv and never MC_HOST_* --------------------
(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio.local:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY='ab/cd+ef:gh'
  export TRUEPPM_S3_CLIENT=mc MC_CONFIG_DIR="$TMP/mcconf"
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  reset_log
  echo data > "$TMP/art.tar.gz"
  s3_put "$TMP/art.tar.gz" "art.tar.gz"
)
check "TRUEPPM_S3_CLIENT=mc overrides the aws preference" \
  "$(grep -q 'ARGV: --quiet cp' "$LOG" && echo 0 || echo 1)"
check "mc credentials go through 'alias set' argv" \
  "$(grep -q "ARGV: --quiet alias set trueppm http://minio.local:9000 key ab/cd+ef:gh" "$LOG" && echo 0 || echo 1)"
# MC_HOST_<alias> URLs silently break on secrets containing / + : — verified
# against MinIO: raw gives "security token invalid", percent-encoded gives a
# signature mismatch. The lib must never construct one.
check "no MC_HOST_* env var is ever constructed" \
  "$(grep -q 'ENV_MC_HOST: 0' "$LOG" && echo 0 || echo 1)"

# --- 4. s3_latest_key picks the newest artifact, ignoring other objects ------
reset_log
LATEST="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio.local:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  s3_latest_key "p"
)"
check "s3_latest_key returns the chronologically newest artifact" \
  "$([ "$LATEST" = "p/trueppm-backup-20260715T090000Z.tar.gz" ] && echo 0 || echo 1)"
# Argument ORDER, not just presence. --endpoint-url is a global option and must
# precede the subcommand; --prefix belongs to `s3api list-objects-v2` and must
# follow it. Getting that backwards makes the CLI reject the call, and because
# stderr is discarded the failure is indistinguishable from an empty bucket —
# `restore.sh --from-s3 latest` then reports "no artifact found" on a bucket
# that is full. A presence-only assertion does not catch it.
check "--endpoint-url precedes the s3api subcommand" \
  "$(grep -qE 'ARGV: --endpoint-url [^ ]+ s3api list-objects-v2' "$LOG" && echo 0 || echo 1)"
check "--prefix follows the s3api subcommand" \
  "$(grep -qE 's3api list-objects-v2 .*--prefix' "$LOG" && echo 0 || echo 1)"
check "the listed prefix is slash-terminated" \
  "$(grep -q -- '--prefix p/' "$LOG" && echo 0 || echo 1)"

# An empty prefix must search the whole bucket, not for keys starting with "/".
reset_log
(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio.local:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  s3_latest_key "" >/dev/null
)
check "an empty prefix does not become a literal leading slash" \
  "$(grep -q -- '--prefix /' "$LOG" && echo 1 || echo 0)"

# --- 4b. remote plaintext endpoint warning (#2650) --------------------------
# The artifact is a full pg_dump; http:// to anything that doesn't look
# in-cluster must warn (stderr, non-blocking) — but never for the documented
# in-cluster shape, and never when the operator opts out.
reset_log
OUT="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://backup.example.com:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  echo data > "$TMP/art2.tar.gz"
  s3_put "$TMP/art2.tar.gz" "art2.tar.gz" 2>&1 >/dev/null
)"
check "a remote plaintext endpoint warns on stderr" \
  "$(echo "$OUT" | grep -q 'WARNING.*S3_ENDPOINT' && echo 0 || echo 1)"
check "the warning names the offending endpoint" \
  "$(echo "$OUT" | grep -q 'http://backup.example.com:9000' && echo 0 || echo 1)"
check "the upload still proceeds (warning does not block)" \
  "$(grep -q 'ARGV: --endpoint-url http://backup.example.com:9000 s3 cp' "$LOG" && echo 0 || echo 1)"
# The only clear-text URL in the warning must be the endpoint it is reporting
# (#2712). The original wording also spelled the scheme out as a parenthetical,
# which shell:S5332 matched inside the quoted string and raised as a clear-text
# -protocol vulnerability ON THE WARNING THAT DISCOURAGES PLAINTEXT. That was
# not excluded in sonar-project.properties, because scripts/lib/s3.sh is exactly
# where a genuine hard-coded plaintext endpoint would need to be caught — so the
# wording is what holds the finding closed, and this case is what holds the
# wording. Strip the interpolated endpoint and nothing clear-text may remain
# ("https://" does not contain the substring "http://", so the recommendation on
# the next line is not a match).
check "the warning carries no clear-text scheme literal of its own" \
  "$(echo "$OUT" | sed 's#http://backup.example.com:9000##g' | grep -q 'http://' && echo 1 || echo 0)"

# The in-cluster CronJob cannot source this library (a Helm template reaches
# nothing outside the chart, and the job mounts no repo), so it reimplements the
# same heuristic inline — the template says so and asks for the two to be kept in
# sync. That makes it the one place the #2712 wording can come back unnoticed:
# Sonar's shell analyzer never reads a script embedded in YAML, so a
# reintroduction there is invisible to the gate that caught it here.
CRONJOB="$REPO_ROOT/packages/helm/templates/cronjob-backup.yaml"
check "the chart's duplicated warning also carries no clear-text scheme literal" \
  "$(grep 'WARNING: S3_ENDPOINT' "$CRONJOB" | grep -q 'http://' && echo 1 || echo 0)"

reset_log
OUT="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  echo data > "$TMP/art3.tar.gz"
  s3_put "$TMP/art3.tar.gz" "art3.tar.gz" 2>&1 >/dev/null
)"
check "a bare in-cluster short name (minio) does not warn" \
  "$([ -z "$OUT" ] && echo 0 || echo 1)"

reset_log
OUT="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://minio.default.svc.cluster.local:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  echo data > "$TMP/art4.tar.gz"
  s3_put "$TMP/art4.tar.gz" "art4.tar.gz" 2>&1 >/dev/null
)"
check "a fully-qualified in-cluster Service DNS name does not warn" \
  "$([ -z "$OUT" ] && echo 0 || echo 1)"

reset_log
OUT="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="http://backup.example.com:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  export TRUEPPM_S3_ALLOW_PLAINTEXT=1
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  echo data > "$TMP/art5.tar.gz"
  s3_put "$TMP/art5.tar.gz" "art5.tar.gz" 2>&1 >/dev/null
)"
check "TRUEPPM_S3_ALLOW_PLAINTEXT=1 silences the warning" \
  "$([ -z "$OUT" ] && echo 0 || echo 1)"

reset_log
OUT="$(
  export PATH="$STUB:$PATH"
  export S3_BUCKET=bk S3_ENDPOINT="https://backup.example.com:9000"
  export AWS_ACCESS_KEY_ID=key AWS_SECRET_ACCESS_KEY=sec
  # shellcheck source=../lib/s3.sh
  . "$LIB"
  echo data > "$TMP/art6.tar.gz"
  s3_put "$TMP/art6.tar.gz" "art6.tar.gz" 2>&1 >/dev/null
)"
check "a remote https endpoint does not warn" \
  "$([ -z "$OUT" ] && echo 0 || echo 1)"

# --- 5. a configured bucket with no client fails fast, before pg_dump --------
# The whole point of the fix: never complete a run that was asked to go
# off-cluster but silently could not.
ONLYPG="$TMP/onlypg"
mkdir -p "$ONLYPG"
for tool in pg_dump pg_isready pg_restore psql; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$ONLYPG/$tool"
  chmod +x "$ONLYPG/$tool"
done
set +e
OUT="$(PATH="$ONLYPG:/usr/bin:/bin" S3_BUCKET=bk AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s \
  bash "$BACKUP" --db-url "postgres://x/y" -o "$TMP/out" 2>&1)"
RC=$?
set -e
check "bucket set with no aws/mc installed exits non-zero" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "the failure names both supported clients" \
  "$(echo "$OUT" | grep -q 'aws' && echo "$OUT" | grep -q 'mc' && echo 0 || echo 1)"
check "it fails before dumping anything" \
  "$(echo "$OUT" | grep -q 'dumping database' && echo 1 || echo 0)"

# --- 6. missing credentials fail fast too -----------------------------------
set +e
OUT="$(PATH="$STUB:$ONLYPG:/usr/bin:/bin" S3_BUCKET=bk \
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
  bash "$BACKUP" --db-url "postgres://x/y" -o "$TMP/out" 2>&1)"
RC=$?
set -e
check "bucket set with no credentials exits non-zero" "$([ "$RC" -ne 0 ] && echo 0 || echo 1)"
check "the credential failure names AWS_ACCESS_KEY_ID" \
  "$(echo "$OUT" | grep -q 'AWS_ACCESS_KEY_ID' && echo 0 || echo 1)"

# --- 7. restore.sh source selection -----------------------------------------
set +e
OUT="$(bash "$RESTORE" --artifact /tmp/a.tar.gz --from-s3 latest --db-url postgres://x/y 2>&1)"
RC=$?
set -e
check "--artifact and --from-s3 together are rejected" \
  "$([ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'mutually exclusive' && echo 0 || echo 1)"

set +e
OUT="$(bash "$RESTORE" --db-url postgres://x/y 2>&1)"
RC=$?
set -e
check "neither source given is rejected" \
  "$([ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'from-s3' && echo 0 || echo 1)"

set +e
OUT="$(PATH="$STUB:$ONLYPG:/usr/bin:/bin" AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s \
  env -u S3_BUCKET bash "$RESTORE" --from-s3 latest --db-url postgres://x/y 2>&1)"
RC=$?
set -e
check "--from-s3 without a bucket is rejected" \
  "$([ "$RC" -ne 0 ] && echo "$OUT" | grep -q 'bucket' && echo 0 || echo 1)"

# --- results ----------------------------------------------------------------
echo
echo "backup-s3.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]] || exit 1

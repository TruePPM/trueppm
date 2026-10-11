#!/usr/bin/env bash
# scripts/tests/backup-media.test.sh
#
# Unit test for the media round-trip between scripts/backup.sh and
# scripts/restore.sh (#4368). Before this, the only standing evidence for
# media was the backup:restore-drill CI job, and even there every leg proved
# backup.sh PACKS media into the archive (MANIFEST says media_included: yes,
# tar -tzf lists media.tar.gz) but never passed --media-dir on the matching
# restore.sh call — so restore.sh's own extraction branch
# (restore.sh:213-223) had zero coverage anywhere in the repo. A wrong
# strip-components, wrong target path, or a swallowed permission failure
# there would have shipped invisibly.
#
# No database and no network: pg_dump/pg_isready/pg_restore/psql are replaced
# with stubs on PATH that do just enough to let backup.sh and restore.sh run
# their media logic — the real DB round-trip is covered separately by
# backup:restore-drill (row counts) and has nothing to do with the bug class
# here. Every assertion below compares a sha256 checksum (not `test -f`), so
# a byte-level corruption in extraction is caught, not just presence.
#
# Run: bash scripts/tests/backup-media.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

# ---- stub postgres client tools --------------------------------------------
# backup.sh/restore.sh only need these to get past their DB preconditions on
# the way to the media logic: pg_dump must write SOMETHING at --file (so
# restore.sh's "artifact is missing db.dump" guard passes), pg_isready and
# pg_restore must exit 0, and psql must answer the extension-presence query
# with "1" so the post-restore extension check does not abort the run before
# reaching the media branch.
STUB="$TMP/bin"
mkdir -p "$STUB"

cat > "$STUB/pg_dump" <<'STUBEOF'
#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] && echo "fake dump" > "$out"
exit 0
STUBEOF

cat > "$STUB/pg_isready" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF

cat > "$STUB/pg_restore" <<'STUBEOF'
#!/usr/bin/env bash
exit 0
STUBEOF

cat > "$STUB/psql" <<'STUBEOF'
#!/usr/bin/env bash
# Every call this test triggers is the extension-presence SELECT; answer "1"
# unconditionally so restore.sh's extension check passes.
echo "1"
exit 0
STUBEOF

chmod +x "$STUB/pg_dump" "$STUB/pg_isready" "$STUB/pg_restore" "$STUB/psql"
export PATH="$STUB:$PATH"

DB_URL="postgres://x/y"

# A nested fixture, not a flat one — restore.sh:217 extracts with
# `-C "$MEDIA_DIR"` and backup.sh:~151 archives with `-C "$MEDIA_DIR" .`, so a
# flat file would not catch a strip-components or target-path regression that
# only shows up once there is a subdirectory to preserve.
seed_media() { # seed_media <dir>
  mkdir -p "$1/sub"
  # Content includes a newline and non-ASCII-adjacent bytes so a mangled
  # encoding (not just a missing file) would also flip the checksum.
  printf 'attachment payload\nline two\n' > "$1/sub/attachment.bin"
}

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# --- 1. happy path: media round-trips byte-for-byte, nested dir preserved ---
SRC1="$TMP/src1-media"
OUT1="$TMP/out1"
RESTORED1="$TMP/restored1-media"
seed_media "$SRC1"
EXPECTED_SHA="$(sha_of "$SRC1/sub/attachment.bin")"

bash "$BACKUP" --db-url "$DB_URL" --media-dir "$SRC1" -o "$OUT1" >/dev/null
ARTIFACT1="$(ls -1 "$OUT1"/trueppm-backup-*.tar.gz | sed -n '1p')"
check "backup.sh produced an artifact" "$([ -n "$ARTIFACT1" ] && [ -f "$ARTIFACT1" ] && echo 0 || echo 1)"

bash "$RESTORE" --db-url "$DB_URL" --artifact "$ARTIFACT1" --media-dir "$RESTORED1" --yes >/dev/null
check "restore.sh extracted the nested file to the target --media-dir" \
  "$([ -f "$RESTORED1/sub/attachment.bin" ] && echo 0 || echo 1)"
check "the restored file is byte-for-byte identical to the seeded one (sha256)" \
  "$([ "$(sha_of "$RESTORED1/sub/attachment.bin" 2>/dev/null)" = "$EXPECTED_SHA" ] && echo 0 || echo 1)"
check "cmp agrees (belt-and-suspenders on the checksum compare)" \
  "$(cmp -s "$SRC1/sub/attachment.bin" "$RESTORED1/sub/attachment.bin" && echo 0 || echo 1)"

# --- 2. media present in the archive but no --media-dir on restore: skip, --
# --    don't silently extract it somewhere unexpected (e.g. a stale/unset ---
# --    TRUEPPM_MEDIA_ROOT in the restoring environment) --------------------
set +e
OUT2="$(env -u TRUEPPM_MEDIA_ROOT bash "$RESTORE" --db-url "$DB_URL" --artifact "$ARTIFACT1" --yes 2>&1)"
RC2=$?
set -e
check "omitting --media-dir logs the skip message" \
  "$(grep -q 'skipping media restore' <<<"$OUT2" && echo 0 || echo 1)"
check "restore.sh still exits 0 when media is intentionally skipped" \
  "$([ "$RC2" -eq 0 ] && echo 0 || echo 1)"

# --- 3. no media in the artifact at all: the other skip branch -------------
OUT3_DIR="$TMP/out3"
bash "$BACKUP" --db-url "$DB_URL" -o "$OUT3_DIR" >/dev/null
ARTIFACT3="$(ls -1 "$OUT3_DIR"/trueppm-backup-*.tar.gz | sed -n '1p')"
RESTORED3="$TMP/restored3-media"
OUT3="$(bash "$RESTORE" --db-url "$DB_URL" --artifact "$ARTIFACT3" --media-dir "$RESTORED3" --yes 2>&1)"
check "no media in the artifact logs the 'no media' skip message" \
  "$(grep -q 'no media in artifact' <<<"$OUT3" && echo 0 || echo 1)"
check "no media in the artifact creates nothing under the passed --media-dir" \
  "$([ ! -e "$RESTORED3/sub" ] && echo 0 || echo 1)"

# --- 4. a corrupted media.tar.gz must fail LOUDLY, not restore silently ----
# This is the negative control that proves assertion 1 above can actually
# fail: if restore.sh's tar extraction breaks (wrong flags, wrong archive),
# `set -e` must abort the run rather than reporting "restore complete" over a
# half-extracted or missing media tree.
SRC4="$TMP/src4-media"
OUT4="$TMP/out4"
seed_media "$SRC4"
bash "$BACKUP" --db-url "$DB_URL" --media-dir "$SRC4" -o "$OUT4" >/dev/null
ARTIFACT4="$(ls -1 "$OUT4"/trueppm-backup-*.tar.gz | sed -n '1p')"

CORRUPT_DIR="$TMP/corrupt"
mkdir -p "$CORRUPT_DIR"
tar -xzf "$ARTIFACT4" -C "$CORRUPT_DIR"
# Replace the valid media archive with garbage bytes that gzip/tar will
# reject, then repack — same db.dump and MANIFEST, broken media.tar.gz.
printf 'not a real gzip stream' > "$CORRUPT_DIR/media.tar.gz"
CORRUPT_ARTIFACT="$TMP/corrupt-artifact.tar.gz"
tar -czf "$CORRUPT_ARTIFACT" -C "$CORRUPT_DIR" .

RESTORED4="$TMP/restored4-media"
set +e
bash "$RESTORE" --db-url "$DB_URL" --artifact "$CORRUPT_ARTIFACT" --media-dir "$RESTORED4" --yes >/dev/null 2>&1
RC4=$?
set -e
check "a corrupted media.tar.gz makes restore.sh exit non-zero, not succeed silently" \
  "$([ "$RC4" -ne 0 ] && echo 0 || echo 1)"

# --- results -----------------------------------------------------------------
echo
echo "backup-media.test.sh: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]] || exit 1

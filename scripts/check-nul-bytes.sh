#!/usr/bin/env bash
# scripts/check-nul-bytes.sh — every tracked file git resolves to `text: set`
# must contain zero 0x00 bytes (#3601).
#
# A literal NUL byte sat in a `buildSubgraph.ts` template literal (used as a NUL-joined dedup key delimiter) for long enough to go unnoticed, because
# a NUL makes git classify the WHOLE FILE as binary regardless of what
# .gitattributes says: `git diff` prints "Binary files a/... and b/... differ"
# instead of a line, `git grep` finds nothing inside it, and a BSD/macOS `grep`
# sweep across the tree returns a FALSE CLEAN rather than an error. Anyone
# grepping for a string that happened to live in that file — a rename sweep,
# an audit, a "does X still reference Y" check — got a silent negative.
#
# Rule: a file the repo EXPLICITLY declares text (`.gitattributes` resolves
# `text` to `set`) must contain no raw 0x00 byte. Two other buckets exist and
# are deliberately OUT of scope, not silently skipped:
#
#   - `unset` (`-text` / `binary`) — 37 files today, mostly the encoding
#     fixtures under packages/api/tests/apps/{csvimport,projects}/files/*.csv
#     whose UTF-16 NUL bytes ARE the test (#2892, #2937). Flagging those would
#     be flagging the fixture for doing its job.
#   - `auto` (repo default `* text=auto`, no more specific rule) — 128 files
#     today (.rs, .mjs, Dockerfile, .webp, …). `auto` means "let git's own
#     text/binary heuristic decide" — a NUL there is git's heuristic working,
#     not a declaration being contradicted. Widening this gate to cover `auto`
#     is a real option but a separate scope decision; this gate does not make
#     it silently.
#
# Enumeration is from the INDEX (`git ls-files`), never a filesystem walk — a
# tree-walking gate reds `make pre-push` on a gitignored file that was never a
# candidate in the first place.
#
# python3 does the byte scan: BusyBox tooling in the CI alpine image is
# unreliable for this (see check-playwright-pins.sh's header), and reading the
# file as raw bytes rather than text sidesteps any encoding-detection games.
#
# Usage:
#   scripts/check-nul-bytes.sh              # scan the tracked tree
#   scripts/check-nul-bytes.sh --self-test  # prove the check can still fail

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Classify every tracked file in git worktree `$1` and byte-scan the ones
# resolved `text: set`, printing one "  VIOLATION: ..." line per NUL byte
# found. `git ls-files -z | git check-attr --stdin -z text` does the
# classification in one process for the whole tree rather than one
# `check-attr` call per file; a second per-file `python3` for the byte scan
# measured ~100s wall time on this repo (6346 files) — pure subprocess-start
# overhead — so the scan is one python3 process for every file together,
# which is under a second.
run_scan() {
  local root="$1"
  git -C "$root" ls-files -z \
    | git -C "$root" check-attr --stdin -z text \
    | python3 -c '
import sys
root = sys.argv[1]
# check-attr --stdin -z emits NUL-delimited (path, attr, info) triples, with a
# trailing empty element from the final delimiter — hence "- 2" below.
data = sys.stdin.buffer.read().split(b"\0")
violations = 0
for i in range(0, len(data) - 2, 3):
    path_b, info = data[i], data[i + 2]
    if info != b"set":  # only files EXPLICITLY declared text — see header
        continue
    path = path_b.decode("utf-8", "surrogateescape")
    try:
        content = open(root + "/" + path, "rb").read()
    except OSError as e:
        print(f"  VIOLATION: {path} could not be read: {e}")
        violations += 1
        continue
    if b"\x00" not in content:
        continue
    line = 1
    for pos, byte in enumerate(content):
        if byte == 0x00:
            print(f"  VIOLATION: {path}:{line} has a NUL byte at offset {pos} (git resolves \"text: set\")")
            violations += 1
        elif byte == 0x0A:
            line += 1
sys.exit(1 if violations else 0)
' "$root"
}

run_check() {
  local root="$1" out status=0

  out="$(run_scan "$root")" || status=$?

  if [ "$status" -ne 0 ]; then
    echo "$out"
    cat <<'EOF'

A tracked file git resolves to `text: set` contains a literal 0x00 byte. Git
classifies such a file as BINARY no matter what .gitattributes says: `git
diff` prints "Binary files a/... and b/... differ" instead of a readable
diff, `git grep` finds nothing inside it, and a plain `grep` sweep across the
tree silently skips it — a false clean, not an error (#3601).

Fix: remove the literal byte. An escape sequence (a Unicode NUL escape in JS/TS, `\x00` in
Python) produces the same runtime value without embedding a raw byte in the
source file, and keeps the file readable as text.

If the NUL is genuinely the point — an encoding fixture, a binary format
misdeclared as text — the fix is in .gitattributes: mark the path `-text` or
`binary` so git (and this gate) stop treating it as text.
EOF
    return 1
  fi

  echo "✅ no NUL bytes in any tracked file git resolves to 'text: set'"
  return 0
}

# A gate that has only ever been observed passing is indistinguishable from a
# gate with a typo in its pattern (#3601's own lesson, applied to itself: this
# check's failure mode — like check-playwright-pins.sh's — is a green
# pipeline). Builds a real, isolated git repo per case and runs run_check
# against it for real, rather than re-implementing the scan.
self_test() {
  local tmp status
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, not at trap time
  trap "rm -rf '$tmp'" EXIT

  # Isolate from the developer's own global/system git config — an inherited
  # core.autocrlf or global .gitattributes could change what `set`/`unset`/
  # `auto` resolves to underneath this test.
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  _fixture() {
    rm -rf "$tmp/repo"
    mkdir -p "$tmp/repo"
    git -C "$tmp/repo" init -q -b main
  }

  # Case 1: a clean text=set file. Must pass.
  _fixture
  printf '*.ts text eol=lf\n' > "$tmp/repo/.gitattributes"
  # shellcheck disable=SC2016  # fixture content, not meant to expand
  printf 'const key = `${a}-${b}`;\n' > "$tmp/repo/clean.ts"
  git -C "$tmp/repo" add -A
  status=0; run_check "$tmp/repo" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a clean text=set tree was reported as violating (exit $status)" >&2
    return 1
  fi

  # Case 2: THE #3601 SHAPE — a text=set file with a literal NUL byte. Must fail.
  _fixture
  printf '*.ts text eol=lf\n' > "$tmp/repo/.gitattributes"
  # shellcheck disable=SC2016  # fixture content, not meant to expand
  printf 'const key = `%b-${b}`;\n' '\0' > "$tmp/repo/bad.ts"
  git -C "$tmp/repo" add -A
  status=0; run_check "$tmp/repo" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 1 ]; then
    echo "SELF-TEST FAIL: a text=set file with a literal NUL byte was not caught (exit $status)" >&2
    return 1
  fi

  # Case 3: a text=unset (binary/-text) fixture with a NUL byte — this is the
  # encoding-fixture shape (#2892, #2937), the NUL IS the point. Must pass.
  _fixture
  printf 'weird.csv -text binary\n' > "$tmp/repo/.gitattributes"
  printf 'a,b%bc\n' '\0' > "$tmp/repo/weird.csv"
  git -C "$tmp/repo" add -A
  status=0; run_check "$tmp/repo" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a text=unset fixture with a NUL byte was flagged (exit $status)" >&2
    return 1
  fi

  # Case 4: a text=auto file (no explicit rule) with a NUL byte — out of
  # scope by design (git's own heuristic, not a contradicted declaration).
  # Must pass.
  _fixture
  printf '# no attributes for *.bin\n' > "$tmp/repo/.gitattributes"
  printf 'stuff%bmore\n' '\0' > "$tmp/repo/blob.bin"
  git -C "$tmp/repo" add -A
  status=0; run_check "$tmp/repo" >/dev/null 2>&1 || status=$?
  if [ "$status" -ne 0 ]; then
    echo "SELF-TEST FAIL: a text=auto file with a NUL byte was flagged out of scope (exit $status)" >&2
    return 1
  fi

  # Case 5: byte offset AND line number must be right — a report a developer
  # cannot navigate to is not much better than no report.
  _fixture
  printf '*.ts text eol=lf\n' > "$tmp/repo/.gitattributes"
  printf 'line one\nline %bthree\n' '\0' > "$tmp/repo/lined.ts"
  git -C "$tmp/repo" add -A
  local out
  out="$(run_check "$tmp/repo" 2>&1 || true)"
  if ! echo "$out" | grep -q "lined.ts:2 has a NUL byte"; then
    echo "SELF-TEST FAIL: violation report did not name the correct line (2):" >&2
    echo "$out" >&2
    return 1
  fi

  echo "SELF-TEST OK: clean text=set tree, a NUL in a text=set file, an encoding fixture (unset) with a genuine NUL, an auto file with a NUL, and line-number reporting all resolved correctly."
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
else
  run_check "$REPO_ROOT"
fi

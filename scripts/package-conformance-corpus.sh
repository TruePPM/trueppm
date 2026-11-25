#!/usr/bin/env bash
# scripts/package-conformance-corpus.sh — package the Python<->Rust conformance corpus
# (packages/wasm-scheduler/fixtures/) as a versioned tarball plus SHA-256 checksum, the
# release artifact attached to each `scheduler-v*` tag (#4165).
#
# The corpus certifies AGREEMENT with the reference engine, not correctness (#2637);
# the tarball ships a README.txt saying so, so the claim travels with the bytes.
#
# The archive is reproducible: sorted members, fixed mtime/owner, gzip without a
# timestamp, so re-running on the same tree yields the same checksum.
#
# Usage:  scripts/package-conformance-corpus.sh <version> <out-dir>
#         scripts/package-conformance-corpus.sh --self-test
# Output: <out-dir>/trueppm-scheduler-conformance-corpus-<version>.tar.gz
#         <out-dir>/trueppm-scheduler-conformance-corpus-<version>.tar.gz.sha256

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO_ROOT/packages/wasm-scheduler/fixtures"

sha256_of() { # sha256_of <file> -> hex digest on stdout
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

package() { # package <version> <out-dir>
  local version="$1" out="$2" name stage tarball
  name="trueppm-scheduler-conformance-corpus-$version"
  [ -d "$FIXTURES" ] || { echo "ERROR: fixtures not found at $FIXTURES" >&2; return 1; }
  [ -f "$FIXTURES/PROVENANCE.json" ] || { echo "ERROR: fixtures/PROVENANCE.json missing" >&2; return 1; }
  mkdir -p "$out"
  stage="$(mktemp -d)"
  mkdir -p "$stage/$name"
  cp -R "$FIXTURES/." "$stage/$name/fixtures"
  cat > "$stage/$name/README.txt" <<TXT
TruePPM scheduler conformance corpus $version

Language-neutral (input, expected output) pairs for critical-path scheduling.
Layout and usage: https://docs.trueppm.com/architecture/testing-another-implementation/

This corpus certifies AGREEMENT WITH THE REFERENCE ENGINE (trueppm-scheduler $version),
not correctness. The fixtures bind the Python and Rust engines to each other; a wrong
rule ported faithfully passes. Passing it does not make an implementation correct.
TXT
  # Pin every mtime so the archive bytes depend only on content (cp -R stamps "now").
  find "$stage/$name" -exec touch -t 200001010000 {} +
  tarball="$out/$name.tar.gz"
  # --sort/--owner need GNU tar; fall back to a sorted file list for bsdtar (macOS).
  (cd "$stage" && find "$name" -type f | LC_ALL=C sort > "$stage/.list")
  if grep -q 'GNU tar' <<<"$(tar --version 2>/dev/null)"; then
    (cd "$stage" && tar --mtime='2000-01-01 00:00:00' --owner=0 --group=0 --numeric-owner \
      -cf - -T "$stage/.list") | gzip -n > "$tarball"
  else
    (cd "$stage" && tar -cf - -T "$stage/.list" --uid 0 --gid 0 --numeric-owner) | gzip -n > "$tarball"
  fi
  printf '%s  %s\n' "$(sha256_of "$tarball")" "$(basename "$tarball")" > "$tarball.sha256"
  rm -rf "$stage"
  echo "wrote $tarball"
  echo "wrote $tarball.sha256"
}

self_test() {
  local tmp rc=0 listing
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  package 0.0.0-selftest "$tmp/a" >/dev/null
  local t="$tmp/a/trueppm-scheduler-conformance-corpus-0.0.0-selftest.tar.gz"
  listing="$(tar tzf "$t")"
  # The corpus must carry its valid, expected, invalid and reject sets, the provenance
  # index, and the README that states what passing means.
  for want in README.txt fixtures/PROVENANCE.json fixtures/basic_fs_chain.json \
    fixtures/expected/basic_fs_chain.json fixtures/invalid/cycle.json \
    fixtures/parse_rejects/task_id_non_string.json; do
    if ! grep -q -- "$want\$" <<<"$listing"; then echo "FAIL: tarball lacks $want"; rc=1; fi
  done
  grep -q "not correctness" <<<"$(tar xzOf "$t" "$(grep 'README.txt$' <<<"$listing")")" \
    || { echo "FAIL: README does not state agreement-not-correctness"; rc=1; }
  # The checksum file verifies, and a second packaging run is byte-identical.
  (cd "$tmp/a" && { command -v sha256sum >/dev/null && sha256sum -c ./*.sha256 >/dev/null || shasum -a 256 -c ./*.sha256 >/dev/null; }) \
    || { echo "FAIL: checksum does not verify"; rc=1; }
  package 0.0.0-selftest "$tmp/b" >/dev/null
  cmp -s "$tmp/a/trueppm-scheduler-conformance-corpus-0.0.0-selftest.tar.gz.sha256" \
    "$tmp/b/trueppm-scheduler-conformance-corpus-0.0.0-selftest.tar.gz.sha256" \
    || { echo "FAIL: packaging is not reproducible"; rc=1; }
  # Negative control: a corrupted tarball must fail verification.
  echo x >> "$t"
  if (cd "$tmp/a" && { command -v sha256sum >/dev/null && sha256sum -c ./*.sha256 >/dev/null 2>&1 || shasum -a 256 -c ./*.sha256 >/dev/null 2>&1; }); then
    echo "FAIL: corrupted tarball still verifies"; rc=1
  fi
  return "$rc"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  echo "SELF-TEST OK: package-conformance-corpus.sh packages the corpus reproducibly with a verifying checksum."
  exit 0
fi

[ $# -eq 2 ] || { echo "usage: $0 <version> <out-dir> | --self-test" >&2; exit 2; }
package "$1" "$2"

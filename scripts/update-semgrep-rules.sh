#!/usr/bin/env bash
#
# Refresh the vendored Semgrep rule packs under .semgrep/.
#
# The security:semgrep CI job runs fully offline against these vendored packs
# instead of pulling `--config p/<pack>` live from the Semgrep registry on every
# run. Vendoring removes the registry fetch from the CI hot path (it was the
# pipeline's largest tail-variance source — see #1639) and pins the exact rules
# that gate a given commit, so a registry-side rule change can no longer fail an
# otherwise-green MR.
#
# Keep this pack list in lockstep with the `--config` flags in
# .gitlab-ci.yml (security:semgrep). If you add/remove a pack here, mirror it
# there, and vice-versa.
#
# Run this on a documented cadence (e.g. each dot-release, alongside the
# dependency/digest refresh) to pick up upstream rule improvements:
#
#     scripts/update-semgrep-rules.sh
#     git add .semgrep && git commit -m "chore(ci): refresh vendored Semgrep rule packs"
#
set -euo pipefail

PACKS=(default react django)
DEST=".semgrep"
BASE="https://semgrep.dev/c/p"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
mkdir -p "$DEST"

for pack in "${PACKS[@]}"; do
  echo "fetching p/${pack} …"
  # -f: fail on HTTP error so a registry hiccup doesn't write a truncated pack.
  # --proto '=https' --tlsv1.2: refuse any non-HTTPS URL, including a redirect
  # that tries to downgrade to plaintext http, so the rules can't be swapped in
  # transit.
  curl --proto '=https' --tlsv1.2 -fsSL "${BASE}/${pack}" -o "${DEST}/${pack}.yml"
  # Sanity-check the download is a rules document, not an error page.
  if ! head -1 "${DEST}/${pack}.yml" | grep -q '^rules:'; then
    echo "error: ${DEST}/${pack}.yml does not start with 'rules:' — aborting" >&2
    exit 1
  fi
  bytes=$(wc -c < "${DEST}/${pack}.yml")
  echo "  wrote ${DEST}/${pack}.yml (${bytes} bytes)"
done

echo "done. Review the diff, then commit .semgrep/."

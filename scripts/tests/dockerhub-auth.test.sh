#!/usr/bin/env bash
# Unit test for scripts/lib/dockerhub-auth.sh (#4202).
# The property that matters: with no credentials the helpers do nothing, so a
# fork or an unconfigured project behaves as it did before.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$2" -ne 0 ]; then echo "  FAIL: $1"; fail=1; fi; }

# docker stub records its invocation and stdin
mkdir "$TMP/bin"
cat > "$TMP/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"; cat >> "$STUB_LOG"
SH
chmod +x "$TMP/bin/docker"
export PATH="$TMP/bin:$PATH" STUB_LOG="$TMP/log"; : > "$STUB_LOG"

(
  unset DOCKERHUB_USERNAME DOCKERHUB_TOKEN
  . "$REPO_ROOT/scripts/lib/dockerhub-auth.sh"
  dockerhub_login
  [ -z "$(dockerhub_kind_containerd_patch)" ]
) ; check "unconfigured: no login and empty patch" $?
check "unconfigured: docker never invoked" "$([ -s "$STUB_LOG" ] && echo 1 || echo 0)"

(
  export DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t
  . "$REPO_ROOT/scripts/lib/dockerhub-auth.sh"
  dockerhub_login >/dev/null
  p="$(dockerhub_kind_containerd_patch)"
  grep -q 'containerdConfigPatches:' <<<"$p"
  grep -q 'registry-1.docker.io' <<<"$p"
  grep -q 'username = "u"' <<<"$p"
); check "configured: patch emitted" $?
check "configured: docker login called with the token on stdin" \
  "$(grep -q 'login -u u --password-stdin docker.io' "$STUB_LOG" && grep -qx t "$STUB_LOG" && echo 0 || echo 1)"

[ "$fail" -eq 0 ] && echo "dockerhub-auth.test.sh: passed" || { echo "dockerhub-auth.test.sh: FAILED"; exit 1; }

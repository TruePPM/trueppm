#!/usr/bin/env bash
# scripts/check-compose-nginx-shutdown.sh — docker-compose.prod.yml's serving
# nginx bounds its WebSocket drain (#4366, follow-up to #4359).
#
# `docker compose stop` sends SIGQUIT, a graceful shutdown that waits for open
# connections, and /ws/ is proxied with `proxy_read_timeout 86400s`. Without
# `worker_shutdown_timeout` a live viewer holds the container until SIGKILL.
# The directive is main-context, so it rides on the `nginx -g` argument in the
# service command (conf.d is included inside `http {}`, where it is an error).
# It is useless unless `stop_grace_period` outlasts it — compose's default is
# 10s — so both are asserted. A text scan: it cannot prove nginx honors it.
#
# Usage:  scripts/check-compose-nginx-shutdown.sh [--self-test]
# Exit:   0 directive present and stop_grace_period > it · 1 otherwise

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_check() {
  local file="$1/docker-compose.prod.yml" block timeout grace
  [[ -f "$file" ]] || { echo "ERROR: $file not found" >&2; return 1; }
  # Both values are scoped to the top-level nginx service block, comments dropped.
  block="$(awk '/^  [a-z0-9_-]+:/ {in_n = ($1 == "nginx:")} in_n' "$file" | grep -vE '^[[:space:]]*#' || true)"
  timeout="$(grep -oE 'worker_shutdown_timeout[[:space:]]+[0-9]+s' <<<"$block" | sed -n 1p | grep -oE '[0-9]+' || true)"
  grace="$(grep -E '^    stop_grace_period:' <<<"$block" | sed -n 1p | grep -oE '[0-9]+' || true)"
  if [[ -z "$timeout" ]]; then
    echo "  docker-compose.prod.yml: nginx command has no 'worker_shutdown_timeout Ns' (-g argument; comments ignored)" >&2
    return 1
  fi
  if [[ -z "$grace" ]]; then
    echo "  docker-compose.prod.yml: nginx service sets no stop_grace_period (default 10s SIGKILLs before ${timeout}s)" >&2
    return 1
  fi
  if (( grace <= timeout )); then
    echo "  docker-compose.prod.yml: stop_grace_period ${grace}s <= worker_shutdown_timeout ${timeout}s" >&2
    return 1
  fi
  printf '  docker-compose.prod.yml: worker_shutdown_timeout %ss, stop_grace_period %ss\n' "$timeout" "$grace"
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  reset() { cp "$REPO_ROOT/docker-compose.prod.yml" "$tmp/"; }
  reset
  run_check "$tmp" >/dev/null 2>&1 || { echo "SELF-TEST FAILED: clean tree should pass" >&2; exit 1; }
  reset; sed 's/worker_shutdown_timeout 20s;//' "$tmp/docker-compose.prod.yml" >"$tmp/x" && mv "$tmp/x" "$tmp/docker-compose.prod.yml"
  run_check "$tmp" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: missing directive not caught" >&2; exit 1; }
  reset; sed '/^    stop_grace_period: 30s$/d' "$tmp/docker-compose.prod.yml" >"$tmp/x" && mv "$tmp/x" "$tmp/docker-compose.prod.yml"
  run_check "$tmp" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: missing stop_grace_period not caught" >&2; exit 1; }
  reset; sed 's/^    stop_grace_period: 30s$/    stop_grace_period: 15s/' "$tmp/docker-compose.prod.yml" >"$tmp/x" && mv "$tmp/x" "$tmp/docker-compose.prod.yml"
  run_check "$tmp" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: short stop_grace_period not caught" >&2; exit 1; }
  # Directive only in another service's block (nginx block loses it).
  reset; sed 's/worker_shutdown_timeout 20s;//' "$tmp/docker-compose.prod.yml" >"$tmp/x"
  awk '{print} /^  db:/ {print "    command: [\"x\", \"worker_shutdown_timeout 20s;\"]"}' "$tmp/x" >"$tmp/docker-compose.prod.yml"
  grep -q 'worker_shutdown_timeout' "$tmp/docker-compose.prod.yml" || { echo "SELF-TEST FAILED: plant did not apply" >&2; exit 1; }
  run_check "$tmp" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: directive in another service not caught" >&2; exit 1; }
  # Directive only inside a comment in the nginx block.
  reset; sed 's/worker_shutdown_timeout 20s;//' "$tmp/docker-compose.prod.yml" >"$tmp/x"
  awk '{print} /^    stop_grace_period:/ {print "    # worker_shutdown_timeout 20s;"}' "$tmp/x" >"$tmp/docker-compose.prod.yml"
  grep -q '# worker_shutdown_timeout' "$tmp/docker-compose.prod.yml" || { echo "SELF-TEST FAILED: plant did not apply" >&2; exit 1; }
  run_check "$tmp" >/dev/null 2>&1 && { echo "SELF-TEST FAILED: commented directive not caught" >&2; exit 1; }
  echo "self-test OK"
  exit 0
fi

echo "compose nginx shutdown — bounded WebSocket drain"
run_check "$REPO_ROOT" && echo "OK"

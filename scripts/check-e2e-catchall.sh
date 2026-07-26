#!/usr/bin/env bash
# Every Playwright spec that mocks the API must register the shared catch-all
# (`setupCatchAll`) before its own routes (#2366).
#
# Without it, any endpoint the spec forgot to mock escapes the browser-level
# mocks. What happens next depends on the machine: in CI (no backend) it hits the
# preview server, and on a developer box with `make up` running it reaches the
# real API and 401s, which drives the client's token-refresh + session-teardown
# path and races the page render. Same spec, different outcome per environment —
# which is how `wave6-heatmap.spec.ts` spent months being triaged as an
# "environmental flake" (14 failed / 13 passed at --repeat-each=3; 36/36 with the
# catch-all).
#
# The catch-all answers anything unmocked with a typed 404 plus a console warning
# naming the URL, so a missing mock becomes a visible, deterministic warning
# instead of a machine-dependent race.
#
# Usage: scripts/check-e2e-catchall.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SPEC_DIR="packages/web/e2e"

# Specs that legitimately need no catch-all: they render pre-auth surfaces (no
# session to tear down) or assert on the unmocked path itself. Keep this list
# short and justified — an entry here is a claim that the spec does not depend on
# API mocks at all.
ALLOWLIST=(
  # Pre-auth surfaces — no authenticated session exists to lose.
  "auth.spec.ts"
  "wave8-login.spec.ts"
  "password-reset.spec.ts"
  "invite-accept.spec.ts"
  "landing-redirect.spec.ts"
  # Static design-token assertions — makes no API calls at all.
  "brand.spec.ts"
)

is_allowlisted() {
  local name="$1"
  for entry in "${ALLOWLIST[@]}"; do
    [[ "$name" == "$entry" ]] && return 0
  done
  return 1
}

missing=()
for spec in "$SPEC_DIR"/*.spec.ts; do
  name="$(basename "$spec")"
  is_allowlisted "$name" && continue
  # Only specs that mock the API need the catch-all.
  grep -q "page.route(\|setupApiMocks" "$spec" || continue
  grep -q "setupCatchAll" "$spec" || missing+=("$name")
done

if (( ${#missing[@]} > 0 )); then
  echo "✖ e2e specs mock the API but never call setupCatchAll:" >&2
  printf '    %s\n' "${missing[@]}" >&2
  cat >&2 <<'EOF'

Add it as the FIRST route registration in the spec's setup (later routes win):

    import { setupCatchAll } from './fixtures';
    await setupCatchAll(page);

If the spec genuinely makes no API calls, add it to ALLOWLIST in
scripts/check-e2e-catchall.sh with a one-line reason.
EOF
  exit 1
fi

echo "✅ all API-mocking e2e specs register the catch-all"

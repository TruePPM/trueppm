#!/usr/bin/env bash
# scripts/check-compose-project-names.sh — every standalone root compose file
# pins its own, distinct top-level `name:`.
#
# Why this exists (#3928). docker-compose.prod.yml pinned `name: trueppm` in
# #3189 because an unpinned project name is derived from the CHECKOUT DIRECTORY.
# docker-compose.yml and docker-compose.demo.yml did not, so on a default
# `git clone` (directory `trueppm`) all three resolved to the same project.
# Two consequences, both reachable by following the docs as written:
#   1. dev and prod both declare bare `postgres_data` / `valkey_data`, so they
#      shared `trueppm_postgres_data`. Postgres applies POSTGRES_PASSWORD only
#      on first init, so whichever stack came second met the other's password —
#      or, in the other order, `make up` landed on production data guarded only
#      by the hardcoded dev SECRET_KEY.
#   2. demo shares service names (db, valkey, api, nginx) with prod, and two
#      files in one project that share a service name RECREATE each other's
#      containers in place on `up`.
#
# SCOPE. "Standalone" files are the ones an operator runs on their own:
# docker-compose.yml, .prod.yml, .demo.yml. docker-compose.o11y.yml is an
# OVERLAY, always combined with docker-compose.yml (`-f a -f b`). It must NOT
# declare a `name:` — a second file's `name:` overrides the first, which would
# silently rename the dev stack the overlay is meant to extend. The gate asserts
# that too.
#
# What this cannot see: COMPOSE_PROJECT_NAME in the environment. Compose
# precedence is `-p` > COMPOSE_PROJECT_NAME > `name:` > directory basename, so an
# exported variable defeats every pin here. scripts/wt exports `trueppm-dev` for
# that reason; see docs/getting-started/parallel-worktrees.md.
#
# Usage:  scripts/check-compose-project-names.sh [--self-test]
# Exit:   0 every standalone file pins a distinct name · 1 otherwise

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STANDALONE_FILES=(
  docker-compose.yml
  docker-compose.prod.yml
  docker-compose.demo.yml
)
OVERLAY_FILES=(
  docker-compose.o11y.yml
)

# Print the value of the top-level `name:` key (empty if none). Not a YAML
# parse: the key must be at column 0, which is where Compose requires it.
project_name_of() {
  local file="$1"
  sed -n -e 's/^name:[[:space:]]*//p' "$file" \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//" \
    | sed -n '1p'
}

run_check() {
  local root="$1" violations=0 scanned=0 f name seen=""
  cd "$root"
  for f in "${STANDALONE_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    scanned=$((scanned + 1))
    name="$(project_name_of "$f")"
    if [[ -z "$name" ]]; then
      printf '  %-28s no top-level `name:` — project name falls back to the checkout directory\n' "$f"
      violations=$((violations + 1))
      continue
    fi
    if grep -qxF "$name" <<<"$seen"; then
      printf '  %-28s name `%s` is already used by another compose file\n' "$f" "$name"
      violations=$((violations + 1))
    fi
    seen+="$name"$'\n'
    printf '  %-28s name: %s\n' "$f" "$name"
  done
  for f in "${OVERLAY_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    name="$(project_name_of "$f")"
    if [[ -n "$name" ]]; then
      printf '  %-28s overlay declares `name: %s` — it would rename the stack it extends\n' "$f" "$name"
      violations=$((violations + 1))
    fi
  done
  if (( scanned == 0 )); then
    echo "ERROR: no compose files found under $root — the gate scanned nothing." >&2
    return 1
  fi
  printf '\n  scanned %d standalone compose file(s)\n' "$scanned"
  return $(( violations > 0 ? 1 : 0 ))
}

# --self-test: plant each violation in a throwaway copy and assert the gate
# reports it. A gate observed only on a clean tree is indistinguishable from one
# that always passes (#3194).
if [[ "${1:-}" == "--self-test" ]]; then
  echo "self-test: planted missing, duplicate and overlay names must be caught"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp "$REPO_ROOT"/docker-compose*.yml "$tmp/"

  reset() { cp "$REPO_ROOT"/docker-compose*.yml "$tmp/"; }

  # Case 1: clean tree passes.
  if ! run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: the unmodified tree should pass but did not." >&2
    exit 1
  fi

  # Case 2: a missing pin is caught.
  sed -i.bak '/^name:/d' "$tmp/docker-compose.demo.yml" && rm -f "$tmp/docker-compose.demo.yml.bak"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a compose file with no name: was not reported." >&2
    exit 1
  fi

  # Case 3: two files sharing a name is caught.
  reset
  sed -i.bak 's/^name:.*/name: trueppm/' "$tmp/docker-compose.yml" && rm -f "$tmp/docker-compose.yml.bak"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a duplicate project name was not reported." >&2
    exit 1
  fi

  # Case 4: an overlay that declares a name is caught.
  reset
  printf 'name: trueppm-o11y\n' >> "$tmp/docker-compose.o11y.yml"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an overlay declaring name: was not reported." >&2
    exit 1
  fi

  echo "self-test OK: catches a missing name, a duplicate name and an overlay name."
  exit 0
fi

echo "compose project names — every standalone compose file pins a distinct name"
echo
if run_check "$REPO_ROOT"; then
  echo "OK: every standalone compose file pins its own project name."
else
  cat >&2 <<'MSG'

FAIL: see the file(s) above.

Two compose files in one project share volumes (same bare volume name) and
recreate each other's containers in place (same service name). The project name
is what keeps them apart, and unpinned it comes from the checkout directory —
`trueppm` on a default clone, which is exactly prod's pin (#3928).

Give each standalone file its own top-level `name:` (dev: trueppm-dev, prod:
trueppm, demo: trueppm-demo), and keep overlays such as docker-compose.o11y.yml
free of one.
MSG
  exit 1
fi

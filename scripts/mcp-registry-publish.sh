#!/usr/bin/env bash
# mcp-registry-publish.sh — list trueppm-mcp on the official MCP registry
# (registry.modelcontextprotocol.io) from CI (#4682).
#
# `mcp:publish` pushes the wheel to PyPI; this is the step after it. The registry
# is a separate catalog keyed on `server.json`'s `name` (com.trueppm/mcp-server),
# and it was a manual step until now. It never ran: the registry held 0 entries
# for com.trueppm at the 0.4.0 tag, and the shipped manifest did not even pass
# registry validation (description over its 100-character limit), which nothing
# checked because nothing ever submitted it.
#
# Modes:
#   validate  — `mcp-publisher validate` the manifest against the live registry.
#               Run on MRs that touch server.json, so a manifest the registry
#               rejects is caught before a tag, not at it.
#   publish   — on an mcp-v* tag, after mcp:publish:
#                 1. skip (exit 0) if the registry already lists this version,
#                    so a retried tag pipeline is idempotent;
#                 2. wait for PyPI to serve the new version WITH the
#                    `mcp-name: <name>` README marker — the registry verifies
#                    package ownership against the published PyPI description,
#                    so publishing before PyPI's API catches up is a 4xx;
#                 3. log in by DNS proof for trueppm.com with the Ed25519 key in
#                    MCP_REGISTRY_PRIVATE_KEY (protected + masked CI variable;
#                    it reaches protected tags only) and publish;
#                 4. read the version back from the registry.
#
# Fails closed on anything it cannot read: a registry or PyPI answer other than
# the expected 200/404 is an error, never "assume fine".
#
# Env overrides (tests): MCP_PUBLISHER (skip the download, use this binary),
# MCP_REGISTRY_URL, PYPI_URL, PYPI_WAIT_SECONDS, POLL_SECONDS.
#
# Usage: bash scripts/mcp-registry-publish.sh validate|publish [server.json]
set -euo pipefail

MODE="${1:-}"
MANIFEST="${2:-packages/mcp/server.json}"

REGISTRY_URL="${MCP_REGISTRY_URL:-https://registry.modelcontextprotocol.io}"
PYPI_URL="${PYPI_URL:-https://pypi.org}"
PYPI_WAIT_SECONDS="${PYPI_WAIT_SECONDS:-600}"
POLL_SECONDS="${POLL_SECONDS:-20}"
DOMAIN="trueppm.com"

# Bump version and checksum together (sha256sum of the linux_amd64 tarball from
# github.com/modelcontextprotocol/registry/releases). Pinned to a release well
# past its publish date rather than the newest, same policy as other CI binaries.
PUBLISHER_VERSION="1.8.1"
PUBLISHER_SHA256="a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc"

die() { echo "ERROR: $*" >&2; exit 1; }

case "$MODE" in
  validate|publish) ;;
  *) echo "usage: $0 validate|publish [server.json]" >&2; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || die "jq is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
[[ -f "$MANIFEST" ]] || die "manifest not found: $MANIFEST"

install_publisher() {
  if [[ -n "${MCP_PUBLISHER:-}" ]]; then
    return
  fi
  local dir
  dir="$(mktemp -d)"
  curl -sSfL -o "$dir/mcp-publisher.tgz" \
    "https://github.com/modelcontextprotocol/registry/releases/download/v${PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz"
  echo "${PUBLISHER_SHA256}  $dir/mcp-publisher.tgz" | sha256sum -c -
  tar -xzf "$dir/mcp-publisher.tgz" -C "$dir" mcp-publisher
  MCP_PUBLISHER="$dir/mcp-publisher"
}

# fetch <url> <outfile> -> prints the HTTP status ("000" when unreachable).
fetch() {
  local code
  code="$(curl -s -o "$2" -w '%{http_code}' "$1")" || code="000"
  printf '%s' "$code"
}

if [[ "$MODE" == validate ]]; then
  install_publisher
  "$MCP_PUBLISHER" validate "$MANIFEST"
  exit 0
fi

NAME="$(jq -r '.name' "$MANIFEST")"
VERSION="$(jq -r '.version' "$MANIFEST")"
PYPI_PKG="$(jq -r '[.packages[] | select(.registryType == "pypi")][0].identifier // empty' "$MANIFEST")"
PYPI_VERSION="$(jq -r '[.packages[] | select(.registryType == "pypi")][0].version // empty' "$MANIFEST")"
[[ -n "$PYPI_PKG" && -n "$PYPI_VERSION" ]] || die "$MANIFEST declares no pypi package"
MARKER="mcp-name: $NAME"

NAME_ENC="$(jq -rn --arg v "$NAME" '$v | @uri')"
VERSION_ENC="$(jq -rn --arg v "$VERSION" '$v | @uri')"
VERSION_URL="$REGISTRY_URL/v0/servers/$NAME_ENC/versions/$VERSION_ENC"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

code="$(fetch "$VERSION_URL" "$TMP/registry.json")"
case "$code" in
  200) echo "$NAME $VERSION is already listed on the MCP registry; nothing to do."; exit 0 ;;
  404) echo "$NAME $VERSION is not listed yet; publishing." ;;
  *) die "could not read $VERSION_URL (HTTP $code); refusing to guess whether it is listed" ;;
esac

# The registry checks the marker on PyPI's copy of the README, which can lag the
# upload by a few minutes. Poll until both the version and the marker are served.
waited=0
while :; do
  code="$(fetch "$PYPI_URL/pypi/$PYPI_PKG/$PYPI_VERSION/json" "$TMP/pypi.json")"
  if [[ "$code" == 200 ]]; then
    if grep -qF -- "$MARKER" <<<"$(jq -r '.info.description // ""' "$TMP/pypi.json")"; then
      echo "PyPI serves $PYPI_PKG $PYPI_VERSION with the '$MARKER' marker."
      break
    fi
    reason="is live but its README lacks '$MARKER'"
  else
    reason="returned HTTP $code"
  fi
  if (( waited >= PYPI_WAIT_SECONDS )); then
    die "PyPI $PYPI_PKG $PYPI_VERSION $reason after ${waited}s; the registry would reject the publish"
  fi
  sleep "$POLL_SECONDS"
  waited=$((waited + POLL_SECONDS))
done

[[ -n "${MCP_REGISTRY_PRIVATE_KEY:-}" ]] || die "MCP_REGISTRY_PRIVATE_KEY is not set. It must be a protected, masked CI/CD variable holding the hex Ed25519 private key whose public half is in the $DOMAIN TXT record (#1485, #4682)."

install_publisher
"$MCP_PUBLISHER" login dns --domain "$DOMAIN" --private-key "$MCP_REGISTRY_PRIVATE_KEY"
"$MCP_PUBLISHER" validate "$MANIFEST"
"$MCP_PUBLISHER" publish "$MANIFEST"

for _ in 1 2 3 4 5 6; do
  code="$(fetch "$VERSION_URL" "$TMP/registry.json")"
  if [[ "$code" == 200 ]]; then
    echo "Listed: $REGISTRY_URL/v0/servers?search=$NAME_ENC"
    exit 0
  fi
  sleep "$POLL_SECONDS"
done
die "publish reported success but $VERSION_URL still returns HTTP $code"

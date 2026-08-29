#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# init-prod.sh — one-time production setup: configure TLS mode, obtain
# certificates if needed, and start the production stack.
#
# TLS_MODE (set in .env):
#   letsencrypt  — obtain a Let's Encrypt certificate via ACME (default)
#   selfsigned   — generate a self-signed certificate for staging / internal use
#   none         — serve over plain HTTP (no TLS)
#
# Usage:
#   cp .env.example .env   # fill in DOMAIN, TLS_MODE, SECRET_KEY, etc.
#   chmod +x init-prod.sh
#   ./init-prod.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Load .env so DOMAIN, TLS_MODE, etc. are available.
if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in the required values." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DOMAIN:?Set DOMAIN=yourdomain.com in .env}"
: "${SECRET_KEY:?Set SECRET_KEY to a long random string in .env}"
: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"
: "${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}"

# The :? checks above only assert non-empty, which the ".env.example" placeholder
# satisfied — so catch the copy-paste here rather than letting the stack come up on a
# documented credential. The API container enforces the same rule at import time
# (validate_service_credentials, #3176); failing in the script gives the operator the
# error at the point they can still fix it, instead of in a crash-looping container.
for _cred in DB_PASSWORD REDIS_PASSWORD; do
  _val="${!_cred}"
  case "$(printf '%s' "${_val}" | tr '[:upper:]' '[:lower:]')" in
    change-me|changeme|password|postgres|trueppm|secret)
      echo "ERROR: ${_cred} is still the placeholder '${_val}'. Generate a real one:" >&2
      echo "  python3 -c \"import secrets; print(secrets.token_urlsafe(32))\"" >&2
      exit 1
      ;;
  esac
  if (( ${#_val} < 12 )); then
    echo "ERROR: ${_cred} is ${#_val} characters; minimum is 12." >&2
    exit 1
  fi
done
unset _cred _val

TLS_MODE="${TLS_MODE:-letsencrypt}"

# ---------------------------------------------------------------------------
# .env helpers
# ---------------------------------------------------------------------------
# Rewrite through a temp file and `cat` it back rather than `mv`, so .env keeps
# the 0600 permissions the operator set on it instead of inheriting mktemp's.
upsert_env_var() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v -E "^[[:space:]]*${key}=" .env > "${tmp}" || true
  printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"
  cat "${tmp}" > .env
  rm -f "${tmp}"
  # Export too: this script sourced .env before rewriting it, so without this
  # the stale value in our own environment would take precedence over the file
  # for the `docker compose up` below.
  export "${key}=${value}"
}

# Drop KEY from .env only when it currently holds exactly EXPECTED, so an
# operator who set the variable to something of their own is never clobbered.
remove_env_var_if() {
  local key="$1" expected="$2" tmp current
  current="$(grep -E "^[[:space:]]*${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
  [[ "${current}" == "${expected}" ]] || return 0
  tmp="$(mktemp)"
  grep -v -E "^[[:space:]]*${key}=" .env > "${tmp}" || true
  cat "${tmp}" > .env
  rm -f "${tmp}"
  unset "${key}"
}

# ---------------------------------------------------------------------------
# Validate TLS_MODE
# ---------------------------------------------------------------------------
case "${TLS_MODE}" in
  letsencrypt|selfsigned|none) ;;
  *)
    echo "ERROR: Invalid TLS_MODE='${TLS_MODE}'. Must be one of: letsencrypt, selfsigned, none." >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Select nginx config template based on TLS_MODE
# ---------------------------------------------------------------------------
if [[ "${TLS_MODE}" == "none" ]]; then
  echo ""
  echo "  ============================================================"
  echo "  WARNING: TLS_MODE=none — TruePPM will serve over plain HTTP."
  echo "  Session cookies and API traffic will NOT be encrypted."
  echo "  Do NOT use for deployments reachable from the public internet."
  echo "  ============================================================"
  echo ""
  cp nginx/app-http.conf.template nginx/active.conf.template
else
  cp nginx/app.conf.template nginx/active.conf.template
fi

# ---------------------------------------------------------------------------
# Certificate handling
# ---------------------------------------------------------------------------
if [[ "${TLS_MODE}" == "letsencrypt" ]]; then
  : "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL in .env when TLS_MODE=letsencrypt}"

  echo "Obtaining Let's Encrypt certificate for ${DOMAIN} ..."

  # First issuance runs standalone, in its own container with :80 published.
  # It cannot use the webroot: the nginx TLS config references certificate
  # files that do not exist yet, so nginx cannot start to serve the ACME
  # challenge until after this succeeds. RENEWALS do go through the webroot —
  # see the certbot service in docker-compose.prod.yml, which overrides the
  # authenticator recorded here with `-a webroot`, because by then nginx owns
  # :80 and a standalone renewal could never bind it.
  docker run --rm \
    -p 80:80 \
    -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
    -v "$(pwd)/certbot/www:/var/www/certbot" \
    certbot/certbot certonly \
      --standalone \
      --email "${CERTBOT_EMAIL}" \
      --agree-tos --no-eff-email \
      -d "${DOMAIN}"

elif [[ "${TLS_MODE}" == "selfsigned" ]]; then
  echo "Generating self-signed certificate for ${DOMAIN} ..."

  mkdir -p certbot/conf/live/"${DOMAIN}"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout certbot/conf/live/"${DOMAIN}"/privkey.pem \
    -out    certbot/conf/live/"${DOMAIN}"/fullchain.pem \
    -subj   "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN}"
fi

# ---------------------------------------------------------------------------
# Activate (or deactivate) the certbot renewal profile
# ---------------------------------------------------------------------------
# The certbot service in docker-compose.prod.yml sits behind
# `profiles: ["letsencrypt"]`, so it only exists while that profile is active.
# The choice is persisted into .env rather than passed as `--profile` on the
# `up` below, because docker compose reads COMPOSE_PROFILES from .env on EVERY
# invocation — including the plain `docker compose ... up -d` an operator runs
# later and the systemd unit in the deployment docs, neither of which passes a
# flag. A --profile here would have activated renewal for this one command and
# nothing else, which is how the certificate silently expired at ~90 days
# (#2804).
if [[ "${TLS_MODE}" == "letsencrypt" ]]; then
  upsert_env_var COMPOSE_PROFILES letsencrypt
  echo "Enabled COMPOSE_PROFILES=letsencrypt in .env (certbot renewal service)."
else
  # Switching away from Let's Encrypt: drop the profile so a certbot with no
  # lineage to renew is not left running. Only removed when it still holds the
  # exact value this script wrote.
  remove_env_var_if COMPOSE_PROFILES letsencrypt
fi

# ---------------------------------------------------------------------------
# Start the production stack
# ---------------------------------------------------------------------------
echo "Starting TruePPM production stack ..."
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "  Stack started. Retrieve the initial admin password with:"
echo "    docker compose -f docker-compose.prod.yml exec api cat /run/trueppm/admin_password"
echo ""
if [[ "${TLS_MODE}" == "letsencrypt" ]]; then
  echo "  Certificate renewal runs in the 'certbot' service (webroot, every 12h);"
  echo "  nginx reloads every 6h to pick up a renewed certificate. Verify with:"
  echo "    docker compose -f docker-compose.prod.yml ps certbot"
  echo ""
fi

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
# Parse .env as KEY=VALUE, never `source` it (#3189).
#
# `set -a; source .env` executes the file as bash. .env.example documents
#   CSP_CONNECT_SRC='self' wss:
# which bash reads as an assignment prefix plus the COMMAND `wss:` — so under
# `set -euo pipefail` this script died with exit 127 on a line the file itself
# tells you to uncomment, while Docker Compose parses it correctly. The value
# worked everywhere except the script the documentation tells you to run.
#
# Worse: a password containing `$(...)` or a backtick would have been EXECUTED.
# .env holds DB_PASSWORD and REDIS_PASSWORD, and both are meant to be random —
# `python3 -c "import secrets; ..."` output routinely contains `$`.
#
# This reader assigns, exports, and evaluates nothing. It mirrors Compose's own
# rules: skip blanks and comments, split on the first `=`, and strip ONE layer
# of quotes only when they surround the WHOLE value — so `CSP_CONNECT_SRC='self'
# wss:` keeps the quotes CSP syntax actually requires.
load_env_file() {
  local file="$1" line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"                       # tolerate CRLF-saved .env files
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"       # ltrim
    key="${key%"${key##*[![:space:]]}"}"       # rtrim
    # Anything that is not a shell-legal name is not a variable assignment.
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    value="${line#*=}"
    if [[ ${#value} -ge 2 && "$value" == \"*\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf -v "$key" '%s' "$value"
    export "${key?}"
  done < "$file"
}

load_env_file .env

: "${DOMAIN:?Set DOMAIN=yourdomain.com in .env}"
: "${DB_PASSWORD:?Set DB_PASSWORD in .env}"
: "${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}"

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
# Reject documented placeholders, in every secret (#3176, #3187)
# ---------------------------------------------------------------------------
# The :? checks only assert non-empty, which a shipped placeholder satisfies — so
# catch the copy-paste here rather than letting the stack come up on a credential
# published in this repository. SECRET_KEY is the case that mattered most: the
# placeholder .env.example used to ship was 56 characters and did not start with
# "django-insecure-", so it cleared validate_secret_key AND validate_signing_key,
# and JWT_SIGNING_KEY defaults to SECRET_KEY — a verbatim `cp .env.example .env`
# produced a production install whose token-signing key was public.
#
# The API enforces the same rules at import time; failing here gives the operator
# the error at the point they can still fix it, rather than in a crash-looping
# container.
reject_placeholder() {
  local name="$1" value="$2" gen="$3" minlen="$4"
  local lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  case "${lower}" in
    replace-with*|change-me*|changeme|password|postgres|trueppm|secret|django-insecure-*)
      echo "ERROR: ${name} is still a placeholder ('${value}'). Generate a real one:" >&2
      echo "  ${gen}" >&2
      exit 1
      ;;
  esac
  if (( ${#value} < minlen )); then
    echo "ERROR: ${name} is ${#value} characters; minimum is ${minlen}." >&2
    echo "  ${gen}" >&2
    exit 1
  fi
}

_TOKEN_GEN='python3 -c "import secrets; print(secrets.token_urlsafe(50))"'

# SECRET_KEY is GENERATED when absent or empty, and only then. It is the one
# secret here with no external coupling: rotating it invalidates sessions and
# issued JWTs but nothing persisted, so minting one on first run is safe.
# DB_PASSWORD and REDIS_PASSWORD are NOT generated for exactly that reason
# inverted — by the time this script runs a second time the datastore volumes may
# already hold the old credential, and silently minting a new one would lock the
# stack out of its own database.
if [[ -z "${SECRET_KEY:-}" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "ERROR: SECRET_KEY is empty and python3 is not available to generate one." >&2
    echo "  Set SECRET_KEY in .env to a long random string (at least 32 characters)." >&2
    exit 1
  fi
  SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')"
  upsert_env_var SECRET_KEY "${SECRET_KEY}"
  echo "Generated SECRET_KEY and wrote it to .env (it was empty)."
fi

reject_placeholder SECRET_KEY "${SECRET_KEY}" "${_TOKEN_GEN}" 32
# JWT_SIGNING_KEY is optional and defaults to SECRET_KEY; only check an explicit one.
if [[ -n "${JWT_SIGNING_KEY:-}" ]]; then
  reject_placeholder JWT_SIGNING_KEY "${JWT_SIGNING_KEY}" "${_TOKEN_GEN}" 32
fi
for _cred in DB_PASSWORD REDIS_PASSWORD; do
  reject_placeholder "${_cred}" "${!_cred}" \
    'python3 -c "import secrets; print(secrets.token_urlsafe(32))"' 12
done
unset _cred

TLS_MODE="${TLS_MODE:-letsencrypt}"

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

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
  echo "ERROR: .env file not found. Copy .env.example and fill in the required values."
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

TLS_MODE="${TLS_MODE:-letsencrypt}"

# ---------------------------------------------------------------------------
# Validate TLS_MODE
# ---------------------------------------------------------------------------
case "${TLS_MODE}" in
  letsencrypt|selfsigned|none) ;;
  *)
    echo "ERROR: Invalid TLS_MODE='${TLS_MODE}'. Must be one of: letsencrypt, selfsigned, none."
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

  # Start a temporary nginx to serve the ACME challenge.
  docker compose -f docker-compose.prod.yml run --rm --no-deps \
    -p 80:80 \
    nginx sh -c "
      mkdir -p /var/www/certbot
      nginx -g 'daemon off;' &
      sleep 3
      certbot certonly \
        --webroot --webroot-path=/var/www/certbot \
        --email '${CERTBOT_EMAIL}' \
        --agree-tos --no-eff-email \
        -d '${DOMAIN}'
      kill %1
    " 2>/dev/null || true

  # Proper certonly via standalone (simpler on first run).
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
# Start the production stack
# ---------------------------------------------------------------------------
echo "Starting TruePPM production stack ..."
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "  Stack started. Retrieve the initial admin password with:"
echo "    docker compose -f docker-compose.prod.yml exec api cat /run/trueppm/admin_password"
echo ""

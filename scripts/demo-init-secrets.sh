#!/bin/sh
# First-boot secret generator for docker-compose.demo.yml (#4946).
#
# The demo compose file used to bake public `:-` defaults for SECRET_KEY and
# INTEGRATION_ENCRYPTION_KEY, so every install shared one JWT signing key (and
# `load_sample_project` creates a sample OWNER account, so that key was a
# forgeable token for a real row). This script runs once per `up` as the
# `secrets-init` service, before anything that needs a secret:
#
#   * a secret already supplied in the environment wins (operator override);
#   * otherwise a value already stored on the volume is reused, so restarts keep
#     the same key and issued tokens stay valid;
#   * otherwise a fresh CSPRNG value is generated from /dev/urandom.
#
# Each service then sources $SECRETS_DIR/env (see the compose entrypoint) so
# api-init, demo-seed and api all see the SAME values.
#
# Values are never printed. Files are created under umask 077 (0600) and the
# directory is 0700. POSIX sh + coreutils only (base64, head, tr) so it runs in
# the python:3.11-slim API image without installing anything. The generated
# SECRET_KEY has no `django-insecure-` prefix, so settings/prod.py's
# validate_secret_key accepts it.
#
# Environment:
#   SECRETS_DIR            target directory (default /secrets)
#   SECRET_KEY, INTEGRATION_ENCRYPTION_KEY   optional overrides
#   SECRETS_OWNER          uid:gid to chown to (default 1000:1000, the image's
#                          `trueppm` user; set empty to skip, e.g. in tests)
set -eu

SECRETS_DIR="${SECRETS_DIR:-/secrets}"
SECRETS_OWNER="${SECRETS_OWNER-1000:1000}"

umask 077
mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"

# 48 random bytes -> 64 URL-safe base64 chars, no padding.
gen_secret_key() {
  head -c 48 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'
}

# A Fernet key is exactly 32 random bytes, URL-safe base64 WITH padding.
gen_fernet_key() {
  head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '+/' '-_'
}

# resolve <name> <override> <generator>: print nothing; write $SECRETS_DIR/<name>.
resolve() {
  name="$1" override="$2" generator="$3"
  file="${SECRETS_DIR}/${name}"
  if [ -n "${override}" ]; then
    value="${override}"
  elif [ -s "${file}" ]; then
    value="$(cat "${file}")"
  else
    value="$(${generator})"
  fi
  printf '%s' "${value}" > "${file}"
  chmod 600 "${file}"
}

resolve secret_key "${SECRET_KEY:-}" gen_secret_key
resolve integration_encryption_key "${INTEGRATION_ENCRYPTION_KEY:-}" gen_fernet_key

# Assemble the file the other services source. Values are base64url (or an
# operator-supplied string), single-quoted so the shell never interprets them.
env_file="${SECRETS_DIR}/env"
{
  printf "export SECRET_KEY='%s'\n" "$(cat "${SECRETS_DIR}/secret_key")"
  printf "export INTEGRATION_ENCRYPTION_KEY='%s'\n" "$(cat "${SECRETS_DIR}/integration_encryption_key")"
} > "${env_file}"
chmod 600 "${env_file}"

if [ -n "${SECRETS_OWNER}" ]; then
  chown -R "${SECRETS_OWNER}" "${SECRETS_DIR}"
fi

echo "demo secrets ready in ${SECRETS_DIR} (values not logged)"

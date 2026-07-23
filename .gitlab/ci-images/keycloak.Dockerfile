# Custom CI image for the Keycloak *service* in the `sso:integration` job (#2274).
#
# Bakes the static realm export (.gitlab/keycloak/trueppm-realm.json) into the
# image's import directory so the service starts with `start-dev --import-realm`
# and comes up with a ready realm — a deterministic, fast, no-runtime-provisioning
# setup (kcadm/Admin-API scripting at job time would be slower and flakier).
#
# The realm defines a confidential `trueppm-web` client (redirect URI
# http://127.0.0.1:8000/api/v1/auth/oidc/callback/) and one email-verified test
# user, matching what packages/api seed_sso_keycloak provisions on the TruePPM side.
#
# GitLab `services:` containers cannot mount the job's checkout, so the only way to
# get the realm file into the Keycloak service is to bake it into an image — hence
# this Dockerfile + the `ci:build-keycloak-image` job (mirrors the
# ci:build-integration-image pattern).
#
# Rebuilt by `ci:build-keycloak-image` when the Dockerfile or the realm export
# changes, and on the nightly SSO schedule (so the service image is always fresh
# before the smoke runs).
#
# Pinned to a Keycloak 26.x tag; bump deliberately (a Keycloak major can change the
# discovery-document shape, which is exactly the drift this nightly smoke exists to
# catch — so the bump and the green smoke land together).
FROM quay.io/keycloak/keycloak:26.0

# `--import-realm` reads every *.json under /opt/keycloak/data/import at start.
COPY .gitlab/keycloak/trueppm-realm.json /opt/keycloak/data/import/trueppm-realm.json

# Bootstrap admin for the master realm (Keycloak 26 renamed KEYCLOAK_ADMIN* to
# KC_BOOTSTRAP_ADMIN_*). Only used to bring the server up; the smoke never calls
# the admin API.
ENV KC_BOOTSTRAP_ADMIN_USERNAME=admin \
    KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    KC_HEALTH_ENABLED=true

# Run as the non-root Keycloak user (uid 1000 — the base image's own default).
# Made explicit so this image never runs as root: the analyzer cannot resolve the
# base image's USER, and the realm file COPYed above is world-readable (0644), so
# uid 1000 still imports it fine.
USER 1000

# `start-dev` serves plain HTTP and relaxes hostname strictness — correct for a
# throwaway CI issuer reached over http://keycloak:8080. The realm import is
# idempotent on a fresh dev (H2) database.
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start-dev", "--import-realm", "--http-port=8080"]

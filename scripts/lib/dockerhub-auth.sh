#!/usr/bin/env bash
# Optional Docker Hub authentication for dind drills (#4202).
#
# Anonymous Docker Hub pulls are metered per egress IP, and every self-hosted
# runner shares one. The drills pull digest-pinned images (postgres, valkey,
# nginx, kindest/node, the chart's datastores) that cannot be rerouted through
# the Dependency Proxy (a digest ref cannot be re-tagged, and the proxy path is
# not a registry mirror), so the fix is to authenticate the pull instead.
#
# Both helpers are NO-OPS unless DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are set
# (masked CI/CD variables a maintainer creates), so an MR from a fork or a
# project without the token behaves exactly as before.
#
# Source this file; do not execute it.

dockerhub_auth_configured() {
  [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]
}

# `docker login` for dockerd pulls (compose service images, kindest/node).
dockerhub_login() {
  if ! dockerhub_auth_configured; then
    return 0
  fi
  echo "${DOCKERHUB_TOKEN}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin docker.io >/dev/null
  echo "docker login docker.io (authenticated Docker Hub pulls)"
}

# Emit a kind `containerdConfigPatches` block on stdout (nothing when
# unconfigured). A kind node's containerd ignores dockerd's stored credentials,
# so it needs its own. Targets containerd 1.7's CRI plugin path, which is what
# the kind release pinned in CI ships; revisit when kind moves to containerd 2.
dockerhub_kind_containerd_patch() {
  if ! dockerhub_auth_configured; then
    return 0
  fi
  cat <<PATCH
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry.configs."registry-1.docker.io".auth]
      username = "${DOCKERHUB_USERNAME}"
      password = "${DOCKERHUB_TOKEN}"
PATCH
}

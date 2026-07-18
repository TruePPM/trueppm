# Custom CI image for the .wasm job template in .gitlab-ci.yml.
#
# Pre-installs the wasm toolchain the four wasm:* jobs otherwise rebuild on
# every run — the clippy component, the wasm32-unknown-unknown target, a pinned
# wasm-pack, a pinned cargo-deny, and a warm cargo registry cache of the crate's
# dependency tree. Each wasm:* job then skips the rustup adds, the tool
# downloads, and the crates.io index update + source download, leaving only the
# compile (~40s) that the deliberately-absent target/ cache does not cover.
#
# Mirrors .gitlab/ci-images/scheduler.Dockerfile — see #640 (ci-api image) and
# #651 (ci-scheduler image) for the established metadata-only stub pattern.
#
# NB the target/ build cache is intentionally NOT baked (nor cached on disk):
# it is ~1 GB and was exhausting shared-runner disk (issues #29/#30). Baking the
# *registry* cache is cheap (crate sources only, no compiled artifacts) and
# removes the network-bound part of a cold `cargo build`; the compile stays.
#
# Rebuilt by the `ci:build-wasm-image` job when any of the following change:
#   - packages/wasm-scheduler/Cargo.lock
#   - packages/wasm-scheduler/Cargo.toml
#   - .gitlab/ci-images/wasm.Dockerfile
# or on a scheduled pipeline (weekly safety net for transitive drift).
#
# Tagged `:1.85` — matches the rust toolchain the crate targets. Bump the tag +
# digest together when the Rust version moves.
#
# Base image pinned by digest (#904 supply-chain hardening — OpenSSF Scorecard
# "Pinned-Dependencies"). Renovate (pinDigests) keeps the digest current; bump
# the tag + digest together. Resolve a new digest with:
#   docker buildx imagetools inspect rust:1.85-slim --format '{{.Manifest.Digest}}'
FROM rust:1.85-slim@sha256:9f841bbe9e7d8e37ceb96ed907265a3a0df7f44e3737d0b100e7907a679acb36

# git is needed by cargo-deny's advisories check (it clones the RustSec
# advisory DB via git on first run); curl + ca-certificates fetch the pinned
# wasm-pack / cargo-deny release tarballs below.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Bake the toolchain bits the .wasm before_script used to add on every run.
RUN rustup component add clippy \
 && rustup target add wasm32-unknown-unknown

# Pinned, checksum-verified wasm-pack — same version + hash the wasm:build job
# installed inline (#904 supply-chain hardening; the sha256 is the published
# v0.13.1 musl tarball). The static musl binary runs on this glibc base. Bump
# version + hash together when upgrading, in lockstep with .gitlab-ci.yml.
RUN WASM_PACK_VERSION=0.13.1 \
 && WASM_PACK_SHA256=c539d91ccab2591a7e975bcf82c82e1911b03335c80aa83d67ad25ed2ad06539 \
 && WASM_PACK_TARBALL="wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
 && curl -sSfL "https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${WASM_PACK_TARBALL}" -o /tmp/wasm-pack.tar.gz \
 && echo "${WASM_PACK_SHA256}  /tmp/wasm-pack.tar.gz" | sha256sum -c - \
 && tar xzf /tmp/wasm-pack.tar.gz -C /usr/local/bin --strip-components=1 "wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl/wasm-pack" \
 && rm /tmp/wasm-pack.tar.gz

# cargo-deny 0.19.9 — same pinned release the wasm:license-check job installed
# inline. 0.19.x is required to parse CVSS 4.0 entries in the live RustSec DB.
# Download to a file first (rather than curl|tar) so a failed download aborts
# the build instead of being masked by the pipe. (The upstream release publishes
# no per-asset sha256; this matches the prior in-job install exactly, so baking
# it is no worse and freezes the binary in a reviewed layer. Bump version
# together with .gitlab-ci.yml's reference.)
RUN CARGO_DENY_VERSION=0.19.9 \
 && CARGO_DENY_DIR="cargo-deny-${CARGO_DENY_VERSION}-x86_64-unknown-linux-musl" \
 && curl -sSfL "https://github.com/EmbarkStudios/cargo-deny/releases/download/${CARGO_DENY_VERSION}/${CARGO_DENY_DIR}.tar.gz" -o /tmp/cargo-deny.tar.gz \
 && tar xzf /tmp/cargo-deny.tar.gz -C /usr/local/bin --strip-components=1 "${CARGO_DENY_DIR}/cargo-deny" \
 && rm /tmp/cargo-deny.tar.gz

# Warm the cargo registry cache with the crate's locked dependency tree. Copy
# only the manifest + lockfile (not the source) and stub the lib target so
# `cargo fetch` can resolve and download every dependency to CARGO_HOME. The
# real source is layered on at CI runtime; the downloaded crate sources stay
# resident so a cold `cargo build/clippy/test/deny` skips the crates.io index
# update and source download. --locked proves Cargo.lock fully describes the
# graph (image rebuilds whenever it changes).
WORKDIR /opt/ci-deps/wasm-scheduler
COPY packages/wasm-scheduler/Cargo.toml ./Cargo.toml
COPY packages/wasm-scheduler/Cargo.lock ./Cargo.lock
RUN mkdir -p src \
 && echo '// stub for cargo fetch — real source layered on at CI runtime' > src/lib.rs \
 && cargo fetch --locked \
 && rm -rf /opt/ci-deps

# Run the CI jobs as a non-root user (Sonar dockerfile:S6471, defense-in-depth
# for a build container that pulls the repo + third-party deps). uid 1000 owns
# CARGO_HOME so the job-time cargo registry reads and cargo-deny's advisory-DB
# clone still write without root. RUSTUP_HOME stays root-owned but is
# world-readable, so the baked toolchain resolves for the ci user.
RUN useradd --uid 1000 --create-home --shell /bin/bash ci \
 && chown -R ci "$CARGO_HOME"
USER ci

WORKDIR /

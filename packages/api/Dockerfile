# ---------------------------------------------------------------------------
# Stage 1: builder — compile dependencies into a virtual environment
# ---------------------------------------------------------------------------
FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9 AS builder

# `apt-get upgrade` (not just `update`) so this layer carries the Debian
# security team's latest point-release patches even when the upstream
# `python:3.11-slim` tag itself hasn't been rebuilt since the last CVE
# disclosure — the base image is a floating tag, and Docker's local layer
# cache can also serve a stale pull. Without this, the pre-tag Trivy gate in
# scripts/release.sh (and CI's api:publish) can fail on OS-package CVEs
# (gzip/perl/openssl/sqlite/pcre2, seen at the 0.4.0-beta.1 cut) that have
# nothing to do with this image's own dependencies. Build-stage CVEs never
# ship (this stage is discarded), so this line matters only for the runtime
# stage below — kept here too so both stages patch identically.
RUN apt-get update -qq && \
    apt-get upgrade -y -qq && \
    apt-get install -y -qq --no-install-recommends build-essential libpq-dev && \
    rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# python:3.11-slim seeds the venv with wheel 0.45.1 via ensurepip (3.11 still
# bundles wheel; 3.12 dropped it). That build tool is copied wholesale into the
# runtime /venv and trips Trivy on CVE-2026-24049 (privilege escalation / arbitrary
# code execution via a malicious wheel, fixed in 0.46.2). Patch it forward before
# the package installs so the published image scans clean (#1388); the upgraded
# wheel persists in /venv through the COPY into the runtime stage.
# --only-binary :all: keeps this a wheel-only install so no sdist setup script
# ever executes during the build (wheel ships a manylinux wheel, so the flag is
# safe here — unlike the local source/[c] installs below).
RUN pip install --only-binary :all: --no-cache-dir --upgrade "wheel>=0.46.2"

# `uv` is a build-only tool used below to resolve dependencies from the
# checked-in lockfile instead of `pip`'s live-PyPI resolution (#4078). It
# installs into this SAME venv (there is no separate build-tool venv), and
# this venv is copied wholesale into the runtime stage — so unlike the
# apt-get/build-essential tooling above (which lives outside $VIRTUAL_ENV and
# is naturally left behind), `uv` does NOT disappear on its own. It is
# `pip uninstall`ed explicitly right after its last use below, before any
# runtime-stage COPY can pick it up (verified: an earlier version of this
# fix shipped it into the runtime image and `check-api-image-lock.py` caught
# it as an "UNLOCKED" package). Pinned exact (not a floor) because
# `uv export`'s output shape is a build input, not a runtime dependency: a
# version drift here should be a deliberate bump, not something that
# silently changes on the next `docker build`.
RUN pip install --only-binary :all: --no-cache-dir "uv==0.9.5"

# Install the scheduler package first so the api package can find it on the path.
COPY packages/scheduler/src /build/scheduler/src
# CHANGELOG.md is force-included into the wheel (scheduler pyproject
# force-include, #945); the build fails without it present here.
COPY packages/scheduler/pyproject.toml packages/scheduler/README.md packages/scheduler/CHANGELOG.md /build/scheduler/
RUN pip install --no-cache-dir /build/scheduler

# The `[c]` extra (below) compiles psycopg's C speedups against the system
# libpq (libpq-dev, installed above) so OS-level libpq/OpenSSL security
# upgrades reach the driver — the recommended production posture (the
# precompiled `[binary]` wheel bundles its own libpq and is dev-only). The
# runtime stage ships libpq5 for the compiled extension.
#
# The extra is a build ARG so local dev can opt into `[binary]` (a prebuilt
# wheel — no from-source compile, ~4 min faster) while the published image keeps
# `[c]` (#1955). The default is `c`, so any build that omits the arg — CI,
# release, `docker build` by hand — gets the hardened production driver
# unchanged; only docker-compose.yml overrides it to `binary` for local speed.
ARG PSYCOPG_EXTRA=c

# Resolve every OTHER runtime dependency from packages/api/uv.lock — the lock
# CI tested against — instead of a fresh `pip` resolution against whatever
# PyPI serves on the day of the build (#4078). How this bit before this fix:
# opentelemetry-exporter-otlp-proto-http 1.45 dropped its `requests` import in
# favor of urllib3; uv.lock pinned 1.43 (which still needed `requests`), and
# every dev/test environment got `requests` from an unrelated dev dependency,
# so the whole suite stayed green while only the image — the one thing that
# actually resolved against live PyPI — crashed in `django.setup()` (#4076).
#
# `trueppm-scheduler` is deliberately excluded from the export
# (--no-emit-package): the LOCAL source copied in above is what must ship —
# this exact commit's code, not whatever release the lock happened to record
# trueppm-scheduler at (packages/api/uv.lock resolves it against the PyPI
# registry, not this checkout — see scripts/check-api-scheduler-lock.sh for
# why that pin is allowed to trail). Its own dependencies (networkx, numpy)
# are NOT excluded: they stay pinned to the exact versions the lock resolved,
# so the locally-built scheduler still runs against the same numeric stack CI
# tested, rather than whatever its own unpinned pyproject ranges would
# resolve fresh.
#
# --require-hashes verifies every downloaded artifact against the hash uv
# recorded at lock time — the supply-chain hardening the previous unpinned
# `pip install` had no way to do. This requires every entry in the export to
# carry a hash, which holds here because the only two hash-less members of
# the dependency graph (trueppm-api itself and trueppm-scheduler) are both
# excluded above (--no-emit-project, --no-emit-package).
COPY packages/api/pyproject.toml packages/api/uv.lock /build/api/
RUN cd /build/api && \
    uv export --frozen --no-dev --no-emit-project \
      --no-emit-package trueppm-scheduler \
      --extra "${PSYCOPG_EXTRA}" \
      -o /build/requirements.txt && \
    uv export --frozen --no-dev --no-emit-project \
      --no-emit-package trueppm-scheduler \
      --extra "${PSYCOPG_EXTRA}" --no-hashes \
      -o /build/requirements-locked.txt && \
    pip uninstall -y uv && \
    pip install --no-cache-dir --require-hashes -r /build/requirements.txt

# Install the api package itself. Its dependencies were all installed from
# the lock above, so --no-deps stops pip from re-resolving them against
# PyPI — the exact step that reopens the gap this fix closes if it is ever
# dropped.
COPY packages/api /build/api
RUN pip install --no-cache-dir --no-deps /build/api

# Prove the image can actually boot before it ships (#4078's other acceptance
# criterion): `django.setup()` is what #4076 crashed inside of
# (ModuleNotFoundError, via allauth's openid_connect provider importing
# `requests` at import time). Runs in every build — local `docker build`,
# `docker compose`, CI, and release — not only the CI gate below, so a
# regression is caught at the earliest possible point regardless of how the
# image was built. `trueppm_api.settings.dev` + TRUEPPM_ALLOW_DEV_SETTINGS
# mirrors the exact env docker-compose.yml already uses to boot this image
# locally (see the `api`/`api-worker`/`api-beat` services there); these three
# ENV values are build-stage only and are never copied into the runtime
# image (the runtime stage starts a fresh FROM and sets its own environment).
ENV DJANGO_SETTINGS_MODULE=trueppm_api.settings.dev
ENV TRUEPPM_ALLOW_DEV_SETTINGS=1
ENV SECRET_KEY=dev-secret-key-change-in-prod
RUN /venv/bin/python -c "import django; import trueppm_scheduler; django.setup(); print('boot smoke: OK')"

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with only what is needed to run
# ---------------------------------------------------------------------------
FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9 AS runtime

# See the matching comment in the builder stage above — this is the stage that
# actually ships, so this `upgrade` is the one that matters for the Trivy gate.
RUN apt-get update -qq && \
    apt-get upgrade -y -qq && \
    apt-get install -y -qq --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /venv /venv

# Remove the Python build tools (pip/setuptools/wheel) from BOTH the base image's
# system Python (/usr/local) and the application venv. The app runs entirely from
# /venv via uvicorn (see ENV PATH below) and never invokes them at runtime, but
# Trivy scans them and fails the release on their fixable CVEs. The findings live
# in TWO copies: the base image's system site-packages, and — the one #1388
# missed — setuptools' OWN vendored deps inside the venv
# (setuptools/_vendor/wheel-0.45.1 → CVE-2026-24049 and
# setuptools/_vendor/jaraco.context-5.3.0 → CVE-2026-23949). #1388 upgraded only
# the top-level venv wheel (0.47.0), leaving both vendored copies. Removing the
# unused tooling keeps the published image clean and immunizes the release gate
# against future build-tool CVEs — our source imports neither setuptools nor
# pkg_resources, and `manage.py check` passes without them. `python` is the
# system interpreter here (this runs before ENV PATH=/venv/bin); pip uninstalls
# itself last when listed after its peers.
RUN python -m pip uninstall -y wheel setuptools pip \
 && /venv/bin/python -m pip uninstall -y wheel setuptools pip

# manage.py is not installed by pip — copy it explicitly so management
# commands (migrate, collectstatic, create_admin) are available at runtime.
COPY --from=builder /build/api/manage.py /app/manage.py

# The exact locked requirement set the builder stage resolved and installed
# from (packages/api/uv.lock) — a --no-hashes export purely for readability
# here; the hash-verified copy that actually gated the install
# (/build/requirements.txt) never leaves the builder stage. `api:image-lock-
# check` (.gitlab-ci.yml) diffs this file against `importlib.metadata` inside
# THIS image to prove nothing after the frozen install (a stray unpinned
# `pip install`, a future Dockerfile edit) moved a version away from the lock
# (#4078). Also a small, self-contained audit artifact for anyone inspecting
# a running image.
COPY --from=builder /build/requirements-locked.txt /app/requirements-locked.txt

# This image redistributes psycopg (LGPL-3.0). LGPL-3.0 §4(a) requires the
# notice and full license texts to travel with each copy of the distributed
# work, and the image is the primary redistribution vehicle (compose/Helm pull
# it). The build context is the repo root (docker-compose.yml + api:publish both
# use `.`), so copy them straight from the context.
COPY NOTICES /app/NOTICES
COPY licenses /app/licenses

# TruePPM's own Apache-2.0 text, which NOTICES deliberately does not carry — it
# covers only *third-party* components and points readers at "the LICENSE file at
# the repository root". That file was never copied into the image, so the primary
# redistribution vehicle for TruePPM's own code (including the compiled
# wasm-scheduler in the web bundle) shipped without the license Apache 2.0 §4(a)
# requires recipients to receive (#2632).
COPY LICENSE /app/LICENSE

# TruePPM's own copyright notice. Apache 2.0 §4(d) requires a distribution to carry
# the Work's NOTICE file, and NOTICES (third-party only) does not name the copyright
# holder (#3761).
COPY NOTICE /app/NOTICE

# Create a non-root user (uid=1000) to run the application, and pre-create every
# directory a named volume gets mounted onto.
#
# Pre-creating them is load-bearing, not tidiness: Docker seeds a fresh named
# volume from the image's directory at that path, INCLUDING its ownership. A path
# the image does not contain yields an empty, ROOT-owned volume that this
# non-root user cannot write to.
#
#   /app/staticfiles  — collectstatic writes here at startup.
#   /run/trueppm      — create_admin writes the generated admin password here
#                       (#2830). Missing until now, so on the compose stack the
#                       write failed with EACCES and the command fell back to
#                       printing the credential on stdout — into container logs,
#                       the exact disclosure the file-based handoff exists to
#                       avoid — while the documented
#                       `docker compose exec api cat /run/trueppm/admin_password`
#                       could never succeed.
# /var/lib/trueppm/media is settings.base's MEDIA_ROOT default (#3184) — where
# task attachments and the workspace logo land on local-disk storage. Created
# and chowned here for the same reason /app/staticfiles is: the container runs
# as uid 1000, which cannot mkdir under /var/lib at runtime. Baking it also
# sharpens the boot guard's answer — on a writable root filesystem the path
# exists and the deploy starts; on readOnlyRootFilesystem it exists and is
# unwritable, so the guard refuses the deploy instead of letting the first
# upload EROFS. Mount a volume here to make uploads durable.
RUN useradd --uid 1000 --no-create-home --shell /sbin/nologin trueppm && \
    mkdir -p /app/staticfiles /run/trueppm /var/lib/trueppm/media && \
    chown trueppm /app/staticfiles /run/trueppm /var/lib/trueppm/media

ENV PATH="/venv/bin:$PATH"

WORKDIR /app

USER trueppm

EXPOSE 8000

CMD ["uvicorn", "trueppm_api.asgi:application", "--host", "0.0.0.0", "--port", "8000"]

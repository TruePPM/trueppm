# ---------------------------------------------------------------------------
# Stage 1: builder — compile dependencies into a virtual environment
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS builder

RUN apt-get update -qq && \
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

# Install the scheduler package first so the api package can find it on the path.
COPY packages/scheduler/src /build/scheduler/src
# CHANGELOG.md is force-included into the wheel (scheduler pyproject
# force-include, #945); the build fails without it present here.
COPY packages/scheduler/pyproject.toml packages/scheduler/README.md packages/scheduler/CHANGELOG.md /build/scheduler/
RUN pip install --no-cache-dir /build/scheduler

# Install the api package and its dependencies. The `[c]` extra compiles
# psycopg's C speedups against the system libpq (libpq-dev, installed above) so
# OS-level libpq/OpenSSL security upgrades reach the driver — the recommended
# production posture (the precompiled `[binary]` wheel bundles its own libpq and
# is dev-only). The runtime stage ships libpq5 for the compiled extension.
#
# The extra is a build ARG so local dev can opt into `[binary]` (a prebuilt
# wheel — no from-source compile, ~4 min faster) while the published image keeps
# `[c]` (#1955). The default is `c`, so any build that omits the arg — CI,
# release, `docker build` by hand — gets the hardened production driver
# unchanged; only docker-compose.yml overrides it to `binary` for local speed.
ARG PSYCOPG_EXTRA=c
COPY packages/api /build/api
RUN pip install --no-cache-dir "/build/api[${PSYCOPG_EXTRA}]"

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with only what is needed to run
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

RUN apt-get update -qq && \
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

# ---------------------------------------------------------------------------
# Stage 1: builder — compile dependencies into a virtual environment
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS builder

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends build-essential libpq-dev && \
    rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/venv
RUN python -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# python:3.11-slim seeds the venv with wheel 0.45.1 via ensurepip (3.11 still
# bundles wheel; 3.12 dropped it). That build tool is copied wholesale into the
# runtime /venv and trips Trivy on CVE-2026-24049 (privilege escalation / arbitrary
# code execution via a malicious wheel, fixed in 0.46.2). Patch it forward before
# the package installs so the published image scans clean (#1388); the upgraded
# wheel persists in /venv through the COPY into the runtime stage.
RUN pip install --no-cache-dir --upgrade "wheel>=0.46.2"

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
COPY packages/api /build/api
RUN pip install --no-cache-dir "/build/api[c]"

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

# Create a non-root user (uid=1000) to run the application and pre-create
# the staticfiles directory so collectstatic can write there at startup.
RUN useradd --uid 1000 --no-create-home --shell /sbin/nologin trueppm && \
    mkdir -p /app/staticfiles && \
    chown trueppm /app/staticfiles

ENV PATH="/venv/bin:$PATH"

WORKDIR /app

USER trueppm

EXPOSE 8000

CMD ["uvicorn", "trueppm_api.asgi:application", "--host", "0.0.0.0", "--port", "8000"]

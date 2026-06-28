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

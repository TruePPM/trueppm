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

# Install the scheduler package from the repo src/ directory first so the
# api package can declare it as a dependency and find it on the path.
COPY src /build/scheduler/src
COPY pyproject.toml /build/scheduler/pyproject.toml
RUN pip install --no-cache-dir /build/scheduler

# Install the api package and its dependencies.
COPY packages/api /build/api
RUN pip install --no-cache-dir /build/api

# ---------------------------------------------------------------------------
# Stage 2: runtime — lean image with only what is needed to run
# ---------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends libpq5 && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /venv /venv

# Create a non-root user (uid=1000) to run the application.
RUN useradd --uid 1000 --no-create-home --shell /sbin/nologin trueppm

ENV PATH="/venv/bin:$PATH"

WORKDIR /app

USER trueppm

EXPOSE 8000

ENTRYPOINT ["uvicorn", "trueppm_api.asgi:application", "--host", "0.0.0.0", "--port", "8000"]

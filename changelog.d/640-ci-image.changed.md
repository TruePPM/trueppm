- **CI / harness speed wins (kaizen #640, part 2 — custom ci-api image)**:
  - New `.gitlab/ci-images/api.Dockerfile` pre-bakes libpq-dev, gcc, git and
    the full dev-dep wheel tree of `packages/scheduler` and `packages/api`.
    Published to `registry.gitlab.com/trueppm/trueppm/ci-api:py3.11`.
  - New `ci:build-api-image` job rebuilds and pushes the image when the
    Dockerfile or either pyproject.toml changes, plus on a weekly scheduled
    pipeline as a safety net against transitive dep drift.
  - `.api` and `.api-no-db` job templates now pull the custom image; the
    runtime `pip install -e` is a fast editable re-link instead of a cold
    wheel-download. Saves ~3 minutes off each of the six affected
    `api:*` jobs.
  - `api:type-check` no longer redefines `before_script`; the template's
    `api[dev]` install gives it the mypy stubs it needs.
  - `license:check` `changes:` filter narrowed to dep-manifest files only
    (lock files, `pyproject.toml`, `Cargo.toml`) — previously triggered on
    every MR touching source. Main pushes and weekly scheduled pipelines
    still run it for transitive-drift coverage. Also switched to the
    `ci-api` image so the apt-get + pip-install setup is no longer paid
    per run.

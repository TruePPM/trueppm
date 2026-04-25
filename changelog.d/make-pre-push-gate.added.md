- Added `make pre-push` Makefile target that mirrors the CI gate locally
  (lint, typecheck, `makemigrations --check`, openapi schema drift). Wired
  as a pre-push hook in `.pre-commit-config.yaml` so `git push` blocks on
  the same checks GitLab CI runs. Catches missing migrations, stale
  `docs/api/openapi.json`, and `ruff format` drift before they reach CI.

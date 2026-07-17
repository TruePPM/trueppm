# TruePPM — universal command interface
# Run `make help` for a list of targets.

.PHONY: help setup doctor lint typecheck test build clean up down logs admin up-prod \
        migrations-check migrations-numbering schema-check web-lint web-typecheck pre-push pre-push-checks \
        pre-push-behind-warn pre-push-collision-check pre-push-wasm pre-push-mobile mobile-lint mobile-typecheck \
        coverage-diff coverage-diff-scheduler coverage-diff-api coverage-diff-web sonar \
        release-smoke screenshots wt-new wt-list wt-remove wt-prune wt-doctor

# Diff-coverage gate config. New code on this branch (vs $(COVERAGE_DIFF_BASE))
# must hit at least $(COVERAGE_DIFF_MIN)% line coverage.
# Staged: 75 pre-beta, 80 at beta, 90 at 1.0.
COVERAGE_DIFF_MIN ?= 75
COVERAGE_DIFF_BASE ?= origin/main

# ─── Help ──────────────────────────────────────────────────────────────────────
help:
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make <target>\n\nTargets:\n"} \
	     /^[a-zA-Z_-]+:.*?##/ {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ─── Setup ────────────────────────────────────────────────────────────────────
setup: ## Install git hooks and verify prerequisites
	@bash scripts/setup-hooks.sh
	@echo "Run 'make doctor' to verify all prerequisites."

# ─── Doctor ───────────────────────────────────────────────────────────────────
doctor: ## Verify all development prerequisites
	@bash scripts/doctor.sh

# ─── Worktrees (parallel multi-issue work) ───────────────────────────────────
# Thin Makefile wrappers around scripts/wt so the workflow is discoverable
# via `make help`. Full docs: docs/getting-started/parallel-worktrees.md.

wt-new: ## Create a worktree for an issue (usage: make wt-new ISSUE=600)
	@if [ -z "$(ISSUE)" ]; then \
	  echo "usage: make wt-new ISSUE=<issue-number-or-branch-name>" >&2; \
	  exit 2; \
	fi
	@bash scripts/wt new "$(ISSUE)"

wt-list: ## List active worktrees and current WIP count
	@bash scripts/wt list

wt-remove: ## Remove a worktree (usage: make wt-remove ISSUE=600)
	@if [ -z "$(ISSUE)" ]; then \
	  echo "usage: make wt-remove ISSUE=<issue-number-or-branch-name>" >&2; \
	  exit 2; \
	fi
	@bash scripts/wt remove "$(ISSUE)"

wt-prune: ## Remove worktrees whose branches were merged + deleted on origin
	@bash scripts/wt prune

wt-doctor: ## Verify worktree symlinks + shared Docker stack are healthy
	@bash scripts/wt doctor

# ─── Lint ─────────────────────────────────────────────────────────────────────
lint: lint-scheduler lint-api lint-web ## Lint all packages

lint-scheduler: ## Lint packages/scheduler (ruff)
	cd packages/scheduler && ruff check src/ tests/ && ruff format --check src/ tests/

lint-api: ## Lint packages/api (ruff)
	cd packages/api && ruff check src/ tests/ && ruff format --check src/ tests/

lint-web: ## Lint packages/web (eslint + design-system v2 gate)
	cd packages/web && npm run lint
	bash scripts/check-design-system-v2.sh

# ─── Type-check ───────────────────────────────────────────────────────────────
typecheck: typecheck-scheduler typecheck-api typecheck-web ## Type-check all packages

typecheck-scheduler: ## Type-check packages/scheduler (mypy)
	cd packages/scheduler && mypy

typecheck-api: ## Type-check packages/api (mypy)
	cd packages/api && mypy src/trueppm_api

typecheck-web: ## Type-check packages/web (tsc)
	cd packages/web && npm run typecheck

# ─── Test ─────────────────────────────────────────────────────────────────────
test: test-scheduler test-api test-web ## Run all package test suites

test-scheduler: ## Run packages/scheduler tests (pytest)
	cd packages/scheduler && pytest --tb=short -q

test-api: ## Run packages/api tests (pytest — requires running DB + Redis)
	cd packages/api && pytest --tb=short -q

test-web: ## Run packages/web tests (vitest)
	cd packages/web && npm test

# ─── CI gate replicas ─────────────────────────────────────────────────────────
# These targets mirror the CI jobs that gate every MR. Run `make pre-push`
# before `git push` to catch failures locally instead of in CI.

migrations-check: ## Verify no missing Django migrations (uses the api container if up, else a local venv fallback)
	@# Prefer the running api container. In a per-issue worktree the shared stack
	@# often has db/celery up but NOT api (scripts/wt), so the container exec aborts
	@# with "service api is not running" and the push gets bypassed with --no-verify
	@# (#703). Fall back to the symlinked venv, forcing PYTHONPATH=src so the *worktree*
	@# source is checked — not main's editable install. makemigrations --check is a
	@# model-vs-files diff and makes no DB connection; DATABASE_URL only has to parse.
	@if [ -n "$$(docker compose ps -q api 2>/dev/null)" ]; then \
	  docker compose exec -T api python manage.py makemigrations --check --dry-run; \
	else \
	  echo "→ migrations-check: api container not running — using local venv (PYTHONPATH=src)"; \
	  cd packages/api && \
	    PYTHONPATH=src \
	    TRUEPPM_ALLOW_DEV_SETTINGS=1 \
	    DATABASE_URL="$${DATABASE_URL:-postgres://trueppm:trueppm@localhost:5432/trueppm}" \
	    .venv/bin/python manage.py makemigrations --check --dry-run; \
	fi

migrations-numbering: ## Detect cross-branch migration-numbering collisions vs origin/main (no DB)
	@# Closes the gap makemigrations --check misses: it only sees this tree, so two
	@# parallel branches can each create projects/0080_*.py, both pass, and the second
	@# merge leaves main with two leaf migrations. This compares the branch against
	@# origin/main and fails if a new migration reuses a number main already assigns.
	@# Best-effort fetch (mirrors pre-push-behind-warn); the script skips cleanly if
	@# origin/main is unavailable offline — the CI job fetches it explicitly.
	@git fetch origin main --quiet 2>/dev/null || true
	@python3 scripts/check-migration-numbering.py origin/main

schema-check: ## Verify docs/api/openapi.json matches the live DRF schema
	bash scripts/export-openapi.sh --check

api-lint: ## Run the api:lint CI job locally (ruff check + format --check)
	cd packages/api && ruff check src/ tests/ && ruff format --check src/ tests/

api-typecheck: ## Run the api:type-check CI job locally (mypy)
	cd packages/api && mypy src/trueppm_api

scheduler-lint: ## Run the scheduler:lint CI job locally (ruff check + format --check)
	cd packages/scheduler && ruff check src/ tests/ && ruff format --check src/ tests/

scheduler-typecheck: ## Run the scheduler:type-check CI job locally (mypy)
	cd packages/scheduler && mypy

web-lint: ## Run the web:lint CI job locally (eslint on packages/web/src)
	cd packages/web && npm run lint

web-typecheck: ## Run the web:type-check CI job locally (tsc --noEmit)
	cd packages/web && npx tsc --noEmit

mobile-lint: ## Run the mobile:lint CI job locally (eslint on packages/mobile/src)
	cd packages/mobile && npm run lint

mobile-typecheck: ## Run the mobile:type-check CI job locally (tsc --noEmit)
	cd packages/mobile && npx tsc --noEmit

pre-push-mobile: ## Run the mobile:lint + mobile:type-check CI gates locally, change-gated to packages/mobile
	@# Mirrors pre-push-wasm: the CI mobile:lint / mobile:type-check jobs run only
	@# on the ~few% of MRs that touch packages/mobile. Change-gated against
	@# origin/main and skipped when packages/mobile/node_modules is absent — the
	@# package is self-contained (not part of the shared web node_modules symlink),
	@# so a non-mobile push stays inside the ~60s pre-push budget. Like web:lint,
	@# eslint requires node >=18 (the documented node17 pre-push gotcha applies).
	@if ! git diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^packages/mobile/'; then \
	  echo "→ mobile lint/type-check: no packages/mobile changes — skipped"; \
	elif [ ! -d packages/mobile/node_modules ]; then \
	  echo "→ mobile lint/type-check: packages/mobile/node_modules absent (run npm ci there) — skipped"; \
	else \
	  echo "→ mobile lint/type-check"; \
	  cd packages/mobile && npm run lint && npx tsc --noEmit; \
	fi

pre-push-wasm: ## Run the wasm:lint CI gate locally (cargo clippy -D warnings), change-gated to packages/wasm-scheduler
	@# Mirrors the CI wasm:lint job, which runs `cargo clippy --all-targets -- -D
	@# warnings` and blocks the pipeline on the ~12% of MRs that touch the wasm
	@# package — a failure class make pre-push otherwise leaves to a ~7min CI
	@# round-trip (#912). CI gates clippy ONLY (no cargo fmt --check), so we don't
	@# add a fmt gate here either: pre-push exists to catch what CI fails on, and a
	@# stricter local gate would block pushes CI would accept. Change-gated against
	@# origin/main (mirror of CI rules-wasm) and skipped when cargo is absent, so a
	@# non-wasm push stays inside the ~60s pre-push budget.
	@if ! command -v cargo >/dev/null 2>&1; then \
	  echo "→ wasm clippy: cargo not installed — skipped"; \
	elif ! git diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^packages/wasm-scheduler/'; then \
	  echo "→ wasm clippy: no packages/wasm-scheduler changes — skipped"; \
	else \
	  echo "→ wasm clippy"; \
	  cd packages/wasm-scheduler && cargo clippy --all-targets -- -D warnings; \
	fi

# ─── Diff coverage ────────────────────────────────────────────────────────────
# Enforces ≥ $(COVERAGE_DIFF_MIN)% coverage on lines changed vs $(COVERAGE_DIFF_BASE).
# Each per-package target skips itself if no files in that package changed,
# so a docs-only branch finishes in seconds.

coverage-diff: coverage-diff-scheduler coverage-diff-api coverage-diff-web ## Diff-coverage gate (≥ $(COVERAGE_DIFF_MIN)% on changed lines)

coverage-diff-scheduler: ## Diff coverage for packages/scheduler
	@if git diff --name-only $(COVERAGE_DIFF_BASE)...HEAD | grep -q '^packages/scheduler/'; then \
	  echo "→ scheduler diff coverage"; \
	  cd packages/scheduler && \
	    pytest --cov=trueppm_scheduler --cov-report=xml --tb=short -q && \
	    diff-cover coverage.xml --compare-branch=$(COVERAGE_DIFF_BASE) --fail-under=$(COVERAGE_DIFF_MIN); \
	else \
	  echo "→ scheduler diff coverage: no changes — skipped"; \
	fi

# api tests run inside the api container (testcontainers + Postgres). The
# container mounts only ./packages/api/src, so coverage.xml is extracted with
# `docker compose cp`. diff-cover runs from packages/api so XML paths
# (src/trueppm_api/...) resolve to git-toplevel paths correctly.
coverage-diff-api: ## Diff coverage for packages/api (requires `make up`)
	@if git diff --name-only $(COVERAGE_DIFF_BASE)...HEAD | grep -q '^packages/api/'; then \
	  echo "→ api diff coverage"; \
	  docker compose cp packages/api/tests/. api:/app/tests/; \
	  docker compose cp packages/api/conftest.py api:/app/conftest.py; \
	  docker compose exec -T -u root api pip install -q pytest pytest-django pytest-asyncio pytest-cov diff-cover 2>/dev/null; \
	  docker compose exec -T -w /app -e CI=1 -e COVERAGE_FILE=/tmp/.coverage api \
	    pytest --cov=trueppm_api --cov-report=xml:/tmp/coverage.xml --tb=short -q --reuse-db && \
	  docker compose cp api:/tmp/coverage.xml packages/api/coverage.xml && \
	  cd packages/api && \
	    diff-cover coverage.xml --compare-branch=$(COVERAGE_DIFF_BASE) --fail-under=$(COVERAGE_DIFF_MIN); \
	else \
	  echo "→ api diff coverage: no changes — skipped"; \
	fi

coverage-diff-web: ## Diff coverage for packages/web
	@if git diff --name-only $(COVERAGE_DIFF_BASE)...HEAD | grep -q '^packages/web/'; then \
	  echo "→ web diff coverage"; \
	  out=$$(mktemp); \
	  ( cd packages/web && npm run test:coverage ) > $$out 2>&1; \
	  rc=$$?; \
	  awk '/^Error: AggregateError$$/ { skip=1; next } skip && /^[[:space:]]+at / { next } skip && /^[[:space:]]*$$/ { next } { skip=0; print }' $$out; \
	  rm -f $$out; \
	  if [ $$rc -ne 0 ]; then exit $$rc; fi; \
	  sed 's|^SF:|SF:packages/web/|' packages/web/coverage/lcov.info > packages/web/coverage/lcov.diffcover.info && \
	    diff-cover packages/web/coverage/lcov.diffcover.info --compare-branch=$(COVERAGE_DIFF_BASE) --fail-under=$(COVERAGE_DIFF_MIN); \
	else \
	  echo "→ web diff coverage: no changes — skipped"; \
	fi

sonar: ## Run a local SonarCloud scan with coverage import (needs SONAR_TOKEN; run `make coverage-diff` first)
	scripts/sonar-scan.sh

pre-push-collision-check: ## Block the push if this branch's issue already has an open MR from another branch (#2000)
	@# Fail-fast duplicate-work guard: runs BEFORE the parallel code gates so a
	@# duplicate MR aborts the push in ~1 glab call rather than after ~60s of
	@# lint/typecheck. Catches the `git checkout -b` path that bypasses the
	@# `scripts/wt` claim lock. Best-effort (passes when glab is unavailable);
	@# override with TRUEPPM_ALLOW_DUP_MR=1 for legitimate stacked MRs.
	@bash scripts/check-issue-collision.sh

pre-push-behind-warn: ## Warn (non-blocking) if HEAD is behind origin/main — catches schema/migration drift
	@# Best-effort: silent on network failure, only prints when a refetched
	@# origin/main is genuinely ahead of HEAD. CLAUDE.md "Always merge
	@# origin/main before regenerating openapi.json" is enforced by discipline;
	@# this is the warning that makes that discipline noticeable.
	@if git fetch origin main --quiet 2>/dev/null; then \
	  if ! git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then \
	    echo "⚠️  Branch is behind origin/main — rebase before push (avoids schema/migration drift on merge)"; \
	  fi; \
	fi

pre-push-checks: scheduler-lint scheduler-typecheck api-lint api-typecheck web-lint web-typecheck migrations-check migrations-numbering schema-check pre-push-wasm pre-push-mobile ## Run pre-push gate subtargets (use via `pre-push`, not directly)

pre-push: pre-push-collision-check pre-push-behind-warn ## Run pre-push CI gates in parallel (lint+typecheck, migrations, schema). Diff-coverage runs in CI only — run `make coverage-diff` to check locally.
	@# Re-invoke ourselves with -j to fan out the independent lint/typecheck/
	@# migration/schema jobs across cores. Output may interleave on failure;
	@# each subtarget prefixes its own output so attribution is still readable.
	@$(MAKE) -j 4 pre-push-checks
	@echo ""
	@echo "✅ Pre-push checks passed. Safe to git push."
	@# Best-effort sweep of merged worktrees after a successful gate run. Allowed
	@# to fail (e.g. offline) without blocking the push — pre-push's job is to
	@# validate the code, not the worktree state.
	@bash scripts/wt prune 2>/dev/null || true

# ─── Build ────────────────────────────────────────────────────────────────────
build: ## Build the web bundle
	cd packages/web && npm run build

# ─── Marketing screenshots ────────────────────────────────────────────────────
screenshots: ## Regenerate the marketing product shots to ~/Downloads (needs `npm run dev` on :5173)
	@# Deterministic mocked/clock-pinned shots for the marketing site + deck (#380).
	@# NOT part of `web:e2e` — runs via its own Playwright config. The web dev
	@# server must already be serving on :5173 (make up, or `npm run dev`).
	@# Full procedure: packages/web/e2e/README.md.
	cd packages/web && npm run screenshots

# ─── Dev ──────────────────────────────────────────────────────────────────────
up: ## Start the dev stack — web HMR :5173, API :8000, DB :5432
	docker compose up -d

down: ## Stop the dev stack
	docker compose down

logs: ## Tail dev stack logs
	docker compose logs -f

admin: ## Print the bootstrapped admin password (created on first `make up`)
	@docker compose exec api cat /tmp/trueppm_admin_password 2>/dev/null \
	  || echo "Password file not found — run 'make up' first, then retry."

# ─── Production ───────────────────────────────────────────────────────────────
up-prod: ## Start the production stack (requires .env — run init-prod.sh first)
	docker compose -f docker-compose.prod.yml up -d

release-smoke: ## Boot the dev stack, seed demo data, and curl every shipped endpoint
	@bash scripts/smoke-test.sh

# ─── Clean ────────────────────────────────────────────────────────────────────
clean: ## Remove generated files and caches
	rm -rf dist/ build/ \
	       packages/web/dist/ \
	       packages/scheduler/dist/ packages/scheduler/build/ \
	       packages/api/dist/ packages/api/build/ \
	       .coverage htmlcov/ coverage/ \
	       .mypy_cache/ .ruff_cache/ .pytest_cache/
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true

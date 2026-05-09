# TruePPM — universal command interface
# Run `make help` for a list of targets.

.PHONY: help setup doctor lint typecheck test build clean up down logs admin up-prod \
        migrations-check schema-check pre-push \
        coverage-diff coverage-diff-scheduler coverage-diff-api coverage-diff-web

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

# ─── Lint ─────────────────────────────────────────────────────────────────────
lint: lint-scheduler lint-api lint-web ## Lint all packages

lint-scheduler: ## Lint packages/scheduler (ruff)
	cd packages/scheduler && ruff check src/ tests/ && ruff format --check src/ tests/

lint-api: ## Lint packages/api (ruff)
	cd packages/api && ruff check src/ tests/ && ruff format --check src/ tests/

lint-web: ## Lint packages/web (eslint)
	cd packages/web && npm run lint

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

migrations-check: ## Verify no missing Django migrations (requires `make up`)
	docker compose exec -T api python manage.py makemigrations --check --dry-run

schema-check: ## Verify docs/api/openapi.json matches the live DRF schema
	bash scripts/export-openapi.sh --check

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
	  docker compose exec -T -e CI=1 api pytest --cov=trueppm_api --cov-report=xml --tb=short -q && \
	  docker compose cp api:/app/coverage.xml packages/api/coverage.xml && \
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

pre-push: migrations-check schema-check coverage-diff ## Run pre-push CI gates (lint/typecheck run at commit time via hooks)
	@echo ""
	@echo "✅ Pre-push checks passed. Safe to git push."

# ─── Build ────────────────────────────────────────────────────────────────────
build: ## Build the web bundle
	cd packages/web && npm run build

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

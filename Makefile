# TruePPM — universal command interface
# Run `make help` for a list of targets.

.PHONY: help setup doctor lint typecheck test build clean

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

# ─── Build ────────────────────────────────────────────────────────────────────
build: ## Build the web bundle
	cd packages/web && npm run build

# ─── Dev ──────────────────────────────────────────────────────────────────────
up: ## Start the full development stack (Docker Compose)
	docker compose up -d

admin: ## Create or update the dev admin user (reads DJANGO_SUPERUSER_* env vars, defaults: admin@trueppm.dev / admin)
	DJANGO_SUPERUSER_EMAIL=$${DJANGO_SUPERUSER_EMAIL:-admin@trueppm.dev} \
	DJANGO_SUPERUSER_PASSWORD=$${DJANGO_SUPERUSER_PASSWORD:-admin} \
	docker compose run --rm api python manage.py create_admin

down: ## Stop the development stack
	docker compose down

logs: ## Tail all service logs
	docker compose logs -f

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

# TruePPM — universal command interface
# Run `make help` for a list of targets.

.PHONY: help setup doctor lint typecheck test build clean up down logs admin up-prod \
        migrations-check migrations-numbering migrations-constraint-safety schema-check web-lint web-typecheck web-rule-numbers-check web-row-vocabulary-check pre-push pre-push-checks \
        pre-push-behind-warn pre-push-collision-check pre-push-wasm pre-push-mobile mobile-lint mobile-typecheck \
        coverage-diff coverage-diff-scheduler coverage-diff-api coverage-diff-web sonar \
        release-smoke screenshots wt-new wt-list wt-remove wt-prune wt-doctor dropdown-scroll-check

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
lint: lint-scheduler lint-api web-lint design-system-check dropdown-scroll-check ## Lint all packages

lint-scheduler: ## Lint packages/scheduler (ruff)
	cd packages/scheduler && ruff check src/ tests/ && ruff format --check src/ tests/

lint-api: ## Lint packages/api (ruff)
	cd packages/api && ruff check src/ tests/ && ruff format --check src/ tests/

# `lint-web` used to live here, one character from `web-lint` and differing in what it
# enforced: it ran the design-system gate, `web-lint` did not, and `pre-push` called the
# one that did not (#2941). Both halves are now named targets, so there is nothing left
# to pick the wrong one of.

# ─── Type-check ───────────────────────────────────────────────────────────────
typecheck: typecheck-scheduler typecheck-api typecheck-web ## Type-check all packages

typecheck-scheduler: ## Type-check packages/scheduler (mypy)
	cd packages/scheduler && mypy

typecheck-api: ## Type-check packages/api (mypy)
	cd packages/api && PYTHONPATH="$(CURDIR)/packages/api/src:$(CURDIR)/packages/scheduler/src" mypy src/trueppm_api

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
	@python3 scripts/check-migration-numbering.py --self-test
	@python3 scripts/check-migration-numbering.py origin/main

migrations-constraint-safety: ## Detect an AddConstraint on a table that may already hold violating rows (no DB)
	@# AddConstraint VALIDATES its index against every existing row, and migrations run
	@# on container start — so a violating row is an upgrade crash-loop, not a failed
	@# deploy (#3068). makemigrations --check never opens a database, so this class had
	@# no gate at all. Pure static analysis: no Django, no DB, no fetch.
	@python3 scripts/check-migration-constraint-safety.py --self-test
	@python3 scripts/check-migration-constraint-safety.py

schema-check: ## Verify docs/api/openapi.json matches the live DRF schema
	bash scripts/export-openapi.sh --check

api-lint: ## Run the api:lint CI job locally (ruff check + format --check)
	cd packages/api && ruff check src/ tests/ && ruff format --check src/ tests/

api-typecheck: ## Run the api:type-check CI job locally (mypy)
	cd packages/api && PYTHONPATH="$(CURDIR)/packages/api/src:$(CURDIR)/packages/scheduler/src" mypy src/trueppm_api

scheduler-lint: ## Run the scheduler:lint CI job locally (ruff check + format --check)
	cd packages/scheduler && ruff check src/ tests/ && ruff format --check src/ tests/

scheduler-typecheck: ## Run the scheduler:type-check CI job locally (mypy)
	cd packages/scheduler && mypy

web-lint: ## Run the web:lint CI job locally (eslint on packages/web/src + e2e)
	cd packages/web && npm run lint

web-typecheck: ## Run the web:type-check CI job locally (src + e2e projects)
	# `npm run typecheck`, not a bare `tsc --noEmit`: the CI job runs BOTH
	# passes, and `e2e/` is a separate tsconfig project (#2997). A bare
	# `tsc --noEmit` here type-checked only `src/`, so a type error in a
	# Playwright spec passed pre-push and failed CI — from a target whose own
	# help text claimed it ran the CI job.
	cd packages/web && npm run typecheck

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

sonar-exclusions-check: ## Fail if a sonar-project.properties exclusion has gone dead or drifted (#2520)
	@# Offline path matching against `git ls-files` — milliseconds, no SONAR_TOKEN.
	@# Catches a criterion whose glob matches nothing (the code it excused was
	@# renamed/deleted) and the `*.ts`-in-a-.tsx-directory shape that silently
	@# under-matches, which is how #2517 dropped the reliability rating A → D.
	@bash scripts/check-sonar-exclusions.sh

dropdown-scroll-check: ## Fail if a role="menu"/role="listbox" panel has no scroll guard (web-rule 351, #3109)
	@# A panel taller than the viewport with no overflow-y-auto + height guard
	@# spills off-screen with nothing to scroll it into view (the Schedule
	@# Display menu bug). Ratchet with named, reviewed exclusions for panels
	@# that are genuinely safe by construction — see the script header.
	@bash scripts/check-dropdown-scroll.sh

extension-signals-check: ## Fail if an OSS→Enterprise extension signal uses plain .send() (#2606)
	@# A receiver's exception propagates through .send(), so a bug in enterprise
	@# code breaks the OSS write path that fired the signal. Grep + sed, ~1s.
	@bash scripts/check-extension-signals.sh --self-test
	@bash scripts/check-extension-signals.sh

demo-readonly-check: ## Fail if a demo manifest enables persona logins (#2773)
	@# The hosted demo's read-only posture is what makes publishing it safe, and
	@# it is enforced by the absence of one flag in two YAML files. Grep, ~1s.
	@bash scripts/check-demo-readonly.sh

enterprise-boundary-check: ## Fail if OSS source imports from trueppm-enterprise (#2603)
	@# The Apache 2.0 boundary's one hard rule, which until #2603 was enforced by
	@# no gate at all. A grep over packages/ — milliseconds, no network — so it
	@# costs nothing to run on every push and catches the one class of mistake
	@# that is a licensing defect rather than a bug.
	@bash scripts/check-enterprise-imports.sh

boundary-doc-check: ## Fail if a doc instructs the stale naive boundary grep (#2859)
	@# #2603 replaced the naive grep with an import-syntax gate but did not update
	@# the docs telling people to run it, so CONTRIBUTING.md and four other
	@# surfaces handed a contributor a command that reports the project's sacred
	@# invariant as violated on a clean tree. Grep over five doc roots, ~1s.
	@bash scripts/check-boundary-doc-command.sh --self-test
	@bash scripts/check-boundary-doc-command.sh

web-rule-numbers-check: ## Fail if two packages/web/CLAUDE.md rules share a number (#2933)
	@# Rule numbers are the file's addressing scheme — code comments, ADRs and MR
	@# descriptions cite "rule NNN" and expect one answer. A duplicate exists only
	@# on the MERGED tree (each branch picked the next free number and was locally
	@# right), so neither branch's own pipeline can see it. 295 meant two different
	@# things for months as a result.
	@bash scripts/check-web-rule-numbers.sh --self-test
	@bash scripts/check-web-rule-numbers.sh

web-row-vocabulary-check: ## Fail if the outline's governed vocabulary is written outside its module (#3031)
	@# A row may be a task, a phase, a milestone or a subtask, and its type is
	@# DECLARED, not assumed. So the surfaces that exist before the type does —
	@# headers, create affordances, placeholders, and the name a create path
	@# mints — must say "item". The rule was swept by hand twice (#2952, #3027)
	@# and the second sweep found `+ Item` creating a row named "New task": a
	@# row's own name is a stronger type claim than any button label.
	@bash scripts/check-row-vocabulary.sh --self-test
	@bash scripts/check-row-vocabulary.sh

playwright-pins-check: ## Fail if a Playwright npm pin drifts from the CI image tag (#2797)
	@# A version mismatch means the browsers baked into the image are at a path
	@# the npm package never looks in, so the launch fails outright. In web:e2e
	@# that is loud; in website:build Astro swallows it, drops the whole page
	@# body, and still exits 0 — three docs pages published blank for 19 days on
	@# green pipelines. Four pins with no automatic relationship; parse + compare,
	@# ~1s, no network.
	@bash scripts/check-playwright-pins.sh

helm-metric-names-check: ## Fail if the Helm chart's PromQL names a series the app never emits (#2805)
	@# A PromQL name with no matching series is not an error anywhere in the
	@# stack: the alert silently never fires and the panel is silently blank.
	@# `helm lint` proves the template renders and cannot know what the app
	@# publishes. Stdlib Python over two chart files, milliseconds.
	@python3 scripts/check-helm-metric-names.py .

design-system-check: ## Run the lint:design-system-v2 CI job locally (#2941)
	@# The gate that polices hardcoded hex against the DS-v2 token ratchet. It was
	@# the one bespoke CI check with no pre-push mirror, so a breach passed locally
	@# and failed the pipeline — the exact round trip pre-push exists to prevent.
	@bash scripts/check-design-system-v2.sh --self-test
	@bash scripts/check-design-system-v2.sh

adr-status-check: ## Run the docs:adr-status CI job locally (#2941)
	@# An ADR cited from shipped source must not say "Proposed", and the ADR index
	@# statistics on the website must match the tree. Adding any ADR breaks four
	@# hard-coded figures in architecture/decisions.md, which is a guaranteed red
	@# pipeline on every branch that writes one. ~3s, no network.
	@bash scripts/check-adr-status.sh --self-test
	@bash scripts/check-adr-status.sh

version-status-check: ## Run the docs:version-accuracy CI job locally (#2941)
	@# Past/present-tense claims about unshipped versions, plus the
	@# declaration-coverage ratchet over features/, administration/ and
	@# getting-started/. Editing a non-declaring page breaks its baseline hash, so
	@# any docs branch can trip this. ~3s, no network.
	@bash scripts/check-version-status.sh
	@# The early-promotion guard (#2824) refuses an alpha cut against a version
	@# already promoted to the roadmap's "## Shipped" section while its "Ships in
	@# 0.X" callouts are still live — the edit that licenses release.sh to delete
	@# all 131 of them. It only ever executes at release time, so this self-test is
	@# the only signal that it still works. Same CI job. ~1s, no network.
	@bash scripts/check-early-promotion.sh --self-test

config-doc-links-check: ## Run the docs:config-links CI job locally (#3190)
	@# Every https://docs.trueppm.com link in packages/helm/values.yaml and
	@# .env.example must resolve to a page and anchor that exist. Those two files
	@# had zero links between them; now that they have forty, a link that 404s is
	@# worse than none, because it reads as authoritative. <1s, no network.
	@bash scripts/check-config-doc-links.sh

docs-tree-split-check: ## Run the docs:tree-split CI job locally (#2928)
	@# No *.md basename may exist in both docs/ and the published website tree,
	@# and no source pointer may name a docs/<published-tree>/ page that is not
	@# there. `docs/administration/` was a second, ungated copy of eight pages for
	@# months while `backup.sh --help` sent operators to the stale half. ~1s.
	@bash scripts/check-docs-tree-split.sh

ws-event-reachability-check: ## Run the docs:ws-event-reachability CI job locally (#2941)
	@# Every WS event named in the published taxonomy must be deliverable to a
	@# client, or carry a `not deliverable` marker. 50ms.
	@bash scripts/check-ws-event-reachability.sh

e2e-catchall-check: ## Run the lint:e2e-catchall CI job locally (#2941)
	@bash scripts/check-e2e-catchall.sh --self-test
	@bash scripts/check-e2e-catchall.sh

demo-nginx-allowlist-check: ## Run the demo nginx allowlist CI job locally (#2941)
	@bash scripts/check-demo-nginx-allowlist.sh

gate-selftest-parity-check: ## Fail if a CI gate never proves it can fail, in its own job (#3194)
	@# boundary:imports passed a real Apache-2.0 violation for the whole life of the
	@# gate (#3172) while carrying a test suite that ran in a DIFFERENT image, so the
	@# suite was evidence about that image and nothing else. Same job is the only way
	@# to say same image, which is why this matches per job rather than per repo.
	@bash scripts/check-gate-selftest-parity.sh --self-test
	@bash scripts/check-gate-selftest-parity.sh

package-licenses-check: ## Run the lint:package-licenses CI job locally (#3217)
	@# Every separately-distributed package ships its own license text (#2632).
	@# Apache-2.0 §4(a) obliges a recipient of a distribution to receive the
	@# license, and the root LICENSE does not travel with a PyPI wheel, a
	@# crates.io sdist, or a packaged Helm chart.
	@#
	@# This was opted OUT of pre-push for five months under "requires installed
	@# dependency trees for five packages" — a reason written about the
	@# license:check:* DEPENDENCY jobs, not this one (#3217). It reads LICENSE and
	@# packages/*/LICENSE and diffs them: no network, no toolchain, 0.03s for the
	@# scan and 0.24s for the self-test.
	@bash scripts/check-package-licenses.sh --self-test
	@bash scripts/check-package-licenses.sh

prepush-parity-check: ## Fail if a CI check script has no pre-push mirror and no opt-out (#2941)
	@# The durable half of #2941. The pre-push list was a historical accretion —
	@# each gate added by hand as it was written, and nothing checking the list
	@# stayed complete. This derives the CI set instead of restating it.
	@bash scripts/check-prepush-parity.sh --self-test
	@bash scripts/check-prepush-parity.sh

nginx-headers-check: ## Fail if the five nginx configs disagree on the hardening baseline (#2849)
	@# The SPA is served from five separate nginx configs across three trees, and
	@# nothing compared them until #2849: the Helm production branch — the path
	@# the docs recommend — rendered the SPA with no security headers at all
	@# while both compose paths set four, and the image-baked config still
	@# proxied /admin/ unthrottled after #2569 hardened the rendered siblings.
	@# bash + awk over four files plus two helm renders; seconds. The helm halves
	@# are skipped (loudly) when helm is not on PATH — CI always has it.
	@bash scripts/check-nginx-security-headers.sh

compose-image-pins-check: ## Fail if a third-party image in a shipped compose file has no version tag (#3228)
	@# `certbot/certbot` shipped untagged in docker-compose.prod.yml — the only
	@# unpinned image in the production stack, and the one component that owns TLS
	@# issuance and renewal. Docker resolved it to `latest`, so the version moved
	@# under a running install with no diff and no pipeline event. It survived a
	@# deliberate hardening pass (#3189) because an `image:` line with no tag reads
	@# as one with a tag unless you look for the colon.
	@# First-party `${APP_VERSION:-latest}` refs are out of scope on purpose.
	@# grep + sed over four files; well under a second.
	@bash scripts/check-compose-image-pins.sh

pre-push-checks: scheduler-lint scheduler-typecheck api-lint api-typecheck web-lint web-typecheck migrations-check migrations-numbering migrations-constraint-safety schema-check sonar-exclusions-check extension-signals-check enterprise-boundary-check boundary-doc-check demo-readonly-check helm-metric-names-check nginx-headers-check compose-image-pins-check playwright-pins-check web-rule-numbers-check web-row-vocabulary-check design-system-check dropdown-scroll-check adr-status-check version-status-check config-doc-links-check docs-tree-split-check ws-event-reachability-check e2e-catchall-check demo-nginx-allowlist-check package-licenses-check prepush-parity-check gate-selftest-parity-check pre-push-wasm pre-push-mobile ## Run pre-push gate subtargets (use via `pre-push`, not directly)

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

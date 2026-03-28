---
name: fix-mr
model: opus
description: >
  Watch and fix a failing GitLab MR pipeline for TruePPM. Fetches pipeline
  status, reads job logs, diagnoses the root cause, applies fixes, commits,
  and waits for a green pipeline. Repeats until the MR is green or a blocker
  requires user input.
---

# Fix MR Skill

Diagnose and fix a failing GitLab MR pipeline, then push until it is green.

## Invocation

```
/fix-mr [MR number]
```

If no MR number is given, use the MR for the current branch:
```bash
glab mr view --web 2>/dev/null || glab mr list --source-branch $(git branch --show-current)
```

---

## Step 1 — Identify the failing MR and pipeline

```bash
# Get MR status
glab mr view <MR>

# Get the latest pipeline for the MR branch
glab pipeline list --source=push --ref=$(glab mr view <MR> --output json | jq -r '.source_branch') | head -5

# Get the pipeline ID
PIPELINE_ID=$(glab pipeline list --source=push --ref=<branch> --output json | jq '.[0].id')
```

---

## Step 2 — Find failing jobs

```bash
# List all jobs in the pipeline and their status
glab pipeline ci view $PIPELINE_ID

# Or list jobs explicitly
glab pipeline jobs $PIPELINE_ID
```

Focus on jobs with status `failed`. Ignore `canceled` jobs (they were skipped after an earlier failure).

---

## Step 3 — Read job logs

```bash
# Get the full log for a failing job
glab job log <JOB_ID>
```

Read the **last 100 lines** first — most failures surface at the end. Scroll up only if the error references an earlier step.

---

## Step 4 — Diagnose: failure taxonomy

Match the log output to one of these categories, then follow the fix procedure.

### 4a. Lint failure (`ruff check`, `eslint`)
- Run locally: `ruff check packages/scheduler packages/api` or `cd packages/web && npx eslint src/`
- Auto-fix where safe: `ruff check --fix` / `eslint --fix`
- Commit: `chore: fix lint errors`

### 4b. Type error (`mypy`, `tsc`)
- Run locally: `mypy packages/scheduler packages/api` or `cd packages/web && npx tsc --noEmit`
- Fix type errors — do not cast to `Any` to silence them
- Commit: `fix: resolve type errors`

### 4c. Test failure (`pytest`, `vitest`, `jest`)
- Run the specific failing test locally to reproduce:
  ```bash
  pytest tests/path/to/test.py::TestClass::test_name -xvs
  ```
- Determine if the test is wrong (test bug) or the code is wrong (regression):
  - If the test is wrong: fix the test and explain why in the commit message
  - If the code is wrong: fix the code; do not delete or skip tests to make CI green
- Commit: `fix: <what was broken>` or `test: correct incorrect assertion`

### 4d. Missing migration
- Error looks like: `Your models in app(s): X have changes that are not yet reflected in a migration`
- Fix: `cd packages/api && python manage.py makemigrations`
- Verify the migration is reversible (has a `reverse` or uses `AlterField` not `RunSQL`)
- Commit: `chore(api): add missing migration for <model>`

### 4e. Import / dependency error
- Error looks like: `ModuleNotFoundError`, `Cannot find module`
- Check if a new package was added to code but not to `pyproject.toml` / `package.json`
- Add the dependency, run `pip install -e .` or `npm install`
- Commit: `chore: add missing dependency <package>`

### 4f. OSS/Enterprise boundary violation
- Error looks like: `ImportError: cannot import name X from trueppm_enterprise`
- This is a **BLOCKER** — do not work around it by adding an enterprise dependency to the OSS repo
- The import must be removed or moved behind a feature flag / plugin hook
- Flag to user before proceeding

### 4g. CHANGELOG check failure
- Error looks like: `CHANGELOG.md [Unreleased] section not updated`
- Add an entry to the `[Unreleased]` block under the correct heading (`### Added`, `### Changed`, or `### Fixed`)
- Never create a duplicate heading within the same release block
- Commit: `docs: update CHANGELOG for <feature>`

### 4h. Docker build / Helm lint failure
- Run locally if possible: `docker build -f packages/api/Dockerfile .` or `helm lint packages/helm`
- Check for syntax errors, missing files, or changed paths
- Commit: `fix(helm): <what was broken>` or `fix: correct Dockerfile`

### 4i. Flaky / infrastructure failure
- Signs: failure message is about network timeouts, registry pull errors, runner OOM, or the job passes on retry with no code change
- Do **not** modify code to work around infrastructure issues
- Retry the specific job: `glab pipeline retry <PIPELINE_ID> --job <JOB_ID>`
- If it fails again, report to user: "Pipeline failure appears infrastructure-related — cannot fix in code."

---

## Step 5 — Apply fix, commit, push

```bash
# Stage only the files you changed
git add <files>

# Commit with conventional commit format using heredoc
git commit -m "$(cat <<'EOF'
fix(<scope>): <description of what was broken and why>

<optional body explaining root cause>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"

git push
```

**Never use `--no-verify` to skip hooks.** If a pre-commit hook fails, fix the underlying issue.

---

## Step 6 — Wait and watch

After pushing, poll until the pipeline completes:

```bash
# Watch pipeline status (poll every 30s)
glab pipeline list --ref=<branch> | head -3
```

Or open in browser:
```bash
glab mr view <MR> --web
```

Wait for the pipeline to finish. If it fails again, return to Step 3 with the new job logs.

---

## Step 7 — Confirm green

When the pipeline is green:
```bash
glab mr view <MR>
```

Report back:
```
Pipeline is green. MR !<N> is ready to merge.
```

If the MR has unresolved threads or reviewer approvals required, note these too.

---

## Rules

- **Fix root causes only** — never skip tests, suppress lint rules inline, or cast types to silence errors
- **One fix per commit** — do not bundle unrelated fixes in the same commit
- **Do not rebase or force-push** without user confirmation — prefer new commits on top of the branch
- **Stop and ask** if the fix requires changing behaviour that the user should sign off on (e.g. a test was asserting something that turns out to be wrong by design)
- **Stop and ask** on OSS/Enterprise boundary violations — do not guess the architectural solution

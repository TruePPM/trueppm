---
name: fix-mr
model: sonnet
disable-model-invocation: true
description: >
  Watch and fix a blocked GitLab MR for TruePPM — both axes of readiness.
  Fetches pipeline status AND mergeability, reads job logs, diagnoses the root
  cause, resolves merge conflicts, applies fixes, commits, and waits for a
  green pipeline on a mergeable branch. Repeats until the MR is both green and
  mergeable, or a blocker requires user input.
---

# Fix MR Skill

Diagnose and fix a blocked GitLab MR, then push until it is green **and** mergeable.

**An MR is blocked on two independent axes.** The pipeline can be green while the
branch conflicts with `main`, and the branch can be mergeable while the pipeline is
red. GitLab tracks them separately — `head_pipeline.status` versus
`detailed_merge_status` / `has_conflicts` — and this skill covers both. Reading only
the pipeline is how a conflicted MR gets reported "ready to merge" (#3537).

## Invocation

```
/fix-mr [MR number] [, MR number ...]
```

Several MRs may be passed at once. Run Step 1 for **all** of them first, report the
two-axis state of each, and only then work them one at a time — a batch where one MR
is conflicted and another is red needs different treatment per MR, and the Step 1 table
is what tells them apart.

If no MR number is given, use the MR for the current branch:
```bash
glab mr view --web 2>/dev/null || glab mr list --source-branch $(git branch --show-current)
```

> **Who invokes this.** `/fix-mr` is **user-invoked only** (`disable-model-invocation: true`),
> for the same reason as `/mr`: driving a pipeline to green is a side-effectful loop the
> user should start explicitly. The agent cannot call it through the Skill tool. When an
> agent fixes a failing pipeline as part of automated work, it performs the steps below
> directly (`glab pipeline`/`glab ci`, read logs, fix, push) rather than invoking the skill.

---

## Step 1 — Read BOTH axes: pipeline status and mergeability

One call returns everything. Do this before anything else, for every MR passed in:

```bash
glab api "projects/:id/merge_requests/<MR>" | jq -r '
  "source:         \(.source_branch)",
  "state:          \(.state)",
  "pipeline:       \(.head_pipeline.status // "none") (\(.head_pipeline.id // "-"))",
  "merge_status:   \(.detailed_merge_status // .merge_status)",
  "has_conflicts:  \(.has_conflicts)"'
```

Then route on what comes back — the two axes are independent, so check both even when
one of them is already an answer:

| pipeline | `detailed_merge_status` | Go to |
|---|---|---|
| `failed` | `mergeable` | Step 2 (pipeline only) |
| `success` | `conflict` | **Step 4j** (conflict only) |
| `failed` | `conflict` | **Step 4j first** — merging `main` often clears the red too (see 4j) |
| `success` | `mergeable` | Step 7 — genuinely done |
| `running`/`pending` | either | Step 6, then re-read both |

**Read the pipeline from the MR, never from the branch ref.** Once an MR exists,
GitLab suppresses branch pipelines, so `glab ci list --ref=<branch>` shows a *frozen
pre-MR* success that ran almost no jobs. `head_pipeline` above is the real one.

**A `success` that hides a failure.** A pipeline reports `success` while an
`allow_failure: true` job failed. If the MR is green but something still looks wrong,
query the jobs, not the pipeline summary.

**Getting the pipeline ID for Steps 2–3**, once you have chosen the pipeline branch:

```bash
PIPELINE_ID=$(glab api "projects/:id/merge_requests/<MR>" | jq -r '.head_pipeline.id')
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

### 4j. Merge conflict (`detailed_merge_status: conflict`)

Not a pipeline failure — the branch cannot merge into `main`. It has its own procedure
because two things reliably go wrong here.

**First: check the worktree before resolving anything.** The resolution is often
already on disk, unpushed, leaving no trace on GitLab. In the issue's worktree:

```bash
git status --porcelain                                    # must be clean
git rev-list --left-right --count HEAD...origin/<branch>  # LEFT=ahead RIGHT=behind
```

| ahead / behind | meaning | action |
|---|---|---|
| `N / 0` | local is strictly ahead | a plain **non-force** push clears it — done |
| `0 / N` | another session pushed | do not build on this HEAD; sync first |
| `N / M` | diverged — usually an unpushed **amend** | confirm with `git rev-parse HEAD^` vs `git rev-parse origin/<branch>^`; identical parents means the local commit *replaces* the remote one, and landing it needs a force-push — confirm with the user first |

**Then resolve, if there is genuinely something to resolve:**

```bash
git fetch origin
git merge origin/main
```

Prefer **merge over rebase** — it needs no force-push, so the "do not rebase or
force-push without user confirmation" rule below stays satisfied without a round trip.

**Resolve in place, between the conflict markers.** Never rebuild a conflicted file
from `git show :2:<path>`. Stage 2 is the branch's *pre-merge* blob, so copying it over
the working-tree file silently discards every hunk the merge already auto-settled
elsewhere in that same file — and `git status` still reports the file resolved. The
tell is a test failing on a symbol your change never mentions, in a block the *other*
branch contributed.

**After merging `main`, check the two things a merge commonly breaks:**
- `ls changelog.d/` — a merge can leave a **duplicate** changelog fragment
- Migration numbers and `packages/web/CLAUDE.md` rule numbers — these collide only on
  the *merged* tree, so both sides were green alone

Then `make pre-push` and push. Commit: `chore: merge main to resolve conflicts`
(a merge commit's default message is fine).

**Why to do this before diagnosing a red pipeline.** A stale merge base is one of the
two causes of a pipeline that fails instantly with **0 jobs and `yaml_errors: null`**
(the other is job-quota exhaustion). Merging `main` clears that shape. More generally,
a gate that reds while naming your files is frequently a stale base rather than your
diff.

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

## Step 7 — Confirm green AND mergeable

Re-read both axes — the same call as Step 1. A fix pushed for one axis can change the
other (merging `main` re-runs the pipeline; a new commit re-evaluates mergeability):

```bash
glab api "projects/:id/merge_requests/<MR>" | jq -r '
  "pipeline:       \(.head_pipeline.status)",
  "merge_status:   \(.detailed_merge_status)",
  "has_conflicts:  \(.has_conflicts)"'
```

**Only report ready to merge when `head_pipeline.status == "success"` AND
`detailed_merge_status == "mergeable"`.** Both, every time:

```
Pipeline is green and the branch is mergeable. MR !<N> is ready to merge.
```

When they disagree, say so explicitly rather than reporting the good half:

```
MR !<N>: pipeline green, but the branch CONFLICTS with main — not mergeable.
```

`detailed_merge_status` also reports blockers this skill does not fix — `not_approved`,
`discussions_not_resolved`, `draft_status`, `blocked_status`. Report those verbatim
rather than calling the MR ready; they need a human.

**Never merge the MR.** Hand back the URL and stop — auto-merging after a fix is
exactly the git-workflow rule this repo forbids.

---

## Rules

- **Check both axes before reporting anything** — a green pipeline is half the answer; `detailed_merge_status` is the other half
- **Fix root causes only** — never skip tests, suppress lint rules inline, or cast types to silence errors
- **One fix per commit** — do not bundle unrelated fixes in the same commit
- **Do not rebase or force-push** without user confirmation — prefer new commits on top of the branch
- **Stop and ask** if the fix requires changing behaviour that the user should sign off on (e.g. a test was asserting something that turns out to be wrong by design)
- **Stop and ask** on OSS/Enterprise boundary violations — do not guess the architectural solution

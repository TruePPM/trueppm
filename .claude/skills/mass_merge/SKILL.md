---
name: mass_merge
model: sonnet
disable-model-invocation: true
description: >
  Safely land a batch of already-green GitLab MRs onto main, one at a time,
  without breaking the post-merge main pipeline. Emulates a merge train
  client-side: stacks the MRs on a local integration branch, re-runs the
  repo-wide aggregate/ratchet gates after each, and merges only the safe
  prefix serially — rebasing every MR onto the latest main first. Use when
  landing several related MRs in one sitting.
---

# Mass Merge Skill

Land a list of merge requests onto `main` safely, in sequence, so that
individually-green MRs cannot combine into a red main.

## Invocation

```
/mass_merge !123 !124 !125
/mass_merge 123,124,125
/mass_merge !123 !124 --dry-run
```

Arguments: a list of MR IIDs, in the order you want them landed. Accepts
`!123`, `123`, space- or comma-separated. Flags:

- `--dry-run` — run Phase A (the simulation) only; never push or merge. Use
  this first when you are unsure the batch is composable.

### Who invokes this — user only

`/mass_merge` is **user-invoked only** (`disable-model-invocation: true`). It
**merges to `main`**, which the git-workflow rules say an agent must never do on
its own initiative. This skill is the *sanctioned, user-triggered* batch-merge
path — the one place where merging is the explicit, deliberate ask. The agent
cannot call it through the Skill tool and must not reproduce Phase B (the merge
loop) as part of unattended work. It may reproduce **Phase A (simulation)** at
any time to *report* whether a batch is safe, but stops before pushing or
merging.

---

## Why this skill exists

Under parallel-worktree batches, main pipelines go red **after** merge even
though every MR's own pipeline was green. Two causes, neither of which is a code
quality problem:

1. **Aggregate / ratchet gates do not compose.** `lint:design-system-v2` counts
   raw hex literals across the *whole tree* against a committed baseline.
   `lint:adr-collisions` and `api:migration-check` count numbers across the whole
   tree. MR A adds 2 (under ceiling on A's tree), MR B adds 3 (under ceiling on
   B's tree); each MR pipeline sees only its own tree and passes. Merge both and
   the combined tree is over ceiling — and that only shows up on the post-merge
   `ref: main` pipeline.
2. **Stale merge base.** GitLab gates each MR against the main it *branched from*,
   not current main (no merged-results pipelines / merge trains are configured —
   `.gitlab-ci.yml` uses plain `merge_request_event`). Auto-merges on shared
   files (`docs/api/openapi.json`, `router.tsx`, `changelog.d/`, e2e specs) apply
   cleanly as text but break semantically.

This skill fixes both **before** merge by (A) stacking the MRs on a local
integration branch and re-running every aggregate gate after each add, then
(B) landing only the safe prefix serially, rebasing each MR onto the
latest main and waiting for a green pipeline before the next.

> **The durable fix is server-side merge trains.** This skill is a client-side
> emulation. Once merged-results pipelines / merge trains are enabled in the
> GitLab project settings, GitLab does phase A+B for you and this skill becomes
> a convenience. Until then, use it for every multi-MR landing. Mention this to
> the user if they run `/mass_merge` on a large batch repeatedly.

---

## Step 0 — Pre-flight

```bash
glab auth status                     # must be authenticated
git -C . rev-parse --abbrev-ref HEAD # note current branch to restore later
git status --porcelain               # working tree MUST be clean
git fetch origin --prune
```

Stop and tell the user if:

- `glab` is not authenticated → `glab auth login`.
- The working tree is dirty → this skill flips checkouts and force-pushes
  branches; it must run from a **clean** checkout with **no other in-flight
  work** (another agent's uncommitted changes or unpushed commits will be
  clobbered). Prefer a dedicated worktree — `scripts/wt new <any-issue>` — if
  parallel sessions are active.

> **The batch's own branches being checked out in worktrees is normal, not a
> blocker.** Under the parallel-worktree workflow, each MR you are landing was
> built in its own worktree, so `git worktree list` will show them — that is
> expected and Phase B handles it (it drives each branch via `git -C "$WT"`
> instead of `glab mr checkout`; see Step 3). What must be clean is *your own*
> checkout and any worktree you are about to rebase. Before rebasing a
> worktree-held branch, confirm `git -C "$WT" status --porcelain` is empty and
> its `HEAD` equals `origin/<branch>` (pushed) — an unpushed or dirty worktree
> means a session is still working that branch; skip it and tell the user.

Then validate every MR in the list, in parallel is fine:

```bash
glab mr view <iid> --output json
```

For each MR record: `source_branch`, `target_branch`, `state`, `draft`,
`detailed_merge_status` (or `merge_status`), and the head pipeline status. Stop
and report if any MR is:

- not `opened`, or is `draft`/WIP;
- targeting a branch other than `main` (unless the user said otherwise);
- has unresolved threads or is not approved, if the project requires it;
- whose own latest pipeline is **not** green — fix that MR first (`/fix-mr !<iid>`),
  it is not a mass-merge candidate yet.

Print the validated, ordered list back to the user before doing anything else.

---

## Step 1 — Detect shared-file hotspots (ordering hint)

```bash
for iid in <order>; do
  echo "== !$iid =="
  git diff --name-only origin/main...origin/<source_branch>
done
```

Cross-reference the file lists. Call out any file touched by **two or more** MRs
in the batch — these are where the stale-base semantic conflicts land. Known
hotspots: `docs/api/openapi.json`, `packages/web/src/router.tsx`,
`changelog.d/*`, `docs/adr/*`, `packages/api/**/migrations/*`,
`packages/web/e2e/*.spec.ts`, `CLAUDE.md`. Serial rebasing (Phase A/B) handles
these correctly by construction, but tell the user which MRs collide so the
ordering is deliberate.

---

## Step 2 — Phase A: simulate the merge train (always runs)

Build a local integration branch off current main and stack the MRs onto it in
order, running the **aggregate gate suite** after each add. This reproduces the
exact combined tree that would land on main — the thing each MR's own pipeline
never sees.

```bash
git checkout -B _mass_merge_sim origin/main
```

For each `iid` in order (let `B` = its `source_branch`):

```bash
git fetch origin "$B"
# Rebase the MR's commits onto the current sim tip, then land them.
# Use merge --no-ff to mirror how GitLab lands the branch:
if ! git merge --no-ff --no-edit "origin/$B"; then
  git merge --abort
  echo "CONFLICT: !$iid does not merge cleanly onto the stack → STOP"
  # record as blocker; do not continue past this MR
fi
```

Then run the aggregate gate suite **on the sim tree** (fast, seconds, no CI):

```bash
make pre-push                                   # lint + typecheck + migrations-check + schema drift
bash   scripts/check-design-system-v2.sh        # hex/color ratchet vs baseline (the #1 offender)
bash   scripts/check-adr-collisions.sh          # duplicate ADR numbers
python3 scripts/check-migration-numbering.py origin/main   # duplicate migration numbers
bash   scripts/check-issue-boundary.sh || true  # OSS/enterprise label boundary (network-dependent; advisory here)
bash   scripts/check-version-status.sh          # version-tense vs roadmap
bash   scripts/check-todo-grep.sh               # STUB/WIP/closed-issue TODOs
```

Record, per MR, which gates passed on the cumulative tree. **The first MR whose
add turns a gate red is the one that breaks main** when combined with the MRs
before it — even though its own pipeline is green in isolation.

Clean up:

```bash
git checkout <original-branch-or-main>
git branch -D _mass_merge_sim
```

**Report the simulation as a table** — for each MR: merges-clean? and gate
status on the cumulative tree. Classify each MR:

- ✅ **safe** — merges clean, all aggregate gates green on the cumulative tree.
- 🔴 **breaks the batch** — first MR to fail a gate or conflict. Name the exact
  gate and what overflowed (e.g. "adds 3 hex literals; DS-v2 ratchet ceiling
  exceeded once stacked on !123's 2").
- ⏸️ **blocked-behind** — MRs after the first 🔴; not evaluated on a valid tree.

If `--dry-run`, **stop here** and hand the user the table plus the fix needed for
each 🔴 (the fix goes on that MR's branch — e.g. inline the hex as a v2 token,
renumber the ADR/migration, regenerate openapi after merging main).

---

## Step 3 — Phase B: land the safe prefix serially

Only the **contiguous ✅ prefix** from Phase A is landable. If MR #3 is 🔴, land
#1 and #2, then stop and report that #3 (and everything after) needs a fix
first. Never skip a 🔴 to land a later MR — that reorders the stack Phase A
validated.

For each MR in the safe prefix, **one at a time**.

**First, locate the source branch's working copy.** A batch MR's source branch
is very often already checked out in a **parallel worktree** (that is how the
work was done). `glab mr checkout <iid>` then fails with `git: exit status 128`
("branch is already checked out at …") and silently leaves you on your current
branch — you rebase and push the *wrong* branch. So resolve the working copy
first and drive git there with `git -C "$WT"`:

```bash
BR=$(glab mr view <iid> --output json | python3 -c 'import sys,json;print(json.load(sys.stdin)["source_branch"])')
WT=$(git worktree list --porcelain | awk -v b="refs/heads/$BR" '
  /^worktree /{p=$2} $0=="branch "b{print p}')   # empty if not in a worktree
if [ -z "$WT" ]; then
  glab mr checkout <iid>; WT=.                     # not worktree-held → check out here
fi
test -z "$(git -C "$WT" status --porcelain)" || { echo "DIRTY $BR → STOP"; exit 1; }
```

Then rebase that working copy onto the latest main and push:

```bash
git -C "$WT" fetch origin
git -C "$WT" rebase origin/main        # rebase onto latest main (includes MRs already landed this run)
# if the rebase conflicts → git -C "$WT" rebase --abort, stop, report: needs a manual rebase
SHA=$(git -C "$WT" rev-parse HEAD)      # the EXACT sha we are about to push — poll on this, not the branch tip
git -C "$WT" push --no-verify --force-with-lease="$BR:$(git -C "$WT" rev-parse "origin/$BR")" origin "$BR"
```

- `--no-verify` skips the local pre-push hook: Phase A already ran the full gate
  suite on the combined tree, so re-running `make pre-push` on every push is pure
  latency, and the hook is what stalls on a VS Code/askpass credential prompt.
- `--force-with-lease="$BR:<old-sha>"` pins the expected remote sha explicitly.
  A bare `--force-with-lease` compares against the *local* remote-tracking ref,
  which in a shared-worktree checkout can be stale and either wrongly reject or
  wrongly accept; the explicit form is exact.

Then wait for the freshly-pushed pipeline **for that exact sha** to go green, and
only then merge. **Poll by MR ref and match the full sha** — do not use the
`?sha=<short>` filter (GitLab's sha filter only matches the full 40-char sha and
returns `[]` for a short one, so a short-sha poll loops forever), and do not
trust the MR's `head_pipeline` (it goes stale right after a force-push):

```bash
# poll: the pipeline whose sha == $SHA on this MR's ref must reach `success`
while :; do
  ST=$(glab api "projects/:id/pipelines?ref=refs/merge-requests/<iid>/head&per_page=20" \
        | python3 -c "import sys,json;m=[p for p in json.load(sys.stdin) if p['sha']=='$SHA'];print(m[0]['status'] if m else 'none')")
  case "$ST" in
    success)                 break ;;                       # green → merge
    failed|canceled)         echo "PIPELINE $ST → STOP"; exit 1 ;;
    none|created|preparing|pending|running|manual|scheduled|waiting_for_resource)
                             sleep 30 ;;                     # keep waiting (incl. 'none' = not created yet)
    *)                       echo "unknown status $ST"; sleep 30 ;;
  esac
done
# green for $SHA → confirm the MR is mergeable, then merge
glab mr merge <iid> --yes
git fetch origin                        # pull the new main so the NEXT MR rebases on top of this one
```

**After the merge, gate on the resulting `ref: main` pipeline before touching the
next MR — this is mandatory, not optional.** An MR-ref pipeline is green *against
the main it branched from*; it does not prove the merge *commit* on main is green.
A merge can turn main red in ways the MR pipeline never saw — an aggregate/ratchet
gate that only overflows once combined, a `ref: main`-only job that never runs on
`merge_request_event` (e.g. `security:osv`, `boundary:check`, CodeQL mirror), or a
newly-published advisory the scanner picks up mid-run. If you skip this gate and
keep merging, every subsequent MR lands on an already-red main and you discover it
seven merges too late. **The invariant: at most ONE merge may land on a newly-red
main — the first red `ref: main` pipeline halts the entire run.**

```bash
git fetch origin main                                  # after the merge above
MAINSHA=$(git rev-parse origin/main)                   # the merge commit now on main
while :; do
  ST=$(glab api "projects/:id/pipelines?ref=main&per_page=20" \
        | python3 -c "import sys,json;m=[p for p in json.load(sys.stdin) if p['sha']=='$MAINSHA'];print(m[0]['status'] if m else 'none')")
  case "$ST" in
    success)                 break ;;                  # main is green → proceed to next MR
    failed|canceled)         echo "MAIN PIPELINE $ST for $MAINSHA → STOP THE RUN"; exit 1 ;;
    none|created|preparing|pending|running|manual|scheduled|waiting_for_resource)
                             sleep 30 ;;
    *)                       sleep 30 ;;
  esac
done
```

When the post-merge main pipeline goes red, apply the **same triage as the MR-ref
poll** (below): if it is a known e2e flake, retry that one job once and keep
polling *this main pipeline*; anything else — including a `ref: main`-only gate
like `security:osv` — is a **hard stop**. Do NOT push or merge the next MR. Report
which merge's main pipeline failed and which job, so the user can decide whether to
revert it or fix forward. A red `ref: main`-only gate that predates the batch (an
externally-published advisory, a pre-existing main failure) is still a stop: the
batch cannot certify a green main on top of it, and stacking more merges only
buries the signal. Confirm whether the last-good main *before* the batch was green
(Step 0 should have recorded this) so you can tell the user whether the batch
caused the red or merely inherited it.

Cap the poll (e.g. 120 iterations × 30s = 60 min) and stop with a clear message
rather than looping forever if CI hangs. Terminal-failure states (`failed`,
`canceled`) stop the whole run — do not merge a red pipeline, and do not silently
wait through a crash.

**Before treating a `failed` as terminal, triage the failing job — a known
flake is retried once, not a stop.** A rebased branch re-runs the full suite,
which includes the flaky `web:e2e` specs (`task-collaboration.spec.ts` `?task=`
deep-link, `board-space-pan.spec.ts`, `schedule` dep-milestone row — see the
`feedback_flaky_e2e_*` memories). Pull the failed jobs and read the trace:

```bash
PID=<pipeline id for $SHA>
glab api "projects/:id/pipelines/$PID/jobs?per_page=100" \
  | python3 -c "import sys,json;[print(j['status'],j['name'],j['id']) for j in json.load(sys.stdin) if j['status']=='failed' and not j['allow_failure']]"
glab api "projects/:id/jobs/<job-id>/trace" | grep -iE "failed|✘|\.spec\.ts|Error:" | tail -40
```

- If the only failures are **known-flaky e2e specs** (assertion on a deep-link
  URL / pan / timing race, hundreds passed, unrelated to this MR's diff), retry
  that job **once** and keep polling the same pipeline:
  `glab api -X POST "projects/:id/jobs/<job-id>/retry"`. If the retry also fails,
  treat it as a real stop.
- If the failure is a **real test/lint/type/build error**, or touches this MR's
  own changed surface, stop the run and hand it to the user — the rebase onto the
  MRs already landed this batch may have introduced a genuine semantic conflict
  (exactly the stale-base class this skill exists to catch).

Never blanket-retry a red pipeline to make it green — retry only a job you have
positively identified as a known flake.

Rules for Phase B:

- **Serial, never parallel.** Serializing is the fix. Do not push the next MR
  until the current one has merged and `origin/main` has been re-fetched.
- **Poll to green, then merge** — do not fire `--when-pipeline-succeeds` across
  the whole batch at once. Batch MWPS races each other and reintroduces exactly
  the parallel-merge problem this skill removes (and the known glab batch-merge
  MWPS gotcha). One MR's pipeline must be confirmed green before its merge, and
  merged before the next MR is even pushed.
- **Gate on the post-merge `ref: main` pipeline after EVERY merge — at most one
  merge may land on a red main.** The MR-ref pipeline being green does not prove
  the merge commit on main is green: `ref: main`-only jobs (`security:osv`,
  `boundary:check`, CodeQL mirror), aggregate/ratchet gates that overflow only when
  combined, and externally-published advisories all surface *only* on the main
  pipeline the merge triggers. After `glab mr merge`, fetch main, capture the new
  `origin/main` sha, and poll `pipelines?ref=main` for that exact sha to reach
  `success` before you push or merge the next MR. A `failed`/`canceled` main
  pipeline is a **hard stop for the whole run** (same flake-triage exception as the
  MR-ref poll). This is the guard whose absence let seven MRs land on a main that
  went red on the first merge — the entire point of the skill is a green main, and
  only the main pipeline proves it.
- **`--force-with-lease`, never `--force`** — protects against someone else
  pushing to the MR branch mid-run. Pin the expected sha explicitly
  (`--force-with-lease="$BR:<old-sha>"`) when the branch lives in a worktree, so
  a stale remote-tracking ref can't misjudge the lease.
- **Drive the branch where it actually lives.** If the source branch is checked
  out in a worktree, `glab mr checkout` fails (git 128) and dumps you on the
  wrong branch — resolve `$WT` from `git worktree list` and run every git command
  with `git -C "$WT"`. Verify `$WT` is clean before rebasing so you never clobber
  a parallel session's uncommitted work.
- **Poll the exact pushed sha, by MR ref.** Capture `SHA=$(git rev-parse HEAD)`
  before the merge and poll `pipelines?ref=refs/merge-requests/<iid>/head`,
  matching that full sha. The `?sha=<short>` filter returns `[]` (needs the full
  40-char sha) and loops forever; `head_pipeline` goes stale after a force-push.
  Treat `failed`/`canceled` as a hard stop and `none` (pipeline not yet created)
  as keep-waiting.
- **A rebase conflict in Phase B stops the run.** Phase A merged the *original*
  branch tips; a Phase B rebase can still conflict once an earlier MR from this
  batch has actually landed. That is a real semantic conflict — hand it to the
  user, do not guess a resolution.
- **Re-run the aggregate gate suite (Step 2 commands) on the rebased branch
  before pushing** if the batch had 🔴s that were fixed mid-run, or if more than
  a few minutes passed and other MRs may have landed on main from another
  session. Cheap insurance against a moved baseline.

---

## Step 4 — Report

Emit a final summary:

```
Mass merge of !123 !124 !125 → main

  ✅ !123  merged   (rebased, pipeline #NNN green)
  ✅ !124  merged   (rebased, pipeline #NNN green)
  🔴 !125  BLOCKED  — lint:design-system-v2: +3 hex literals over ratchet
                      once stacked on !123/!124. Fix on the branch:
                      replace #1f2937 with the `surface-raised` token, then
                      re-run /mass_merge !125.

Landed 2 of 3. main pipeline: <URL of latest main pipeline — confirm green>.
```

Confirm the post-merge main pipeline is green after *every* merge, not just at the
end (see the Phase B post-merge gate) — that is the whole point of the skill. If it
is red despite Phase A being clean, a gate exists that Phase A does not reproduce
(a `ref: main`-only job, or an externally-published advisory): stop, report which
job failed and whether the pre-batch main was already green, and — if it is a gate
Phase A *could* reproduce — add it to the Step 2 suite so the next run catches it
before merging rather than after.

---

## Rules

- **User-invoked only.** Never run Phase B as part of unattended agent work.
- **Clean tree, no parallel in-flight work** before starting — it flips checkouts
  and force-pushes branches. Use a dedicated worktree if other sessions are live.
- **Only the contiguous safe prefix lands.** A 🔴 stops the run; do not reorder
  to land later MRs.
- **Rebase every MR onto the latest main immediately before pushing** — this is
  the CLAUDE.md batched-MR rule, enforced automatically.
- **Poll-to-green then merge, serially.** No batch MWPS, no parallel merges.
- **Gate on the `ref: main` pipeline after every merge — at most one merge lands
  on a red main.** The MR-ref pipeline proves the branch against its old base, not
  the merge commit on main; `ref: main`-only jobs (`security:osv`, `boundary:check`,
  CodeQL), combined-tree ratchet overflows, and fresh advisories show up only on
  the main pipeline. Poll it for the new `origin/main` sha to `success` before
  pushing the next MR; the first red main pipeline is a hard stop for the whole run.
- **Poll the exact pushed full sha by MR ref** — never the `?sha=<short>` filter
  (returns `[]`, loops forever) and never `head_pipeline` (stale after a
  force-push). Cap the wait so CI hangs don't loop forever.
- **Triage a `failed` before stopping.** A rebased branch re-runs the flaky
  `web:e2e` specs. If the only failures are known flakes (see `feedback_flaky_e2e_*`
  memories) and hundreds passed, retry that job once and keep polling. A real
  test/type/lint/build failure — or one on this MR's own diff — is a hard stop.
  Never blanket-retry to force green.
- **Drive worktree-held branches with `git -C "$WT"`** — `glab mr checkout` fails
  (git 128) on a branch already checked out in a worktree and silently leaves you
  on the wrong branch. The batch's own branches being in worktrees is expected.
- **Push rebased branches with `--no-verify`** — Phase A already ran the full gate
  suite on the combined tree; the pre-push hook is redundant latency here and is
  what stalls on an askpass credential prompt.
- **Never `--force`; always `--force-with-lease`** — pin the expected sha
  (`--force-with-lease="$BR:<old-sha>"`) for worktree-held branches.
- **Never resolve a rebase/merge conflict by guessing** — stop and hand it back.
- **Restore the user's original branch** (Step 0) when the run ends, on success
  or failure.
- If merged-results pipelines / merge trains get enabled in the project, tell the
  user this skill is now mostly redundant with the server doing it.

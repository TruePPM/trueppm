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

For each MR in the safe prefix, **one at a time**:

```bash
glab mr checkout <iid>                 # checks out the real source branch
git fetch origin
git rebase origin/main                 # rebase onto the latest main (includes MRs already landed this run)
# if the rebase conflicts → abort, stop, report: this MR now needs a manual rebase
git push --force-with-lease            # re-runs the MR pipeline against CURRENT main (merged-results equivalent)
```

Then wait for the freshly-pushed pipeline to go **green**, and only then merge:

```bash
# poll until the head pipeline for <source_branch> is success (not just MWPS-fire-and-forget)
glab ci status --branch <source_branch>      # or: glab pipeline list --ref <source_branch>
# when green:
glab mr merge <iid> --yes                     # immediate merge; pipeline already green
git fetch origin                              # pull the new main so the NEXT MR rebases on top of this one
```

Rules for Phase B:

- **Serial, never parallel.** Serializing is the fix. Do not push the next MR
  until the current one has merged and `origin/main` has been re-fetched.
- **Poll to green, then merge** — do not fire `--when-pipeline-succeeds` across
  the whole batch at once. Batch MWPS races each other and reintroduces exactly
  the parallel-merge problem this skill removes (and the known glab batch-merge
  MWPS gotcha). One MR's pipeline must be confirmed green before its merge, and
  merged before the next MR is even pushed.
- **`--force-with-lease`, never `--force`** — protects against someone else
  pushing to the MR branch mid-run.
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

Always end by fetching and confirming the **post-merge main pipeline** is green —
that is the whole point of the skill. If it is red despite Phase A being clean,
a gate exists that Phase A does not reproduce; report which job and add it to the
Step 2 suite.

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
- **Never `--force`; always `--force-with-lease`.**
- **Never resolve a rebase/merge conflict by guessing** — stop and hand it back.
- **Restore the user's original branch** (Step 0) when the run ends, on success
  or failure.
- If merged-results pipelines / merge trains get enabled in the project, tell the
  user this skill is now mostly redundant with the server doing it.

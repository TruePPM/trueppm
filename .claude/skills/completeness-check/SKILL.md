---
name: completeness-check
model: sonnet
description: >
  Independent, fresh-context audit of a finished branch BEFORE it is pushed: does it
  do everything its issue asked (acceptance criteria, test-plan lines, comments), for
  every member of the bug class and not just the reported instance, without breaking
  another consumer of what it changed — and do its tests and docs actually prove that?
  Run on every source-touching branch after the other pre-MR gates, by an agent that
  did not write the code. Produces BLOCKERS / GAPS / clean plus the `## Requirements`
  table the MR description carries.
---

# Completeness Check

## Why this gate exists

On 2026-09-26 a post-merge audit of the twenty most recently merged MRs (!2790–!2810)
found gaps in **sixteen** (#4159). Most were not exotic, and most were already forbidden
by rules written down elsewhere — `regression-check`'s recurrence check, `test-scaffold`'s
"watch the guard fail first", `docs-writer`'s drift sweep. The rules existed. What was
missing was **anyone other than the author applying them before the push**. The author's
context is the worst place to look for what the author did not think of.

The same audit, pointed at the fix MRs written to close those gaps, found gaps in those
too — including a **blocker no test could see** (dropping a milestone back where it sat
proposed a one-day move) and a release-commit exemption an MR could borrow. An
independent pass costs one agent. A reopened issue costs a second MR, a second pipeline,
and a second review.

What it caught, by class — use these as the checklist, they are the ones that recur:

| Class | Instances (2026-09-26) |
|---|---|
| Instance fixed, class missed | workspace export still leaked the ADR-0124 field (#4082); editing a link's URL bypassed the confused-deputy fix (#4081); direct-object path skipped the #4130 validation; a second members page kept the removed button (#4014) |
| Changing a shared rule broke another consumer | narrowing a permission bypass blocked token revocation (#4014); moving milestones to end-of-day broke the Gantt (#4079) |
| Issue test-plan lines silently dropped | two tests #4151 asked for; the MS Project confirmation #4145 made a precondition |
| Docs fixed on one page, stale on others | cost model on 5 pages after a roadmap move; hours-per-day; SBOM; btree_gist |
| "Follow-up" with no issue | #4153, #4145, #4080 step 5 (now also `lint:mr-followups`) |
| A test that cannot fail | fuzz whose inputs never reached the new check; an API test that imported the shared venv's scheduler, so its negative control passed with the fix removed |
| Release-path code that only runs at tag time | `release.sh` fallback that would red main at the first 0.5 cut (#4080) |
| Merged-tree collisions | migration number taken by main while the branch was in flight |

## When to run

- **Every source-touching branch, before `git push`**, after the other pre-MR gates have
  run and their fixes are committed — it runs *after* the parallel gate batch, not in it,
  because it audits the branch those gates' fixes produced. Docs-only branches too — docs
  claims are checked against code, and that is where docs gaps were found.
- **Again, narrowly, on the commits made in response to it.** A fix for a completeness
  finding is new code; the round-2 audits above found gaps in round-1 fixes.
- Exempt: dependency bumps, CI-config-only and chore branches with no behavior change.

## How to run

Spawn **one agent that did not write the branch** (a fresh `general-purpose` agent; never
the implementing agent, never via `SendMessage` to it). The frontmatter model does not
reach a spawned agent, so pass `model` explicitly:

- **`opus`** when the branch meets one of `batch`'s escalation criteria — it spans three
  or more packages or changes an API↔web contract, changes scheduling semantics or the
  sync protocol, or touches an authorization boundary. Every finding in the table above
  came from an Opus audit, including the ones no test could see (a phantom drag move, a
  borrowable release exemption, a refresh/edit race). Say which criterion applies.
- **`sonnet`** otherwise. Its yield on this gate is **unmeasured**; the ledger line below
  records the model (`… — N findings (sonnet)`) so `/kaizen` can compare the two rather
  than either being assumed. The brief must say: read-only, no
commits, no pushes, no tracker changes, do not spawn subagents, avoid commands over ~5
minutes. Give it the worktree path, the issue number(s), the original MR if this is a
follow-up, and any user decisions the branch implements — then let it find things. Do
not hand it your own list of what you checked; that is how an audit turns into an echo.

The brief asks it to be **the reviewer who must block a bad merge**, and to check, in order:

1. **Requirements traceability.** Read the issue *and its comments* (`glab issue view N
   --comments`) — scope corrections live in comments. Every acceptance criterion and every
   test-plan line is MET (file:line), or DEFERRED to an **open** issue that is not the one
   being closed. A test-plan line nobody ran is a gap, not a nicety.
2. **The class, not the instance.** Enumerate the set the fix belongs to structurally
   (every implementation, every call site of the *shape*, every sibling page, every
   export/dump path, every write path) and report the denominator. The reported path is
   the one member you already know about.
3. **Collateral consumers.** When the branch narrows, broadens, or moves a *shared* rule
   (a permission class, a gate, an engine semantic, a serializer field, a shared helper),
   list every consumer of the old behavior and check each. This is the class that
   produced the two regressions above; it is invisible from the diff.
4. **Try to break it.** Adversarial inputs, races (check-then-act across a slow call),
   PUT vs PATCH, forged exemptions, the default/empty/null case, the upgrade path of an
   existing row.
5. **Do the tests discriminate?** Read each new test against the code path it claims to
   cover. Spot-check at least one negative control yourself. Watch for the environment
   traps: in a worktree the API imports `trueppm_api` *and* `trueppm_scheduler` from the
   shared venv unless `PYTHONPATH` names the worktree's `packages/api/src` and
   `packages/scheduler/src`; a Hypothesis space that validation rejects before the code
   under test; zsh not word-splitting `$FILES`.
6. **Docs claims against code.** Every new sentence is true of the code, and the old claim
   survives nowhere else — grep `packages/website/src/content/docs/`, `README.md`,
   `changelog.d/` and `docs/` for it.
7. **Merged-tree state.** Migration numbers, ADR numbers and rule numbers against
   `origin/main` as fetched now, not as of branch creation.
8. **Pipeline**, if already pushed: head pipeline at the MR's current sha, including
   failed `allow_failure` jobs.

## Output

The agent returns, under ~500 words:

```
BLOCKERS: <must fix before push — evidence file:line, minimal fix>
GAPS:     <should fix before push — evidence, minimal fix>
CLEAN:    <what it checked and found sound, briefly — so the next reader knows the denominator>
```

The author then fixes every BLOCKER and GAP on the branch (or files an open issue for a
GAP the user explicitly defers, and says so in the MR), re-runs the affected tests with
negative controls, and only then pushes.

## Recording it

- The MR description carries a `## Requirements` table (see `/mr`) built from step 1.
- The `## Gates` ledger carries `- gate: completeness-check — <N> findings (<model>; <one-line gist>)`,
  where N counts BLOCKERS + GAPS that changed the branch or were consciously deferred.
  `0 findings` is a real outcome and is recorded — it is how `/kaizen` will learn whether
  this gate keeps earning its slot.

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
- **After round 1's fixes are committed, run exactly one of round 2 or the fix-diff
  re-check — never both, never neither by default.** See
  [§ After round 1](#-after-round-1--composing-round-2-and-the-fix-diff-re-check) for the
  composition rule: [Round 2](#round-2--a-second-full-audit-when-round-1-says-the-branch-is-in-trouble)
  when round 1 found something structural, the
  [fix-diff re-check](#fix-diff-re-check--narrow-audit-of-the-fix-commits-only) when the
  fix commit changes executable behavior, otherwise nothing.
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
BLOCKERS: <must fix before push — [cause] evidence file:line, minimal fix>
GAPS:     <should fix before push — [cause] evidence, minimal fix>
CLEAN:    <what it checked and found sound, briefly — so the next reader knows the denominator>
```

Every BLOCKER and GAP opens with exactly one **cause tag** — why the gap exists, not
which checklist step found it:

| Tag | The gap exists because… |
|---|---|
| `requirement-unclear` | the issue (body + comments) did not settle what was wanted, so a reasonable implementer could have built it either way |
| `requirement-missed` | the issue settled it and the branch did not do it — including a comment's scope correction |
| `class-missed` | the reported instance is fixed and another member of the same class is not |
| `collateral` | a shared rule moved and another consumer of the old behavior broke |
| `test-weak` | a test that cannot fail, or a test-plan line nobody ran |
| `docs-stale` | a docs claim is false of the code, or the old claim survives elsewhere |
| `merged-tree` | a collision with `origin/main` as fetched now |

The tags exist to answer one question with data: would asking for requirement
clarification *before* implementation (in `/batch` Step 2) prevent a real share of these
findings? Only `requirement-unclear` would. Tag honestly — a `requirement-missed` filed as
`requirement-unclear` makes the upstream fix look cheaper than it is.

The author then fixes every BLOCKER and GAP on the branch (or files an open issue for a
GAP the user explicitly defers, and says so in the MR), re-runs the affected tests with
negative controls, and only then pushes — unless
[§ After round 1](#-after-round-1--composing-round-2-and-the-fix-diff-re-check) selects
round 2 or the fix-diff re-check first.

## Round 2 — a second full audit when round 1 says the branch is in trouble

The narrow re-run audits only the fix commits, so it catches a bad fix but never what
round 1 failed to see. One auditor's recall is incomplete, and a branch that produced
many or structural findings is the branch where that matters: the author's model of the
problem was off, and the fixes reach code round 1 never had to reason about.

**Trigger** — after round 1's fixes are committed, run round 2 if round 1 reported:

- any **BLOCKER** tagged `class-missed` or `collateral` (the fix's scope changed), or
- **four or more** BLOCKERS + GAPS in total.

Otherwise the narrow re-run is enough.

**How:**

- A **fresh** agent — not round 1's auditor, not via `SendMessage` to it, not the author.
- **Do not show it round 1's findings.** Give it the same brief round 1 got (worktree,
  issue numbers, user decisions). A list of known findings anchors the audit on them;
  the point of round 2 is the findings round 1 did not have.
- **`opus`**, regardless of the escalation criteria — the trigger is itself the evidence
  that this branch needs the stronger reasoner.
- After it reports, **compare the two lists**. Record the overlap: how many round-2
  findings round 1 had already reported. High overlap means the audits are converging on
  the same set; low overlap means there are probably more gaps neither found.

**Stop after two rounds.** If round 2 still reports a BLOCKER, the problem is the branch,
not the audit. Do not start round 3; stop and put the choice to the user — split the
branch, rethink the approach, or fix and push with the residual risk stated in the MR.
This is the same reasoning that makes `/pre-release full` a one-time gate: fresh agents
always find something adjacent, and an audit loop has no natural end.

Round 2's own fixes still get the fix-diff re-check.

## Fix-diff re-check — narrow audit of the fix commits only

This is the narrow counterpart to round 2: it re-reads only the commits written in
response to round 1, not the whole branch. It is what the global `~/.claude/CLAUDE.md`
names `completeness-check/fix-diff`, and it exists for the common case where round 1's
findings were a `requirement-missed` or a `test-weak`, not a sign that the author's whole
model of the problem was off — the case round 2 exists for.

**Trigger** — selected by
[§ After round 1](#-after-round-1--composing-round-2-and-the-fix-diff-re-check) below. In
short: round 1 reported a BLOCKER, or the fix commit changes executable behavior
(application code, CI or chart logic, a gate or check script, a migration) — never docs,
tests, comments, or changelog text alone.

**How:**

- A **fresh** agent — not round 1's auditor, not via `SendMessage` to it, not the author.
- Scope it to the fix commit(s) only — the diff round 1's findings produced, not the
  whole branch. Give it round 1's BLOCKER/GAP text so it knows what each fix claims to
  resolve, and ask it to verify the fix against the code, not just that something changed.
- Same model tier round 1 used (`opus`/`sonnet`, § How to run).
- **Once, never a loop.** If it finds another BLOCKER, fix it and stop there — do not
  spawn a second fix-diff pass on the second fix. A fix-diff loop with no exit is the same
  failure mode round 2's two-round cap exists to prevent.

## § After round 1 — composing round 2 and the fix-diff re-check

Round 2 and the fix-diff re-check answer different failures in round 1's result, and
running both (or neither, by default) defeats the point of having two shapes. After
round 1's fixes are committed, choose exactly one:

| Round 1 result | Action |
|---|---|
| A BLOCKER tagged `class-missed` or `collateral` (the fix's scope changed structurally), or **4 or more** BLOCKERS + GAPS in total | **Round 2** — full re-audit (above) |
| Otherwise: round 1 reported a BLOCKER, **or** the fix commit changes executable behavior (application code, CI or chart logic, a gate or check script, a migration) | **Fix-diff re-check** — narrow re-audit (above) |
| Otherwise: GAP(s) only, and the fix commit is docs, tests, comments, or changelog text only | **Nothing** — record `n/a` |

The first row that matches wins; do not run round 2 and the fix-diff re-check on the same
branch for the same round-1 result.

## Recording it

- The MR description carries a `## Requirements` table (see `/mr`) built from step 1.
- The `## Gates` ledger carries `- gate: completeness-check — <N> findings (<model>; causes: <tally>; <one-line gist>)`,
  where N counts BLOCKERS + GAPS that changed the branch or were consciously deferred,
  and the tally lists each cause tag used with its count (`causes: class-missed 2,
  test-weak 1`; omit it at 0 findings).
  `0 findings` is a real outcome and is recorded — it is how `/kaizen` will learn whether
  this gate keeps earning its slot.
- If round 2 ran, it gets **its own line** under the same gate name, with `round 2` as
  the first item in the parenthetical and the overlap after the causes:
  `- gate: completeness-check — <N> findings (round 2; opus; causes: …; overlap <k>/<N>)`.
  N counts only what round 1 did not already report. Keep the gate name unchanged —
  the ledger parser matches on skill names, and `/kaizen` splits round 2 out by the
  `round 2` marker.
- If the fix-diff re-check ran instead, it gets **its own line** with a `/fix-diff`
  suffix on the gate name, never a parenthetical label — the ledger parser requires
  whitespace before the dash and drops a parenthesized label silently (see
  `.claude/skills/kaizen/SKILL.md`'s `gate:` regex):
  `- gate: completeness-check/fix-diff — <N> findings`. N counts BLOCKERS + GAPS the
  fix-diff pass found; `n/a` when § After round 1 selected "nothing" (the fix round was
  docs/tests/comments/changelog only).
- Round 2 and the fix-diff re-check are mutually exclusive per § After round 1 — a branch
  carries at most one of the two extra lines, never both, in addition to round 1's line.

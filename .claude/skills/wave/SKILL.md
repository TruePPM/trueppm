---
name: wave
model: opus
disable-model-invocation: true
description: >
  Pick up a batch of milestone issues and land them in parallel — one git
  worktree and one delegated agent per issue, each finishing with its own MR.
  Asks which milestone and which labels to pull from; never infers either.
  Enforces the token-discipline rules measured in #3659 (Sonnet by default,
  a hard wave cap, and per-agent commit verification). User-invoked only —
  it spawns many agents and spends real money, so it must never start on
  a model's own initiative.
---

# Wave

Land several milestone issues in one wave. Each issue gets its own worktree, its
own delegated agent, and its own MR. You are the orchestrator: you choose the
issues, brief the agents, verify what they actually produced, and report. You do
**not** implement the issues yourself.

> **Renamed from `batch` (#4683).** A project skill named `batch` hides Claude Code's
> bundled `/batch`: a project skill replaces a bundled skill of the same name, so the
> built-in was unreachable in this repo. The Blueprint renamed its copy to `wave`
> for the same reason (macrodream/blueprint#101); this keeps the two in step.

## Why this skill is shaped the way it is

Batch work used to run from a freehand prompt. It worked, and it cost **~122M
tokens per merged MR** (#3659: 20 merged MRs for ~2,445M tokens). The composition
of the subagent spend is the whole design rationale:

| Component | Share |
|---|---|
| `cache_read_input_tokens` | **95.9%** |
| `cache_creation_input_tokens` | 3.9% |
| `output_tokens` | 0.2% |

**Generation is not the cost. Re-reading context is.** The bill is
`turn count × context size × fan-out`, so every rule below attacks one of those
three factors. Spend was also concentrated rather than uniform — the top 10 of
169 subagents were 44% of the total, one at 166M against a 6M median — so a
single agent that wanders costs more than twenty that stay focused. Capping the
wave matters less than keeping each agent short.

Do not treat these as style preferences. They are the difference between a wave
that costs 2.4B tokens and one that costs a few hundred million.

## Step 1 — Ask. Never infer.

Ask both questions with `AskUserQuestion` in a **single call** (two questions,
one round trip). Do not guess either answer, and do not skip the ask because the
answer looks obvious.

1. **Which milestone?** Offer the active dated milestones from
   `glab api "projects/:id/milestones?state=active"`, nearest due date first.
2. **Which labels to pull from?** Multi-select. Offer the commitment labels
   (`release::committed`, `release::reserve`, `release::stretch`) and the
   domain labels actually present on that milestone's open issues — read them,
   do not offer a hardcoded list.

Also ask **wave size** if the user has not said one, defaulting to **5**. See the
cap rule below for why the number is small.

If the user names milestone and labels in their invocation
(`/wave 0.4 release::committed`), take them and skip the ask.

## Step 2 — Select the issues

```bash
glab issue list --milestone <M> --label <L> --per-page 100
```

Then filter, in this order:

1. **Drop anything already claimed** — `status::wip`, or an issue number that
   already has an open MR. `wt new` refuses a claimed issue, but check first so
   you are not selecting work you cannot start.
2. **Drop anything blocked** on an unmerged branch or an unanswered 🔴 question.
3. **Prefer issues with an identified root cause.** An issue whose body already
   names the file and the mechanism is one an agent can finish. A vague issue
   turns into a 166M exploration — the exact failure the measurement found.
4. **Prefer independent issues.** Two agents touching the same file collide on
   the merged tree even when both are green alone. Check the paths each issue
   implies before pairing them in one wave; see the collision notes in
   `CLAUDE.md`.
5. **Respect `release::` ordering** — committed before reserve before stretch,
   unless the user said otherwise.

Report the selected list to the user before spawning anything. One line per
issue: number, title, chosen model, and why that model.

## Step 3 — One worktree per issue

Never let two agents share a checkout, and never create the worktrees from
inside an agent.

```bash
scripts/wt new <issue>      # branch + worktree off latest origin/main, claims status::wip
```

- The WIP cap is 10. If the wave would exceed it, either shrink the wave or
  raise it deliberately with `TRUEPPM_WT_CAP=<n>` — and say so in your report.
  Do **not** delete another session's worktree to make room; stale
  `worktree-agent-*` trees belong to other sessions.
- Each worktree's `.envrc` sets an isolated `TRUEPPM_TEST_DB` and its own e2e
  ports. The agent must `source .envrc` before running pytest.
- `git stash` is **not** worktree-scoped. Tell every agent to use
  `scripts/wt stash`, never bare `git stash`.

## Step 4 — Delegate, on the cheapest model that can do the job

One agent per issue, all spawned **in a single message** so they run
concurrently.

### Model choice

**Default to Sonnet.** Opus ran the subagents in the measured waves and was
1,180M of one wave's 1,426M. Most issues do not need it.

Escalate to Opus only when the issue meets one of these, and **say which one** in
your report:

- The root cause is unknown and must be found, not just fixed.
- The fix spans three or more packages, or crosses the API↔web boundary with a
  contract change.
- It changes scheduling semantics (CPM, Monte Carlo, float) or the sync protocol.
- It requires a design judgment the issue does not settle — a new interaction
  pattern, an ADR, or an OSS/Enterprise boundary call.

"This issue is important" is not escalation criteria. Neither is "it is a
security fix" — a one-line permission-class fix with a named root cause is
Sonnet work.

**Read-only gates always run on Sonnet.** `regression-check`, `rbac-check`,
`perf-check`, `security-review`, `broadcast-check`, `migration-check` read a diff
and report findings. None needs Opus. `completeness-check` is the one exception,
and it is not a gate this agent runs on itself — Step 6 covers why and how, and
uses the same tier as this agent's own escalation call.

### The brief

Each agent's prompt must be **self-contained**. An agent that has to go
rediscover context spends its budget on cache reads of files you could have
named. Include:

- The issue number, title, the **full issue body**, and **its comments**
  (`glab issue view N --comments`) — paste them, do not make the agent fetch
  them. Scope corrections live in comments; an agent briefed from the body alone
  implements a requirement that may already have been superseded, and
  `completeness-check` then reports the branch as missing it.
- Its worktree path, and the instruction to `cd` there and `source .envrc` first.
- The specific files or symbols to start from, if the issue names them.
- The exact gates that apply to this diff (from the `CLAUDE.md` fast-path table),
  and which are `n/a`, so the agent does not run the whole battery.
- The scoped test command — the affected test file, not the whole suite.
- The completion contract from Step 5 — it **stops and reports after Step 5.4**;
  it does not push or open the MR itself. Tell it up front that **you will
  resume it later**, after an independent completeness-check, to do the push and
  open the MR (Step 6) — so that resumption reads as the plan, not as scope being
  added to a finished task.

Tell each agent explicitly:

- **Do not re-delegate.** A subagent must execute, not spawn more agents.
- **Do not run the full test suite.** `pytest <file> -q`, or
  `npx vitest run <file>`, or `npx playwright test e2e/<spec>.spec.ts`.
- **Batch independent tool calls** into one message.
- **Stop and report** if blocked after two attempts at the same failure, rather
  than looping. A stuck agent is the 166M case.

## Step 5 — Finish the code, then stop

Every agent finishes the code itself by, in order:

1. Tests and docs in the **same commit** as the code change.
2. A changelog fragment at `changelog.d/<issue>.<type>.md`, unless the change is
   exempt (chore/ci/docs, or the MR carries `no-changelog`).
3. `make pre-push` green. Log it to a **file** — piping it through `tail` loses
   the diagnostic and an OOM kill reads as a bare `exit 144`.
4. **Stop and report back** — commit SHA, worktree path, which gates from the
   `CLAUDE.md` fast-path table it ran and their findings. **It does not push and
   does not open the MR.** Step 6 runs against the not-yet-pushed branch; pushing
   first would just mean redoing the push after completeness-check's fixes.

## Step 6 — Completeness-check, run by you, before push

`completeness-check` (`.claude/skills/completeness-check/SKILL.md`) requires an
agent that did not write the branch — never the Step 5 agent, never reached via
`SendMessage` to it. Step 4 already forbids the Step 5 agent from spawning one
itself (no re-delegation), so in a wave **you are the only legitimate source of
that fresh agent.** Skip this step and completeness-check simply never runs on
this branch — which is the gap that prompted writing this step down at all.

For each issue, once its Step 5 agent reports, first check the exemption
`completeness-check/SKILL.md` already states — **dependency bumps, CI-config-only
and chore branches with no behavior change** are exempt from items 1–6 only. An
exempt branch still resumes the Step 5 agent for items 7–11, because the push and
MR happen regardless of the audit. Otherwise run items 1–6 first:

1. Spawn **one fresh `general-purpose` agent**. Give it the worktree path, the
   issue number(s) with comments, and any user decisions the branch implements —
   not your own notes on what Step 5 already checked; a list of known findings
   anchors the audit on them. Tell it explicitly that it is **read-only: no
   commits, no pushes, no tracker changes, no subagents, and no command expected
   to run longer than about five minutes.** Pass `model` explicitly:
   - **`opus`** if this issue's Step 4 implementing agent ran on Opus (i.e. met
     one of this skill's escalation criteria), **or** the branch touches an
     authorization boundary (`completeness-check/SKILL.md` § How to run) — same
     tier in, same tier checking, plus the auth-boundary case the auditor's own
     rule adds.
   - **`sonnet`** otherwise.
2. Read its `BLOCKERS` / `GAPS` / `CLEAN` report.
3. Clean → record `gate: completeness-check — 0 findings (<model>)`, resume the
   Step 5 agent by `SendMessage` to do items 7–11 below, and stop — you do not
   push or open the MR yourself. If that `SendMessage` is refused, use the same
   fallback as item 4: brief a fresh agent with the worktree, the issue, and the
   push/MR steps, and have it do items 7–11.
4. Findings → hand them to the **same Step 5 agent** (`SendMessage` — it is
   stalled, not gone) to fix, with the exact BLOCKER/GAP text. It fixes, re-runs
   the affected tests with negative controls, and reports back. If that
   `SendMessage` is refused as out-of-scope (a stalled agent can read added scope
   as injection), do not retry it — brief a **fresh** agent instead with the
   worktree path, the findings, and the original issue context, and have it make
   the fix as a new commit. **That replacement agent, not you, then also carries
   items 7–11** — it is now the one with the worktree and the context to push and
   open the MR; do not let the original agent's refusal become the orchestrator's
   job by default.
5. After the fix commit lands, decide the next step **per `completeness-check`'s
   own `§ After round 1` table in its SKILL.md** — this step defers to that table
   rather than restating it, so look there, not here, for the current composition:
   round 2 (full), the fix-diff re-check (narrow), or nothing. Either re-check, if
   selected, is a **fresh, non-author agent** spawned by you, with the model rules
   in that SKILL's § How to run.
6. Record whichever ran on the ledger exactly as `completeness-check`'s own
   SKILL.md "Recording it" section specifies — as of this writing that means:
   round 2 (if triggered) gets its own line marked `round 2`; the fix-diff
   re-check (if triggered) gets its own line under the gate name
   `completeness-check/fix-diff`; if `§ After round 1` selected neither, record
   only round 1's line. Do not invent a marker that file doesn't define.

**Cost figures, snapshotted when you give the go-ahead.** Run `scripts/cost-ledger enabled`
in the worktree first (`docs/harness/cost-ledger.md`).

- **Exit 1 (off):** send the single line `cost-ledger: off` in place of the three cost lines.
  Do not run `scripts/post-mr-cost.py`, read no transcript, and post no cost comment. **Exit 2
  (unreadable):** the same, plus the `## Notes` line "cost ledger setting unreadable; nothing
  recorded". `budget-exceeded:` is not a cost line and is sent either way.
- **Exit 0 (on):** record the `agentId:` of every agent you spawn or resume for the branch at the
  moment you do (the Agent tool result prints it): the implementer, each `completeness-check`
  pass, a fresh agent for a late round. At the go-ahead, in the worktree, in your own session (it
  reads `$CLAUDE_CODE_SESSION_ID`), run `python3 scripts/post-mr-cost.py --measure [--agent <id> ...]`
  and send its stdout lines (`subagent-tokens: <N>`, `orchestrator-tokens: <N>`,
  `est-cost-usd: <N.NN> (prices <date>)`) to the implementer unchanged, to paste under the gates in
  the MR's `## Gates` section (`mr/SKILL.md` § The Gates section has the line formats). Never run
  `scripts/subagent-tokens.py`, `scripts/orchestrator-tokens.py` or `scripts/est-cost.py` by hand
  and never write a window marker: `post-mr-cost.py` is the only code that measures and posts a
  record. It measures the window this session has not yet claimed in an earlier record: the
  orchestrator since its previous cost record, and each subagent only for usage after its own
  previous record, with descendants (the implementer's own gate batch) included. `--measure` posts
  nothing and advances nothing, so the hook still claims the same tokens at `glab mr create`.
  Which top-level agents it counts is decided by the agent's brief (the first message you sent
  it): a brief that names this branch or its worktree leaf is counted, one that names another
  `feat|fix|docs|chore/<N>-` branch is left for that branch, and an unnamed gate is counted when it
  has usage in the window. **So every brief you write names the branch it is for**; for an agent
  whose brief cannot, pass `--agent <id> --pin` on the `--measure` run (in the branch's own
  worktree; it refuses to pin to the default branch): the pin is recorded for this branch and the
  hook (record 1) and `--round` (record K) then attribute that agent the same way. The measuring
  fails closed: a line it cannot measure is not printed and stderr says why, so send only the lines
  printed and put stderr's `note:` text under `## Notes`; a figure that cannot be measured is
  omitted, never sent as 0. The `subagent_tokens` field in an agent's completion notification is a
  context size, not usage: it is never recorded, and it is not the ledger's `subagent-tokens:`
  figure. A branch resumed from another session cannot be read from this one: omit the lines and
  say so.

Only once this clears does the Step 5 agent, resumed, finish the branch:

7. **Stale-base check, before pushing.** `git fetch origin`, then confirm the
   worktree's branch is still based on current `origin/main`
   (`git merge-base --is-ancestor origin/main HEAD` or inspect
   `git log origin/main..HEAD`). If `origin/main` has moved since the worktree
   was created, rebase onto it and re-run the affected tests — this is what
   catches a merged-tree collision (a migration number, an ADR number, a rule
   number) that opened up while the branch, the gate batch, and the
   completeness-check round were all running against an older base.
8. Push the branch.
9. **Open the MR itself**, reproducing the `/mr` skill's format by running
   `glab mr create` directly. `/mr` is `disable-model-invocation` — an agent
   cannot call it and must not try. `.claude/skills/mr/SKILL.md` is the canonical
   format for both paths.
10. Include `Closes #NNN` in the MR description, a `## Gates` section with one
   `gate: <name> — <N> findings` line per gate run, including every
   completeness-check line from this step (`0 findings` is a real outcome; never
   omit a zero, never conflate `n/a` with `skipped`), and the `## Requirements`
   table `mr/SKILL.md` requires for every issue-linked MR (it omits the section
   only for chores with no issue). The auditor returns only BLOCKERS / GAPS /
   CLEAN, so build the table yourself from the issue's acceptance criteria, using
   the auditor's CLEAN section as the evidence for each MET row, and hand the
   table to this agent — it has no other way to see the criteria.
    The same message carries the cost lines (or `cost-ledger: off`) from above, which go
    under the gates unchanged.
11. **Never merge.** Hand back the MR URL and stop.

**Record 1 is posted by a hook, not by you** (trueppm#4865). The Step 5.4 snapshot above only feeds
the description's ledger lines. Once the resumed agent runs `glab mr create`, the PostToolUse hook
`.claude/hooks/post-mr-cost.sh` (`scripts/post-mr-cost.py`) measures the window this session has
not yet claimed and posts the `## Cost of this MR` comment by itself, unless the ledger is off, the
description carries `cost-ledger: off`, or a cost comment already exists. It does not render from
the description's lines: that snapshot claims nothing, so rendering it would repeat tokens an earlier
record already counted. After you verify the MR, check the hook's `additionalContext` line (or
`mr-cost-hook.log` in `git rev-parse --git-common-dir`); if it says it posted, do nothing. If it
skipped or failed with the ledger on, run the command its message prints (`python3
scripts/post-mr-cost.py --retry --mr <iid> --session <sid>`) and say so in the report. Do not run
the measuring scripts or `cost-table.py` by hand, and never post with a hand-written `glab mr note`:
the script is what later records read back and number from.

**Work on the MR after record 1** gets its own record K, never an edit of record 1. That means a
`/fix-mr` round, a review-fix or `completeness-check` fix push after `glab mr create`, a resume
after the MR is open, and a rebase with conflict resolution before merge (CLAUDE.md "Batched MR
sequence"; a clean rebase is not a window). With the ledger on, once that work is pushed, in the
worktree, run `python3 scripts/post-mr-cost.py --round --mr <iid> [--agent <id> ...]` and relay its
one-line answer. It posts record K for the window this session has not yet claimed (never earlier
than the MR's latest record end), counts a resumed agent only for its new usage, and advances the
session state; it posts nothing, and says why, when the ledger is off, the MR opts out, or record 1
is missing. Do not run the three measuring scripts, `cost-table.py --next-since` or `--ledger`, and
do not save a window pair: the state lives in `<git-common-dir>/mr-cost-state/` and is written only
by `post-mr-cost.py` (`docs/harness/cost-ledger.md` § *Non-overlap*). The `## Gates` lines stay the
go-ahead snapshot; do not edit them.

The agent reports back: MR URL, the full gate ledger, the commit SHA, and
anything it deliberately left undone.

## Step 7 — Verify before you believe it

**An agent reporting "done" is not evidence.** The known failure mode is a
subagent that stops at the first gate artifact and reports success — 3 of 5 in
one measured batch. Check every agent's actual output:

```bash
cd ../trueppm-wt/<leaf> && git log origin/main..HEAD --oneline    # are there commits?
git status --porcelain                                            # anything uncommitted?
```

Then confirm the MR is real and points at the right code:

```bash
glab api "projects/:id/merge_requests/<iid>" \
  | jq -r '"sha=\(.sha) pipeline=\(.head_pipeline.status) closes=\(.description|test("Closes #"))"'
```

`HEAD == MR sha == pipeline sha`. A worktree is not private — another session can
commit and push from it mid-edit — so verify rather than assume the agent's
summary describes what landed.

An agent that produced no commit costs the same as one that shipped. Re-brief it
with what was missing, or take the issue over yourself; do not report it as done.

Also check the MR description's `## Gates` section actually carries a
`completeness-check` line, and — per `§ After round 1` — a `round 2` line if round 2
ran, or a `completeness-check/fix-diff` line if the fix-diff re-check ran (never
both). Unless the branch is exempt, its absence means Step 6 was skipped under
time pressure, not that the branch had nothing to find.

## Step 8 — Report

One table: issue, model used, MR, pipeline status, commits, gate findings. Then
state plainly:

- Which issues did **not** land, and why.
- Whether you raised the WIP cap, and whether any worktrees need cleanup
  (`scripts/wt remove <issue>`).
- Measured `subagent-tokens:` and `orchestrator-tokens:` per branch (session spend over the
  window, same unit, not attribution), with `est-cost-usd:` beside them; `n/a` with the reason
  where a script omitted its line, and `cost ledger off` where `scripts/cost-ledger enabled`
  said so. Measured figures and the one labeled estimate, never a guess.
- The wave's shape: how many agents, how many on Opus.

Do not merge anything. Do not start another wave without being asked.

## Cost rules, condensed

Cache reads were 95.9% of the measured spend. Each of these cuts
`turn count × context size × fan-out`:

- **Sonnet unless escalation criteria are met**; read-only gates always Sonnet.
- **Cap the wave** (default 5, WIP cap 10). 114 agents in one session is past
  the point where they are independent.
- **Verify commits, don't trust summaries** — a wandering agent is 25× a focused
  one, and an empty one is pure loss.
- **Self-contained briefs.** Paste the issue body; name the files. Every fact the
  agent has to rediscover is re-read on every subsequent turn of that agent.
  Name the branch (or its worktree directory) the agent is for: the cost records attribute a
  subagent to an MR by its brief (`docs/harness/cost-ledger.md` § *Non-overlap*).
- **Scoped tests only.** Never the full suite inside an agent.
- **Pre-MR gates as one parallel batch**, never serially (#526).
- **Apply only the gates the diff earns** — the `CLAUDE.md` fast-path table is
  authoritative. A bugfix with a known root cause does not need `architect`.
- **`completeness-check` runs between Step 5 and the push, spawned by you, not by
  the implementing agent** — it is the one gate the implementing agent
  structurally cannot run on itself (Step 6).
- **No re-delegation** from inside an agent.
- **Two-strike rule**: an agent stuck on the same failure twice stops and reports.
- **Long-running work goes to the background**, not to a polling loop.

## Rules

- **Never merge.** Not after a green pipeline, not for a docs-only branch.
- **Never infer a `release::` label.** If an issue enters a dated milestone
  during this wave, ask which of committed/reserve/stretch applies. An unlabeled
  issue is a visible gap; a guessed label is an invisible one.
- **Never commit to `main`**, and always branch from latest `origin/main` —
  `wt new` handles this.
- **Never bare `git stash`** in a worktree. `scripts/wt stash`.
- If the user says skip a gate, skip it and record it as `skipped` with their
  reason — not as `n/a`.

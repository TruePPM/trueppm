---
name: kaizen
model: sonnet
description: Audit the TruePPM development harness (CI, agent gates, pre-push, MR flow) for friction and propose a small, ranked list of speed wins. Distinct from /pre-release (which audits the codebase) — kaizen audits the *process*. Run on demand or as the pre-flight step of /pre-release full.
argument-hint: "[--silent | --no-file]"
---

# Kaizen — Continuous Harness Improvement

You are running a kaizen review of the TruePPM **development harness** — the agent gate chain, CI pipeline, `make pre-push` gates, MR flow, and the rules in `~/.claude/CLAUDE.md` and `CLAUDE.md` that govern how change moves from idea to shipped commit.

**Scope discipline.** Kaizen audits the *process*, not the *codebase*. Findings about insecure code, slow endpoints, missing tests, or stale docs belong in `/pre-release` and the day-to-day agents. Findings here are limited to:

- Agent gate mandates that are routinely skipped (signal: the rule is ceremonial)
- Agent gate mandates that catch nothing in practice (signal: the rule is redundant)
- CI jobs whose duration dominates pipeline time
- `make pre-push` jobs that have crept past their budget
- MR cycle-time anomalies (retries, long sit times, frequent rebases)
- Documentation drift between `~/.claude/CLAUDE.md` rules and actual workflow
- Missing escape hatches (rules that have no documented "skip" path for low-risk changes)

If a finding does not fit one of those buckets, drop it. Kaizen with a wide aperture becomes a whack-a-mole loop and stops being useful.

## When to run

- **Standalone**, ad-hoc, when you sense the dev loop is getting heavier
- **Standalone**, on a monthly cadence
- **Automatically**, as Step 0.7 of `/pre-release full` (release time is a natural reflection point — but kaizen findings target the *next* cycle, not the current release)

Do **not** run kaizen inside the iterative "fix findings, re-audit" loop that `/pre-release` already avoids. Kaizen is one pass per invocation.

---

## Arguments

- `--silent` — gather and report only; do not offer to file issues. Useful when invoked from `/pre-release`.
- `--no-file` — same as `--silent` for the issue-creation step but still output the full report.

Default: full report + offer to file issues.

---

## Step 0 — Determine target milestone

Kaizen findings target the **next open minor milestone** (not the current working release). The current release is already in motion; harness improvements landing late in a release cycle add risk without benefit.

```bash
glab api "projects/trueppm%2Ftrueppm/milestones?state=active" 2>/dev/null \
  | python3 -c "import json,sys; ms=json.load(sys.stdin); print('\n'.join(m['title'] for m in sorted(ms, key=lambda m: [int(x) for x in m['title'].split('.') if x.isdigit()] or [0])))"
```

Pick the smallest open minor milestone strictly greater than the current working release. Export as `$KAIZEN_MILESTONE`. If there is no next minor open, ask the user where to file findings.

---

## Step 1 — Gather signals

Run these queries in parallel. Do not interpret yet — collect data first, reason later.

### 1a. MR cycle-time signals (last 30 merged MRs)

```bash
glab mr list --repo trueppm/trueppm --state merged --per-page 30 \
  --output json 2>/dev/null \
  | python3 -c "
import json, sys
from datetime import datetime
mrs = json.load(sys.stdin)
for mr in mrs:
    created = datetime.fromisoformat(mr['created_at'].replace('Z','+00:00'))
    merged  = datetime.fromisoformat(mr['merged_at'].replace('Z','+00:00')) if mr.get('merged_at') else None
    if not merged: continue
    hours = (merged - created).total_seconds() / 3600
    print(f\"!{mr['iid']:>4} {hours:>6.1f}h  {mr['title'][:80]}\")
"
```

Flag any MR > 48 hours from open to merge. Most TruePPM MRs are solo-author with no review wait, so a long sit time means pipeline retries or a stuck check.

### 1b. CI wall-clock — run time, the stage tail, and variance (last ~20 pipelines on main)

Wall-clock is set by the **critical path** (the longest chain of `needs`-gated
stages), not by the sum of job durations. Three traps make naïve "top 3 longest
jobs" reads wrong; profile against all three:

**Trap 1 — queue contention masquerading as slowness.** `updated_at - created_at`
includes time a pipeline sat waiting for a free runner. Batch-merge pileups (many
pipelines launched in the same second) produce 20–49 min outliers that are *pure
queue*, not work. Use GitLab's own `duration` field (active run time) and discard
the congestion outliers before reasoning about the trend.

```bash
# Pull run-time (duration) for the last 20 successful main pipelines — the clean signal.
glab api "projects/trueppm%2Ftrueppm/pipelines?ref=main&status=success&per_page=20" 2>/dev/null \
  | python3 -c "
import json, sys, subprocess
for p in json.load(sys.stdin):
    d = json.loads(subprocess.check_output(['glab','api',f\"projects/trueppm%2Ftrueppm/pipelines/{p['id']}\"]))
    print(f\"{p['iid']:>6}  {(d.get('duration') or 0)/60:>5.1f} min  {d['created_at'][:16]}\")
"
```

Read the **distribution**, not one number: floor (best case), median, and tail.
A creep from "5 to 7 min" is usually floor→median→tail of a noisy band, not one
heavy job that landed — say so explicitly rather than hunting for a culprit that
isn't there.

**Trap 2 — the tail job is not the longest job.** The last job to *finish* in the
critical stage sets the wall-clock, even if a parallel job ran longer. Reconstruct
the stage timeline from `started_at`/`finished_at` and find what ends last:

```bash
glab api "projects/trueppm%2Ftrueppm/pipelines/<id>/jobs?per_page=100" 2>/dev/null \
  | python3 -c "
import json, sys
from datetime import datetime
def t(x): return datetime.fromisoformat(x.replace('Z','+00:00')) if x else None
jobs=[j for j in json.load(sys.stdin) if j.get('started_at') and j.get('finished_at')]
t0=min(t(j['started_at']) for j in jobs)
jobs.sort(key=lambda j:-(t(j['finished_at'])-t0).total_seconds())
for j in jobs[:6]:
    print(f\"ends {(t(j['finished_at'])-t0).total_seconds():>5.0f}s  {j['duration'] or 0:>5.0f}s  {j['stage']:<10} {j['name']}\")
"
```

**Trap 3 — variance, not mean, is the fixable friction.** A job whose run-to-run
duration swings by >~30s (e.g. 34s→113s) is a tail-variance problem even if its
median is modest. The usual root cause is a **network fetch on the hot path** — a
live registry / remote-config pull inside a job whose engine is otherwise pinned.
The fix pattern is to **vendor/pin it offline** (as `.semgrep/` did for the SAST
rule packs in #1639): pin the input into the repo, drop the network from the job.
This both kills the variance and closes a reproducibility hole (a remote change
failing an otherwise-green MR). This matches the repo's existing ethos — pinned
image digests, `uv.lock`, cargo-deny `deny.toml`.

Flag: any job consistently > 5 min; the **top 3** duration leaders; the **stage
tail** even if it's not a duration leader; and any job with a **>30s run-to-run
swing**. These are the levers.

### 1c. Override and skip signals (last 50 commits + recent MR descriptions)

```bash
git log origin/main -50 --pretty=format:'%h %s%n%b' \
  | grep -iE 'skip (the )?(architect|voc|ux[- ]design|ux[- ]review|security[- ]review|regression[- ]check|migration[- ]check|perf[- ]check|rbac[- ]check|broadcast[- ]check|changelog)' \
  || echo "(none)"
```

Also check the last 20 merged MR descriptions for "skipped X inline" patterns:

```bash
glab mr list --repo trueppm/trueppm --state merged --per-page 20 --output json 2>/dev/null \
  | python3 -c "
import json, sys
for mr in json.load(sys.stdin):
    desc = (mr.get('description') or '')
    if 'skip' in desc.lower() and any(g in desc.lower() for g in ['architect','voc','ux-design','ux-review','security-review','regression-check']):
        print(f\"!{mr['iid']}: {mr['title'][:80]}\")
"
```

A gate that is skipped in > 20% of MRs in its applicable scope is **ceremonial** and should either become opt-in or have a clearer fast-path exemption.

### 1d. `make pre-push` runtime

```bash
# If a pre-push timing log exists:
test -f .git/hooks/pre-push.log && tail -20 .git/hooks/pre-push.log

# Otherwise time the current run if the user agrees:
# (do not auto-run — pre-push touches the working tree)
```

Budget: under 60 seconds. Anything past that erodes the "always run it" muscle.

### 1e. Mandate vs reality

For each "always use the X agent" rule in `~/.claude/CLAUDE.md`, look for evidence of recent invocation in conversation history. If a rule names a mandatory agent that you cannot find evidence of being invoked in the last N MRs that should have triggered it, that's a **silent skip** — either the rule is dead, the agent is too heavy to bother with, or the user has built an unwritten workaround. All three are friction.

(This step is heuristic — you will not have full history. Note the limitation in the report.)

### 1f. Documentation drift

Diff `~/.claude/CLAUDE.md` and `CLAUDE.md` against actual recent practice surfaced in 1c–1e. Flag any mandate that practice has clearly abandoned.

---

## Step 2 — Rank by cycle-time impact

For each candidate finding, estimate **minutes saved per MR** if fixed. Order the report by that estimate, not by severity. Speed wins compound — a 2-minute saving across 50 MRs/year is bigger than a 30-minute one-off.

Cap the report at the **top 5 findings**. Below 5 is fine; above 5 is noise. If the audit surfaces more, list the rest under "Other observations (not ranked)" without proposed fixes.

For each ranked finding, produce:

```
### Finding N: <one-line title>

**Estimated impact**: ~X min/MR saved · applies to ~Y% of MRs
**Signal**: <which Step 1 query surfaced this and what it showed>
**Root cause**: <what makes this slow / ceremonial / redundant>
**Proposed fix**: <concrete change to a specific file or rule>
**Risk of fix**: <what could go wrong, what protection we lose>
**Issue draft**:
  Title: chore(harness): <slug>
  Milestone: $KAIZEN_MILESTONE
  Labels: chore, tooling, dx
  Body: <2-paragraph description suitable for direct glab issue create>
```

---

## Step 3 — Consolidated report

Print this format to the user:

```
## Kaizen Report — <date> — targeting milestone $KAIZEN_MILESTONE

### Inputs reviewed
- Last N merged MRs
- Last M main-branch pipelines
- Last K commit messages and MR descriptions
- `make pre-push` runtime: <Xs> (budget: 60s) <ok|over>

### Top findings (ranked by min/MR saved)
<5 ranked findings as above>

### Other observations
<unranked items, one-liners>

### Recommended next step
<one sentence: "File the top 3 as issues against $KAIZEN_MILESTONE" or "Defer — current cycle is too far along">
```

---

## Step 4 — File issues (skip if `--silent` or `--no-file`)

For each ranked finding the user approves, run:

```bash
glab issue create --repo trueppm/trueppm \
  --milestone "$KAIZEN_MILESTONE" \
  --label "chore,tooling,dx" \
  --title "<finding title>" \
  --description "<finding body, heredoc>"
```

Cross-link related issues if more than one finding touches the same surface (e.g. two findings about `.gitlab-ci.yml` should reference each other).

If invoked from `/pre-release` (`--silent`), skip this step. The pre-release report will include the kaizen findings as a separate section.

---

## What kaizen does **not** do

- Run the day-to-day agent gates (use those skills directly)
- Audit the codebase for bugs (use `/pre-release` or per-domain agents)
- Modify CI config, CLAUDE.md, or skill files directly — kaizen only **proposes**; the user lands the changes through a normal feature branch and MR
- Loop. One invocation = one pass. To check progress, run it again next month.

## Anti-patterns to refuse

- Filing more than 5 issues from one run — caps prevent dilution
- Proposing fixes that move work from the harness into a new bespoke script — speed-up by complexity is debt
- Auto-closing or auto-modifying existing "mandatory" rules without the user's explicit approval
- Re-flagging the same finding across runs if the user has already declined to act on it (track declined findings in the report as `(declined <date>)` if you can see prior kaizen issues, and demote them to "Other observations")

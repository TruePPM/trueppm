---
name: tracker-hygiene
model: sonnet
description: On-demand hygiene sweep of the TruePPM GitLab issue tracker. Flags release:: scoped-label exclusivity violations, unlabeled issues in a dated milestone, likely-duplicate issues, and stale direction-tagged issues with no milestone. Reports only — never relabels or closes anything. Lighter and more frequent than /dotplanning's one-time kickoff grooming pass; run it between kickoffs to catch drift before it becomes a rescue triage.
argument-hint: "[--milestone <X.Y>] [--silent]"
---

# Tracker Hygiene — Issue Tracker Drift Sweep

You are sweeping the TruePPM GitLab tracker for drift that accumulates **between**
`/dotplanning` runs. `/dotplanning` is explicitly a one-time kickoff gate — re-running it
mid-cycle rediscovers the same gaps and turns into whack-a-mole. That leaves nothing
watching the tracker for the rest of the cycle, and drift is not hypothetical here: the
tracker has already reached 474 open issues against one date before anyone caught it
(#3120), and `release::` scoped labels can end up doubled on one issue because `glab`'s
add-label path does not enforce scoped-label exclusivity. This skill is the lightweight,
repeatable check that catches that drift early instead of at the next rescue triage.

**Report only.** Every finding here is a candidate for the user to act on — this skill
never calls `glab issue update`, `glab label`, or anything else that mutates the
tracker. Applying a `release::` label, in particular, is the user's call every time per
CLAUDE.md's milestone-commitment rule — ask, never infer, even when the "obvious" value
seems clear from context — and this skill's job stops at naming which issues need that
call made.

## Scope discipline

In scope:
- `release::` scoped-label exclusivity violations (two or more values on one issue)
- Issues in a dated milestone carrying **no** `release::` value
- Likely-duplicate issues (title/description overlap)
- Stale `direction`-tagged issues (unmilestoned, no recent activity)

Out of scope:
- Deciding *which* `release::` value an issue should carry — that is `/dotplanning`'s
  grooming pass (at kickoff) or a direct user decision (mid-cycle); this skill only
  finds issues missing a decision, never makes one
- The full feature→asset gap map, kickoff questions, and workstream sequencing —
  that is `/dotplanning`, run once at the start of the dot release
- Enforcing the `enterprise`/`portfolio` label ban on open OSS issues — that is the CI
  `boundary:check` job; do not duplicate it here

## When to run

- On demand, whenever the tracker "feels" like it's drifting
- On a light recurring cadence between dot-release kickoffs (e.g. biweekly) — this is
  cheap enough to run far more often than `/dotplanning`
- **Not** as a substitute for `/dotplanning` at kickoff, and not as an iterative loop
  within one session — one sweep, one report, per invocation

## Arguments

- `--milestone <X.Y>` — target a specific milestone. Defaults to the active dated
  milestone with the nearest due date if omitted.
- `--silent` — report only, skip the "file a grooming reminder" offer in Step 6.

---

## Step 0 — Resolve target milestone

```bash
glab api "projects/trueppm%2Ftrueppm/milestones?state=active" 2>/dev/null \
  | python3 -c "
import json,sys
ms=[m for m in json.load(sys.stdin) if m.get('due_date')]
ms.sort(key=lambda m: m['due_date'])
for m in ms: print(m['title'], m['due_date'])
"
```

Pick the nearest-due dated milestone unless `--milestone` was passed. Export as
`$MILESTONE`. This is deliberately simpler than `/dotplanning`'s shipped/next-open
resolution (Step 0 there) — tracker hygiene sweeps whatever milestone is currently in
flight, not the one about to open.

## Step 1 — Pull milestone issues

`glab api --paginate` emits one JSON array **per page, concatenated**, which a bare
`json.load` rejects on more than one page. Use this reader for every paginated query
below:

```bash
read_pages() { python3 -c "
import json,sys
raw=sys.stdin.read(); dec=json.JSONDecoder(); i=0; out=[]
while i<len(raw):
    while i<len(raw) and raw[i].isspace(): i+=1
    if i>=len(raw): break
    o,i=dec.raw_decode(raw,i); out+=o
json.dump(out,sys.stdout)"; }

glab api --paginate "projects/trueppm%2Ftrueppm/issues?milestone=$MILESTONE&state=opened&per_page=100" 2>/dev/null \
  | read_pages > /tmp/tracker-hygiene-issues.json
python3 -c "import json; print(len(json.load(open('/tmp/tracker-hygiene-issues.json'))), 'open issues in $MILESTONE')"
```

## Step 2 — Scoped-label exclusivity violations

```bash
python3 -c "
import json
issues = json.load(open('/tmp/tracker-hygiene-issues.json'))
for i in issues:
    rel = [l for l in i['labels'] if l.startswith('release::')]
    if len(rel) >= 2:
        print(f\"#{i['iid']:>4}  {'+'.join(rel)}  {i['title'][:80]}\")
"
```

Any hit here is a data-integrity finding, not a judgment call — GitLab's UI enforces
scoped-label exclusivity but the API path some tooling uses does not, so this state
exists in practice. Report each one; do not silently pick a value to keep.

## Step 3 — Unlabeled issues in the dated milestone

```bash
python3 -c "
import json
issues = json.load(open('/tmp/tracker-hygiene-issues.json'))
for i in issues:
    if not any(l.startswith('release::') for l in i['labels']):
        print(f\"#{i['iid']:>4}  {i['title'][:90]}\")
"
```

Per CLAUDE.md's milestone-commitment rule, every issue in a dated milestone carries
exactly one of `release::committed` / `release::reserve` / `release::stretch`. An
unlabeled issue here is a visible gap the tracker is currently hiding.

## Step 4 — Likely-duplicate issues

This is inherently fuzzy — present candidates, not certainties, and say so in the
report. Normalize titles (lowercase, strip punctuation, drop common stopwords) and flag
pairs with high token overlap, especially when they also share a non-`release::` label
(same component/domain):

```bash
python3 -c "
import json, re
from itertools import combinations
issues = json.load(open('/tmp/tracker-hygiene-issues.json'))
def norm(t): return set(re.sub(r'[^a-z0-9 ]',' ',t.lower()).split()) - {'the','a','an','to','for','on','in','of','and'}
pairs = []
for a, b in combinations(issues, 2):
    wa, wb = norm(a['title']), norm(b['title'])
    if not wa or not wb: continue
    overlap = len(wa & wb) / min(len(wa), len(wb))
    if overlap >= 0.6:
        pairs.append((overlap, a['iid'], b['iid'], a['title'][:60], b['title'][:60]))
for o, ia, ib, ta, tb in sorted(pairs, reverse=True)[:15]:
    print(f'{o:.0%}  #{ia} {ta!r}  <->  #{ib} {tb!r}')
"
```

Read every hit before reporting it — a 60%+ token overlap on short titles produces
false positives (e.g. two issues both titled around "fix schedule view" for unrelated
bugs). Drop any pair where reading both descriptions shows they're genuinely different
work; keep the rest as candidates for the user to confirm or dismiss.

## Step 5 — Stale `direction`-tagged issues

```bash
glab api --paginate "projects/trueppm%2Ftrueppm/issues?labels=direction&state=opened&per_page=100" 2>/dev/null \
  | read_pages | python3 -c "
import json, sys
from datetime import datetime, timezone
now = datetime.now(timezone.utc)
for i in json.load(sys.stdin):
    if i.get('milestone'): continue
    updated = datetime.fromisoformat(i['updated_at'].replace('Z','+00:00'))
    age_days = (now - updated).days
    if age_days >= 90:
        print(f\"#{i['iid']:>4}  {age_days:>4}d idle  {i['title'][:80]}\")
"
```

`direction` is the label for intended-but-unmilestoned work per CLAUDE.md — it is not
supposed to be a place issues go to be forgotten. 90 days with no update on an
unmilestoned `direction` issue is a candidate to either pull into a milestone or close as
no-longer-intended; this skill only surfaces the candidate.

## Step 6 — Report

```
## Tracker Hygiene — $MILESTONE — <date>

### Scoped-label violations (Step 2)
<issue list, or "none">

### Unlabeled in $MILESTONE (Step 3)
<issue list with count, or "none">

### Likely duplicates (Step 4)
<candidate pairs with overlap %, or "none found above threshold">

### Stale `direction` issues (Step 5)
<issue list with idle days, or "none">

### Recommended next step
<one sentence — e.g. "N issues need a release:: decision; raise with the user directly
rather than inferring one" or "clean sweep, nothing to action">
```

If `--silent` was not passed and any finding exists, offer once: "Want me to draft the
`release::` questions as a single message so you can answer them in one pass?" — do not
apply any label yourself even if the user answers inline; state the values back and let
the user confirm before anything is written to the tracker (same posture as
`/dotplanning`'s grooming pass).

---

## What this does not do

- Apply, remove, or change any label
- Close, reopen, or edit any issue
- Decide a `release::` value — it only finds issues where that decision is missing
- Replace `/dotplanning`'s full kickoff pass (asset gaps, open questions, workstream
  sequencing, capacity baseline) — this is a narrower, cheaper, repeatable check

## Anti-patterns to refuse

- Auto-applying a `release::` label to resolve an unlabeled-issue finding
- Treating a fuzzy title-overlap match as a confirmed duplicate without reading both
  issues
- Running this repeatedly within one session as a substitute for actually resolving the
  findings — one sweep, one report, then act or move on
- Widening scope to a full asset/gap audit — that scope creep is exactly what
  `/dotplanning`'s "one-time gate" discipline exists to prevent from happening mid-cycle

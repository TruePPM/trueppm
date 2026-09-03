---
name: voc-audit
model: sonnet
description: Run a Voice-of-Customer panel against a shipped TruePPM surface (a recently merged feature, page, or flow) and cross-reference findings with the GitLab issue tracker. Produces a ranked "file new / boost priority / already tracked" matrix. Distinct from `/voice-of-customer` (which evaluates a spec or design) — voc-audit reviews what actually shipped. Distinct from `/ux-review` (design-system compliance) — voc-audit reasons about persona-level friction. Run on demand against a recently-merged user-visible MR, or as a cross-cutting step inside `/pre-release full`.
argument-hint: "<surface description, MR number, issue number, or path under packages/web/src>"
---

# VoC Audit — Persona Review of Shipped Surfaces

You are running a persona-level review of a **shipped** TruePPM surface — not a spec, not a design, not a proposed feature. Something that already merged. The output is a ranked list of material improvements anchored to persona priorities, cross-referenced against open and closed GitLab issues so the user can act on it without re-filing duplicates.

**Scope discipline.** voc-audit answers two questions only:

1. Where does this shipped surface fall short of what the personas need to use it day-to-day?
2. For each shortfall, is it (a) already tracked, (b) tracked but under-prioritized, or (c) untracked and needs filing?

If a finding does not fit one of those, drop it. voc-audit is not a generic UX critique, not a security audit, not an architectural review — those have their own skills.

**One boundary is worth naming, because this skill cannot cross it.** Every voc-audit finding is an improvement to make; the matrix has no cell for "this should not exist." If the audit keeps concluding that a surface is not worth fixing — it is half-built, oversold in the docs, or nobody's workflow needs it — that is a different question and it belongs to `/sunset-check`, which inverts the panel to ask what breaks if the surface is removed and can return a removal verdict. Hand it over rather than filing improvement issues against something that should be deleted.

**Anti-pattern to refuse.** Running voc-audit with no surface argument and producing a wishlist for "TruePPM in general." Persona feedback drifts into noise without a concrete artifact to react to. If the user invokes voc-audit with no argument, ask them to pick one shipped surface — do not proceed.

---

## When to run

- **On demand** against a user-visible MR within ~2 weeks of it merging — recent enough that the implementation is fresh, old enough that you can use it for a real task
- **Automatically**, as a cross-cutting step of `/pre-release full` (one voc-audit pass per user-visible surface shipped since the last release tag)

Do **not** run voc-audit:
- On unmerged work (use `/voice-of-customer` against the spec instead)
- On the codebase as a whole (no concrete surface = persona drift)
- More than once per surface per release cycle (re-discovers the same friction; demote to "already covered" without re-filing)
- Against backend-only changes with no user-visible behavior (no surface for personas to react to)

---

## Step 0 — Resolve the target surface

Read `$ARGUMENTS`. Accept any of:

- An MR number (e.g. `!214`) → fetch via `glab mr view 214 --repo trueppm/trueppm` to learn what shipped, then identify the user-visible surface from the changed files
- An issue number (e.g. `#509`) → fetch via `glab issue view 509 --repo trueppm/trueppm` and read the closing MR(s) from the activity log
- A surface description (e.g. "settings shell", "card dialog redesign", "schedule view drawer") → confirm with the user which MR(s) shipped it, then proceed
- A path under `packages/web/src` (e.g. `packages/web/src/features/settings/`) → read the README / index file in that directory plus a representative page to understand the shipped behavior

If `$ARGUMENTS` is empty or ambiguous, stop and ask the user: "Which shipped surface do you want VoC to review? (MR number, issue number, or a one-line description)" Do not proceed without an answer.

Export the resolved surface as `$SURFACE` (a one-line description) and `$SURFACE_REFS` (the MR/issue numbers and file paths). Both feed every subsequent step.

---

## Step 1 — Inventory what shipped

Before invoking personas, you must understand the surface well enough to brief them on it. Read:

1. The MR description(s) and changelog fragment(s) — what the user-facing change was advertised to do
2. The primary changed files in `packages/web/src/features/` (or wherever the surface lives) — the actual shipped behavior
3. Any new docs page in `docs/features/` or `docs/getting-started/` that covers the surface
4. If the surface includes API changes, the affected viewset(s) and serializer(s) in `packages/api`

Produce a **shipped-behavior brief** (5–10 bullet points): the entry points, what the user can do, what the user *cannot* do, what state-handling is present (loading, empty, error, offline), and what existing flow this replaces or augments. This brief feeds every persona sub-agent — they all need the same picture of the surface.

Do not invent behavior. If the implementation is partial or stubbed (placeholder pages, "coming soon" copy, mocked data), say so explicitly in the brief — that is itself a finding the personas should react to.

---

## Step 2 — Identify the relevant personas

Read `.claude/personas.md` (the canonical source). Pick the personas for whom the surface is in their daily path. Default mapping:

| Surface type | Personas to include |
|---|---|
| PM-facing planning surface (schedule, board, card, task, sprint) | Sarah (PM), Priya (Team Member), Alex (Scrum Master), Jordan (Product Owner) |
| PMO-facing governance surface (program rollup, portfolio, dashboard, settings) | Marcus (PMO Director), David (Resource Manager), Janet (Executive Sponsor) |
| Workspace / admin / settings | Sarah (PM, owner-of-the-workspace lens) + Marcus (PMO admin lens) — plus David if it touches resource policy |
| Mobile / offline flow | Priya first (time capture on the move), Sarah second, Alex third — note Sarah's mobile criteria are N/A until the 0.5 PWA |
| Hybrid agile/waterfall bridge | Alex (Delivery Lead), Jordan, Sarah, Marcus — full bridge demands the full panel |
| MCP / AI / provenance surface | Theo (AI-native technical operator) leads; add Nadia if the API contract itself changes |
| Notification / email / digest | Janet, Marcus, Sarah, Priya — anything the executive layer sees lands on Janet |
| API / integration / webhook / token / OpenAPI surface | Nadia (integration/API developer) leads; add whichever human personas own the data the API exposes |
| Deployment / Helm / migration / observability / backup surface | Omar (self-hosting operator) leads; add Marcus if it touches compliance/audit posture |

A surface that doesn't clearly fit one row gets the full eight-persona human panel. **Minimum three personas.** Add the specialist evaluators (Nadia for API/integration surfaces, Omar for deployment/ops surfaces) whenever the shipped surface touches their domain, and apply the AI-agent actor hard NOs as a cross-cutting constraint on any agent-reachable surface (both defined in `.claude/personas.md`). If you cannot justify three personas, the surface is too narrow for voc-audit (it's probably an internal refactor or a backend-only change — skip voc-audit and return that conclusion to the user).

State the selected personas and the one-line reason for each at the top of the report so the user can challenge the selection before agents fire.

---

## Step 3 — Spawn parallel persona sub-agents

In a **single message** with multiple `Agent` tool calls in parallel (one per persona), spawn Sonnet sub-agents. Each receives:

- The shipped-behavior brief from Step 1
- The persona's full definition from `.claude/personas.md` (paste the relevant section verbatim — do not summarize)
- The VoC Scoring Rubric from `.claude/personas.md`
- The directive to return findings in the exact format below

Sub-agent prompt template:

```
You are <PERSONA_NAME> using a shipped TruePPM surface for the first time. The surface has already been built — you cannot ask for a redesign, only for material improvements that would make this surface usable in your daily work.

Persona definition (use ONLY this persona's lens — do not mix with others):
<paste the persona's full section from .claude/personas.md>

Scoring rubric:
<paste the VoC Scoring Rubric section from .claude/personas.md>

Shipped surface under review:
$SURFACE

Shipped-behavior brief (this is what actually ships today):
<paste the bulleted brief from Step 1>

Walk through how you would use this surface to accomplish a real task in your role. Identify the specific friction points — moments where the surface forces you to do something tedious, switch contexts, or work around a missing capability. For each friction point, propose a concrete, narrow improvement: not "redesign the page" but "add filter X to the existing list" or "persist Y between sessions" or "surface Z in the empty state."

Every finding MUST carry a **falsification line**: a specific, checkable condition that would prove the finding wrong. "Falsified if the CPM date is already visible to a suppressed reader" is a falsification line; "falsified if users are happy" is not. A finding without one is `unscoreable` and counts against the panel, not for it.

Write the line as something a real user does, says, or reports — a support request that never arrives, a demo conversation, a usage metric that stays flat. A condition that only a code check can settle ("falsified if the serializer already exposes the field") will be run against the tree by the auditor, but it predicts nothing about a user and therefore cannot be scored later. Where both apply, give both, labeled.

Return your response in this exact format and nothing else:

## <PERSONA_NAME>: N/10 [optional 🔴 / 🟡 / 🟢]
"<one-sentence quote in this persona's voice describing the surface as shipped>"

### Material improvements (ranked by daily-task impact)
1. **<one-line title>** — <2–3 sentence description: what the friction is, what the improvement is, why it matters for this persona>
   - Hard-NO triggered? <yes/no — quote the hard-NO if yes>
   - Falsification line: <the specific, checkable condition that would prove this finding wrong>
   - Estimated frequency in this persona's workflow: <daily / weekly / monthly / rare>
2. **<title>** — <description>
   - Hard-NO triggered? <yes/no>
   - Falsification line: <…>
   - Estimated frequency: <…>
3. (up to 5 ranked improvements; fewer is fine; never more than 5)

### Already-acceptable aspects
<bullet list of what the surface does well from this persona's lens — short, no more than 5 bullets>

### What this persona could NOT see
<1–3 bullets: questions about this surface this lens is structurally unable to answer>
```

Spawn in P3M layer order so results aggregate predictably: Janet → Marcus → David → Sarah → Jordan → Alex → Theo → Priya. The Agent tool runs them in parallel when issued in one message.

---

## Step 4 — Verify every finding against the code, before touching the tracker

**Do this before the GitLab search.** The panel is simulated and every persona is T0 — its
output is a hypothesis generator, and this is the only step in the run that touches ground
truth. Searching the tracker first means filing model output as fact.

Deduplicate first: personas surface overlapping concerns (e.g. "the empty state is silent"
might come from three lenses at once). Merge identical-substance findings into one canonical
entry and credit the personas that raised it.

Then, for each merged finding, **check its falsification line against the tree**. That is
what the line is for — a falsification line nobody executes is decoration. Read the
component, grep for the symbol, check the serializer, look at `openapi.json`, read the
issue the finding assumes is open. Assign one of three outcomes:

- **survived** — the check ran and the finding stands. Carry it into Step 5. Note what you
  checked, so the report rests on the file:line, not on the persona.
- **falsified** — the condition was met and the finding is wrong. **Drop it, and say so in
  the report.** A falsified finding is a result, not an embarrassment: it is the run
  proving it can tell its own hypotheses from reality, and it is what keeps duplicate and
  incorrect issues out of the tracker.
- **surfaced-during-verification** — the check falsified the finding as stated but exposed a
  real defect one layer away, or you found something adjacent while reading. These are
  frequently the strongest findings in a run. **Attribute them to the check, never to a
  persona** — crediting a persona with a finding it did not make corrupts the calibration
  ledger in Step 10.

Findings that cannot be checked without running the product (frequency-in-practice,
would-a-real-user-accept-this) are **unscoreable**: carry them, but mark them so, and do not
present them with the same confidence as a verified one.

**Code verification is not falsification.** "I verified this against `main` at `<sha>`"
proves the defect exists; it does not predict what a user would say, which is the only
thing calibration can score. Both belong in the issue, in separate fields, and they must
never be conflated: verification grounds the finding in the code, while the falsification
line stakes a claim about the world that a later real report can confirm or refute. A
finding whose "falsification line" restates a code check is `unscoreable` — it counts
against the panel, not for it. So a finding leaves this step carrying **two** things: the
check that grounds it (the file:line, grep, or query) and a falsification line that
predicts a real-world observation. Where the panel gave only a code condition, that
condition has now been executed and is spent — write the real-world line before filing,
or file the finding explicitly marked `unscoreable` so the ledger is not misled about
what the panel actually staked.

Two rules that matter more than they look:

- **A panel finding that rests on an absence must be verified as absent.** "There is no X"
  is the single most common false finding, because the brief in Step 1 can be wrong or stale
  and the personas take it as given. Grep before you believe it.
- **Re-check the brief itself.** If verification shows the Step 1 brief misstated the shipped
  behavior, every finding downstream of that statement is suspect — say so in the report
  rather than quietly correcting one row.

Record the counts. Step 6's report must state how many findings survived, how many were
falsified, and how many were surfaced during verification, so panel yield can be told apart
from verification yield over time.

---

## Step 5 — Cross-reference surviving findings against GitLab issues

Only findings that **survived** Step 4 reach this step — a falsified finding is not searched for, it is reported as falsified and dropped. For each surviving finding, query GitLab in `all` state (open and closed) using 2–3 keywords drawn from the finding (file/feature stem, the verb of the missing capability, the affected entity):

```bash
glab issue list --repo trueppm/trueppm -A --search "<keyword>" 2>/dev/null | head -20
```

Multi-faceted findings (e.g. "the settings shell lacks audit trail for role changes") need more than one query — run one search per facet.

**Separate real reports from modeled findings as you go.** An issue filed from a real
user's words (in-product feedback via #2392, a self-hoster's bug report, a demo
conversation) is evidence of a different kind from an issue filed off a persona panel —
including this one. When a search returns a match, note which it is:

```bash
# Issues originating from real users, not from a simulated panel
glab issue list --repo trueppm/trueppm -A --label "user-report" --search "<keyword>" 2>/dev/null | head -20
```

A finding this panel raised that a real user *also* raised is a **corroborated** finding
and should be labeled and prioritized as such. A finding that matches only other
`voc-audit`-labeled issues is **not** corroborated — it is the same model agreeing with
itself, and reporting it as convergent evidence is the specific error this skill must
not make. Say "raised again by the panel", never "confirmed by users".

For each finding, assign one of these tracking states:

- **`(tracked in #N — priority::<P>)`** — open issue exists. Capture its current priority label. If the persona feedback raises the urgency above the current priority (e.g. a hard-NO trigger on a `priority::P3`), mark this finding as a **boost candidate** in the report.
- **`(closed #N — <date>, <one-line close reason>)`** — closed issue matches the finding's substance. Read the close reason. Do **not** silently re-file. Flag for user classification in Step 7 as one of: regression, new instance (same class, different location), already-decided (drop).
- **`(untracked)`** — no open or closed match. Eligible for new-issue filing in Step 7.

If the user's milestone targeting is non-obvious (e.g. the finding is in-scope for an active milestone vs deferred to next major), record the reasoning inline so the user can decide quickly.

---

## Step 6 — Consolidated report

Print this format to the user. Lead with the selection rationale so the user can correct a wrong persona panel before reading the verdict.

```
## VoC Audit Report — $SURFACE — <date>

> **Simulated panel — not user research.** Findings below come from modeled personas
> (`.claude/personas.md`), not from users. Rows marked **corroborated** additionally
> match a real user report and are cited; every other row is a hypothesis about what
> users would say. See `.claude/persona-calibration.md` for how well this panel has
> predicted reality so far.

### Surface reviewed
- Description: $SURFACE
- References: $SURFACE_REFS
- Shipped-behavior brief: <link or 1-line summary>

### Personas included
<one line per persona explaining why they're in the panel; one line per persona omitted explaining why not>

### Panel verdict
| Persona | Score | Hard-NO? | One-line take |
|---|---|---|---|
| Sarah (PM) | N/10 | yes/no | <one-line> |
| Marcus (PMO) | N/10 | yes/no | <one-line> |
| … | … | … | … |

**Average**: X.X/10
**OSS/Enterprise signal**: <which P3M layer responded best/worst, and what that says about positioning>
**Hard-NO summary**: <list any triggered hard-NOs in plain language>

### Verification yield
| Outcome | Count |
|---|---|
| Panel findings that survived verification | N |
| Panel findings falsified by verification | N |
| Findings surfaced *during* verification (no persona raised them) | N |
| Unscoreable (not checkable without running the product) | N |

<one line on what this ratio says about the run — a panel whose findings mostly
falsified was a weak panel, and a run whose best findings came from verification
should say so rather than presenting them as panel output>

### Material improvements (ranked by impact × frequency × affected personas)

#### 1. <title> — <tracking state>
- **Raised by**: <personas who flagged it — or "verification (no persona raised this)">
- **What's missing**: <one paragraph>
- **Verified**: <the file:line, grep, or query that confirms it — this is what the finding rests on, not the persona>
- **Falsification line**: <the real-world observation that would refute it, carried verbatim from the persona that raised it — or `unscoreable`, with the reason. Not a restatement of the Verified line above; they are different fields>
- **Proposed improvement**: <narrow, concrete change>
- **Why it matters**: <impact + frequency reasoning, drawn from persona quotes>
- **Action**: file new / boost #N to priority::<P> / cross-link as new instance of closed #N / drop (already decided in #N)

#### 2. <title> — <tracking state>
…

(cap at 8 improvements after deduplication; below 8 is fine; anything ranked lower lives under "Other observations")

### Falsified by verification — reported, not filed
<one line per dropped finding: the claim, the persona that raised it, and the check that
killed it. Never omit this section because it looks like failure — it is the evidence the
run can tell its own hypotheses from reality, and a reader who does not see it cannot know
whether the surviving findings were checked at all. "None" is a valid entry only if every
finding genuinely survived.>

### Already-tracked, no change needed
<bulleted list of findings that map cleanly to an existing open issue at an appropriate priority>

### Already decided (closed and not regressions)
<bulleted list of findings that match a closed issue with a "won't fix" or design-decision close reason>

### Already-acceptable aspects
<consolidated list across personas — what the surface does well>

### Recommended next step
<one sentence: "File N untracked findings; boost M existing; defer K to next milestone">
```

---

## Step 7 — Act on the matrix (interactive)

For each finding requiring action, ask the user explicitly before mutating GitLab state. Never silently file, boost, or close.

1. **Untracked findings → offer to file new issues.** Group them by milestone target (`$WORKING_RELEASE` if the surface is in-scope for the active release, the next minor if it's a future improvement). Ask: "File the N untracked findings above as issues against milestone `$WORKING_RELEASE`? (y / select / n)"
   - `y` → file all with `glab issue create --repo trueppm/trueppm --milestone "$WORKING_RELEASE" --label "ux,voc-audit" --title "<title>" --description "<heredoc body built from .gitlab/issue_templates/VoC-Finding.md>"`
   - `select` → ask which subset
   - `n` → list them as a manual checklist

   **File through `.gitlab/issue_templates/VoC-Finding.md`, never `Bug.md` or
   `Feature.md`.** Build the `--description` heredoc from that template and fill every
   field: the provenance block, the raising persona(s), the finding, the falsification
   line, and the code-level verification. Those last two are the fields that get dropped
   when a panel finding is filed as an ordinary bug, and the falsification line is the
   one thing `/voc-audit --calibrate` can score — a finding filed without it is graded
   `unscoreable` a release later, counting against the panel however right it turns out
   to be.

   **Every issue body carries its provenance and its evidence, and they are not the same
   thing.** State that a simulated panel raised it and that the panel is not evidence; then
   cite the file:line, grep, or query from Step 4 that the issue actually rests on. A
   finding **surfaced during verification** must say so and must not be attributed to a
   persona — crediting a persona with a finding it did not make inflates the panel's
   apparent hit rate and corrupts the Step 10 ledger. Where verification lowered a
   finding's severity below what the panel scored, file at the verified severity and say
   that you did.

   **Code verification is not falsification** — keep them in their own fields, as Step 4
   requires. "I verified this against `main` at `<sha>`" belongs under *Code-level
   verification*; it proves the defect exists and predicts nothing about a user. The
   *Falsification line* field is the claim about the world a later real report can confirm
   or refute, and it is the only one calibration can score. Copying the verification into
   the falsification field makes the finding `unscoreable` while looking complete, which
   is worse than leaving it blank. Never put a panel score or the panel average in the
   issue body.
2. **Boost candidates → offer to update priority labels.** Ask: "Boost M existing issues to a higher priority based on hard-NO triggers? (y / select / n)" — same flow. Use `glab issue update <iid> --label "priority::P<n>"` and remove the old priority label first.
3. **Closed-issue matches → ask the user to classify each.** For each, present:
   > Finding X matches closed #N ("<title>", closed <date>, close reason: <one-line>). Options:
   > - **regression** — reopen #N with a note linking this audit
   > - **new instance** — open a new issue that references #N, on the same
   >   `VoC-Finding` template and with every field filled
   > - **already decided** — drop from the report
   
   Wait for the answer per finding. Never re-file silently.

Cross-link related issues if two findings touch the same surface (e.g. two findings on the settings shell should reference each other so a future contributor sees the cluster).

---

## Step 8 — Tighten upstream skills when patterns emerge

If voc-audit surfaces a pattern that a day-to-day skill *should* have caught (e.g. ux-design produced a surface that ux-review approved but personas reject), update the relevant skill file to add the missed check.

Apply the same rules as `/pre-release` Step 5:
1. Abstract to the class of problem, not the specific instance
2. Add the check to the agent's trigger condition only if it's structurally testable
3. Do not hardcode filenames, persona names, or feature names
4. Write a "what to look for" principle, not a "look for this" rule

Most voc-audit findings should land as GitLab issues, not as skill changes. Update a skill only when **two or more findings** in the same audit point at the same upstream gap — a single miss is noise.

---

## Step 9 — When invoked from `/pre-release full`

`/pre-release` will pass `--from-pre-release` along with a list of surfaces shipped since the last release tag. In that mode:

- Skip the interactive Step 0 question — the surface list is already resolved
- Run voc-audit once per surface (in parallel if there are 3+ surfaces) but cap at the 5 highest-impact surfaces by changed-line count
- Suppress the interactive prompts in Step 7 — return the structured matrix instead, and let `/pre-release` consolidate filing decisions across all surfaces at once
- Emit a single consolidated section per surface for `/pre-release` to fold into its report
- **Do not skip Step 4.** Verification is the step that keeps unverified model output out of a release-gate report, which is the context where it is most likely to be read as fact. Return the verification-yield counts per surface so `/pre-release` can weigh a panel-heavy surface differently from a verified one.

---

## Step 10 — Calibration pass (`--calibrate`)

This is the step that makes the persona model falsifiable. Run it **once per release
cycle that reached real users**, not per surface. Invoke as `/voc-audit --calibrate` with
no surface argument — this is the one mode where a surface is not required, because the
subject is the panel itself rather than any shipped screen.

Skip it, with a one-line note, if no real user signal arrived during the cycle. Do not
manufacture an entry from an empty cycle.

### 10a — Gather the cycle's real signal

```bash
# Everything real users said this cycle
glab issue list --repo trueppm/trueppm --label "user-report" -A -P 100

# Everything the panel predicted this cycle
glab issue list --repo trueppm/trueppm --label "voc-audit" -A -P 100
```

### 10b — Score three buckets

- **Hits** — a panel 🔴/🟡 that a real report independently matches. Cite both issue
  numbers. Only findings that carried a falsification line are scoreable; read it off the
  issue's *Falsification line* field and record any finding that has none — or whose line
  is a restated code check — as `unscoreable`, which counts against the panel.
- **Misses** — a real report no persona raised. Read each one and decide: does it reveal
  a gap in a persona definition (amend `personas.md` and say so), or is it knowingly out
  of model? Misses are the highest-value rows here.
- **False alarms** — a panel 🔴 whose falsification condition was met. Note which persona
  raised it; repeated false alarms on a topic reduce that persona's weight on that topic
  in future `/voc` runs (see `/voc` Step 0a).

### 10c — Append to the ledger

Append one cycle entry to `.claude/persona-calibration.md` in the format that file
defines. Rules that file enforces and this step must respect:

- Grounding tiers in `personas.md` may **only** be raised by a cited entry here
- Misses stay in the ledger permanently, even after the persona is amended
- Never backfill or re-score a previous cycle with hindsight
- Carry forward the survivorship-bias caveat: silent evaluators who left are invisible
  to this method, so every hit rate is an upper bound

### 10d — Report honestly

Lead the calibration report with the miss count, not the hit count. A panel that scored
6 hits and 14 misses did not perform well, and a report ordered by hits will read as
though it did.

---

## What voc-audit does **not** do

- Evaluate unmerged specs — use `/voice-of-customer` against the spec
- **Treat agreement between two simulated panels as corroboration** — only a real user report corroborates a modeled finding
- **File a finding it did not verify** — every issue opened from a run cites the check from Step 4, not only the persona that raised it
- **Credit a persona with a finding that came from verification** — attribute it to the check; the ledger depends on the distinction
- **File a finding without its falsification line and its raising persona** — both are required fields on `.gitlab/issue_templates/VoC-Finding.md`, and a finding filed without them cannot be scored by Step 10 however right it turns out to be
- **Pass a code check off as a falsification line** — verification proves the defect exists; the falsification line predicts what a user would report. They are separate fields and conflating them yields an `unscoreable` finding that looks complete
- **Raise a persona's grounding tier** outside a Step 10 ledger entry with a citation
- Audit the codebase for bugs, perf issues, or security gaps — those have dedicated skills. Verification in Step 4 checks *the panel's claims*; it is not licence to start a general bug hunt
- File issues without explicit user approval — every mutation is opt-in
- Re-flag the same finding across runs — track declined findings as `(declined <date>)` and demote on the next pass
- Run more than once per surface per release cycle — re-running re-discovers the same friction and creates audit fatigue

---
name: sunset-check
model: sonnet
description: >
  Decide whether to remove, fix, narrow, or demote an existing TruePPM surface. Inverts
  the Voice-of-Customer question — instead of "would you adopt this?", it asks each
  persona "this is gone next release, what breaks for you?" — and scores removal cost
  rather than adoption likelihood. Verifies what the surface actually does against what
  the docs and ADRs claim it does before scoring anything, because a panel handed an ADR
  scores a feature that may not exist. Use when considering deleting a feature, when a
  shipped surface is half-built or oversold, when maintenance cost is outrunning use, or
  when asked whether something should just be taken out.
---

# Sunset Check Skill

You are deciding the fate of a surface that **already exists** in TruePPM. The output is a
recommendation among four verbs — remove, keep-and-fix, keep-but-narrow-the-claim, demote
to experimental — with the evidence for it and the observation that would refute it.

**Before producing any output, read `.claude/personas.md`** — the single source of truth
for the eleven persona definitions, the AI-agent actor note, the target-market ICP, and
the grounding tiers. Do not use persona content defined outside that file.

## What this skill produces — read this before using its output

Like `voice-of-customer`, this skill produces **simulated feedback from modeled personas**
plus a reading of the codebase. It is not user research. Nobody is asked anything.

The provenance rules from `voice-of-customer` apply here unchanged and are not optional:
every output carries the banner in Step 5; real signal supersedes the panel; nothing this
skill emits may be quoted outside a sunset-check context as though it were customer
feedback.

One rule is specific to this skill and is the most important line in the file:

> **A simulated panel never authorizes a removal.** Deleting a shipped capability is a
> promise broken to whoever was using it. The panel routes attention and prices the
> maintenance burden; a human decides. A low removal-cost score is an argument to
> *investigate* removal, never a mandate to merge one.

## Why this is not `/voice-of-customer` with a different prompt

`voice-of-customer` scores **predicted adoption of a proposed addition**. Pointed at a
removal question, its number is ambiguous in a way no amount of prompting fixes: a 3/10
cannot be read as "removing this would be bad" or "this thing is bad" — those are opposite
recommendations and the rubric produces the same digit for both. Its next-step vocabulary
(`proceed` / `scope down` / `re-examine assumptions`) has no removal verb in it either.

`voc-audit` reviews shipped surfaces, but always *toward improvement* — its output matrix
is file-new / boost-priority / already-tracked. It has no way to conclude "delete this."

This skill fills the gap. Use it when the question is the surface's continued existence.

## Step 0 — Establish what the surface actually does

**Do not skip this and do not substitute the ADR for it.** A panel handed a design
document scores a feature as designed; the decision in front of you is about the feature as
shipped, and on a half-built surface those are different products.

1. **Find the implementation.** Name the files, the endpoints, the WS events, and the UI
   entry points. If you cannot find an entry path a user could actually reach, that is the
   single most important finding in the run — say so in the first line of the report.
2. **Read what we claim about it** — `packages/website/src/content/docs/`, the relevant
   ADR under `docs/adr/`, `README.md`, and the changelog entry that introduced it.
3. **Diff claim against code** and classify the surface into exactly one of:

   | State | Meaning |
   |---|---|
   | **Delivered** | Code does what the docs say |
   | **Oversold** | Docs and/or an ADR promise materially more than the code does |
   | **Vestigial** | Code exists, no reachable entry point, or no reader for what it writes |
   | **Undocumented** | Code does something real that we never told anyone about |

4. **Check reversibility before anything else.** Removal is not symmetric with addition —
   a feature can be re-added, destroyed data cannot, and a broken client stays broken.
   Answer three questions and put the answers in the report:
   - Does removing it **destroy or orphan user data**? If so the recommendation is a
     deprecation path with a migration, never a delete, whatever the panel says.
   - Is it in `docs/api/openapi.json`, `FROZEN_WS_EVENT_TYPES`, the MCP surface, or the
     `trueppm-scheduler` public API? Then removal is a **breaking API change** and carries
     that process regardless of removal-cost score.
   - Is it an **OSS↔Enterprise extension point**? Enterprise registers against these; their
     shape is a contract with paying customers.

5. **Price the cost of keeping it.** Nobody on the panel represents this, so measure it
   here and hand it to them as fact: source lines, test files, docs pages, ADRs, open
   issues, and CI jobs that exist only to serve this surface. An oversold surface also
   carries a **trust cost** — a self-hoster who finds the docs overstate one feature
   reasonably discounts every other claim in them.

> **The oversold case has no status-quo option.** When Step 0 classifies a surface as
> Oversold, "leave it alone" is not on the menu, because the current state is actively
> misleading users. The four verbs collapse to three: fix the code, narrow the claim, or
> remove both. Say this explicitly in the report rather than letting inaction win by
> default — it is how an oversold surface survives review after review.

## Step 1 — Establish what evidence already exists

Run **Step 0a of `voice-of-customer` verbatim** — the three sources (our tracker, external
practitioner evidence, the calibration ledger), the E0–E3 evidence tier, and the rule that
external category evidence may never raise a persona's grounding tier. Do not restate that
section here; read it there so the two skills cannot drift apart.

Two additions specific to a removal decision:

- **Absence of complaint is not evidence of value, and it is not evidence of worthlessness
  either.** Pre-beta we have neither. Record E0 honestly and do not let silence be read as
  either signal — that inference is how a surface both survives and dies for no reason.
- **A competitor's deprecation notice is unusually strong evidence here**, and it is public.
  If comparable tools have shipped, then removed, this class of functionality, their
  changelog usually says why and their users usually replied. Spend a search on it.

## Step 2 — Spawn the panel with the question inverted

Using the `Agent` tool, in a **single message** with parallel tool calls, spawn one
sub-agent per relevant persona.

**Mandatory panelists**, regardless of the surface:

- **Omar (self-hosting operator)** — conditional in `voice-of-customer`, required here. He
  carries the pre-install evaluation lens and is the only persona who feels the trust cost
  of an oversold feature. He is also the one who feels a removal as an upgrade surprise.
- **Nadia (integration/API developer)** — required whenever Step 0.4 found an API, WS, or
  MCP footprint. Removing something she may have built against is her hard-NO territory.

Otherwise include the personas whose daily work touches the surface, and omit the rest with
a one-line note. Apply the AI-agent actor hard NOs as a cross-cutting constraint.

Sub-agent prompt template:

```
You are simulating <PERSONA_NAME> reacting to the REMOVAL of an existing TruePPM surface.
Use ONLY this persona's own section — goals, pain points, evaluation criteria, hard NOs,
N/A criteria, Frequency & time budget, Routine load, and 10/10 anchor. Do not mix personas.

Persona definition:
<paste the persona's full section from .claude/personas.md>

The surface, as it ACTUALLY EXISTS TODAY (verified against the code in Step 0 — this may
be less than the documentation promises, and if so the gap is stated here; reason about
what is described in this block, never about what the feature was designed to be):
<paste the Step 0 findings: implementation, claim-vs-code state, reversibility answers>

Established facts (checked before this panel convened — treat as given, do not reason
against them; external evidence is about the CATEGORY, not about TruePPM users):
<paste the Step 1 evidence-tier findings and the cost-of-keeping measurements>

THE QUESTION — answer this one, not the usual adoption question:

  This surface is removed in the next release. It is gone. What breaks for you?

Score REMOVAL COST on this scale. This is NOT the adoption scale from the VoC rubric and
the numbers do not mean the same thing — read the rows, do not reuse a remembered scale:

| Score | Predicted reaction to it being gone |
|-------|-------------------------------------|
| 10    | This is why I chose TruePPM. Removing it ends my evaluation or my usage |
| 8-9   | A documented top-3 criterion of mine dies with it. I need a replacement before it goes |
| 6-7   | Real loss with a workaround I would resent doing |
| 4-5   | I would notice and adapt within a week |
| 2-3   | I would probably not notice |
| 0-1   | Good riddance — it confuses me, or it promises something it does not deliver |

Severity tags, ALSO INVERTED from the VoC rubric:
- BLOCKER — removal triggers one of this persona's hard NOs, or kills an in-scope top-3
  evaluation criterion. This is an argument AGAINST removal.
- CONCERN — real but survivable loss; removal needs a migration note or a replacement path.
- WIN — removal is a net gain for this persona: it removes confusion, an unmet promise, or
  a path that wastes their time. Note the inversion carefully — a WIN here means the
  feature going away is GOOD, the opposite of what a WIN means in a VoC panel.
- N/A — the criterion depends on a capability outside the current release window. Not a
  finding, not a score input, never a blocker.

You are modeling a composite persona, not reporting what a real person said. Do not invent
biographical detail, usage history, or events not in the persona definition.

Return your response in this exact format and nothing else:

## <PERSONA_NAME>: removal cost N/10 [BLOCKER / CONCERN / WIN]
"<one-sentence quote in this persona's voice reacting to the surface being gone>"

What breaks: <concretely, what this persona can no longer do, or "nothing">

Cheapest replacement: <the smallest thing that would make this removal painless for this
persona — an export, a doc line, a different existing feature. Write "none needed" if the
removal costs them nothing.>

Falsification: <for each BLOCKER and CONCERN, one line naming the real-world observation
that would confirm or refute it after a removal — "no operator reports its absence within
one release", "someone asks where it went in the first week", "usage telemetry shows it
was opened N times". A line naming a code check is NOT a falsification line. If you cannot
name one for a BLOCKER, downgrade it to CONCERN and say why.>

Blind spot: <one line — what could a real person in this role tell us that you,
reasoning only from the persona definition, structurally cannot?>
```

## Step 3 — Weigh the panel against the cost of keeping

Do not delegate this. The synthesis is the skill.

The panel prices what is lost. Step 0.5 priced what is paid. Neither number decides alone,
and **a removal-cost average is not an inverted adoption average** — do not carry either
across from a `voice-of-customer` run on the same surface, and do not compare them.

Read the two together:

| Removal cost | Cost of keeping | Reading |
|---|---|---|
| Low | High | Strongest case to **remove** |
| Low | Low | **Demote to experimental** — cheap to keep, nobody needs it, stop advertising it |
| High | High | **Keep-and-fix** — it is load-bearing and underbuilt. This is the expensive answer and usually the right one |
| High | Low | **Keep.** There is no decision here; do not manufacture one |

A single BLOCKER outweighs a low average in either direction. Do not average away a hard
NO, and do not let a chorus of WINs retire one.

## Step 4 — Pick a verb

The recommendation is exactly one of these four, with the condition that selects it:

- **Remove** — no BLOCKER, removal cost low across the panel, cost of keeping real, no
  data destroyed, no API contract broken. Ships with: the deletion, the docs removal, the
  changelog fragment, and an issue recording what was removed and why so it is not
  silently re-proposed in six months.
- **Keep-and-fix** — a BLOCKER exists, or the surface is Oversold and the promise is worth
  keeping. Ships with: an issue per gap between claim and code, and a named owner.
- **Keep-but-narrow-the-claim** — the code is fine, the documentation is not. The most
  common right answer for an Oversold surface, and the cheapest. Ships with: the docs diff
  that makes the claim true, and a `documentedFor` / `Ships in 0.X` callout if the fuller
  version is genuinely planned (see the version-status rules in `CLAUDE.md`).
- **Demote to experimental** — keep the code, remove the advertising. Ships with: docs
  moved behind an explicit experimental label, and removal from any getting-started or
  evaluation path.

"Leave it exactly as it is" is not one of the four. If that is genuinely right, the run
should have concluded at Step 0 that there was no question to answer.

## Step 5 — Report

```
> **Simulated panel — not user research.** Every persona verdict below is a language model
> reasoning from the composite personas in `.claude/personas.md`. No user was interviewed,
> surveyed, or observed. Scores are predicted removal cost against documented criteria, not
> measured sentiment. All personas are grounding tier T0 unless
> `.claude/persona-calibration.md` says otherwise.
> **A simulated panel does not authorize a removal.** This is a recommendation to a human.
> **Evidence tier:** <E0 | E1 | E2 | E3> — <what each Step 1 source returned. External
> evidence is cited as evidence about the category, never as reports from TruePPM users.>

### Surface reviewed
<what it is, where the code lives, how a user reaches it>

**Claim vs code**: <Delivered | Oversold | Vestigial | Undocumented> — <the specific gap>

**Reversibility**: data destroyed: <yes/no> | API contract: <yes/no> | extension point:
<yes/no>. <Any "yes" constrains the verdict regardless of score.>

**Cost of keeping**: <lines, tests, docs pages, ADRs, open issues, CI jobs — plus the
trust cost if Oversold>

### Panel verdict — removal cost
| Persona | Removal cost | What breaks |
|---|---|---|
| Omar (Self-Hosting Operator) ‡ | N/10 | … |
| … | N/10 | … |

‡ Mandatory panelist. Nadia is mandatory when the surface has an API/WS/MCP footprint.
Personas omitted with a one-line reason: <…>

**Average removal cost**: X.X/10 — routes attention only; it authorizes nothing and is
never carried outside this context.

**Arguments against removal**:
- BLOCKER <…> — *raised by:* <persona> — *would be refuted by:* <falsification line, verbatim>

**Arguments for removal**:
- WIN <…> — *raised by:* <persona> — *would be refuted by:* <line>

**Cheapest replacements offered**: <synthesize the sub-agents' replacement lines — often
one export or one doc sentence retires the whole objection>

**What this panel could not see**: <1-3 open questions only a real user can answer>

**Answerable and unanswered**: <any empirical unknown that was cheap to answer and was not
— with the query that would have answered it, or "none". This is a defect in the run.>

### Recommendation: <remove | keep-and-fix | keep-but-narrow-the-claim | demote to experimental>
<one paragraph. Name the condition from Step 4 that selects this verb.>

**If this is wrong, we find out when**: <the single observation that would prove it — for a
removal, name the window: "nobody asks where it went within one release of 0.X">
```

## Step 6 — Carry the falsification lines out

Same contract as `voice-of-customer` Step 3. A removal decision produces unusually good
falsification lines — *"nobody reports its absence within one release"* is genuinely
checkable, which is exactly what `/voc-audit --calibrate` needs and rarely gets — so
losing them in the transcript is a real cost.

- Every issue filed off this run uses `.gitlab/issue_templates/VoC-Finding.md`, which has
  required fields for the line and the persona that raised it.
- **A removal ships with its falsification line recorded in the removal issue**, so that if
  someone does ask where it went, the record shows what we predicted and was wrong.
- **Code verification is not falsification.** Proving the surface is broken proves it is
  broken; it predicts nothing about a user, which is the only thing calibration can score.

## What this skill does NOT do

- **It does not delete anything.** It produces a recommendation. The deletion is a separate
  branch, MR, and human decision
- **It does not authorize a removal on a score.** No average approves a deletion; a
  modeled panel cannot approve a deletion
- **It does not treat silence as consent.** Pre-beta, nobody complaining about a feature is
  not evidence it is unwanted — it is evidence we have no users yet, and it is recorded as E0
- **It does not treat external category evidence as corroboration** — same rule as
  `voice-of-customer`; grounding tiers move only in `.claude/persona-calibration.md`
- **It does not decide OSS vs Enterprise.** If removal is really a proposal to move a
  capability behind the Enterprise line, stop and run `enterprise-check` — that is a
  different decision with a different blast radius for an open-core product
- **It does not replace `voc-audit`.** If the question is "how do we improve this?", that is
  voc-audit. This skill is for when the question is whether it should exist

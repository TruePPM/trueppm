# Persona practice benchmark — how customer-led product orgs model users, and what `.claude/personas.md` should change

**Status:** recommendations only. This document does not edit `.claude/personas.md` or
`.claude/persona-calibration.md`. Written for issue #3000 (harden the VoC calibration
loop / falsifiability), part 6.

**Concurrency note (read first).** While this was being written, the owner of
`personas.md` independently landed a *"The internal-consistency test — a persona must
value what it does"* section carrying the same test I derived below, the same
Sarah/Priya/Marcus/Janet verdicts, and the same generalization ("a persona whose anchor is
only ever *the system did something impressive* will vote against better manual tools").
**Two agents reaching that test from different directions — one from the anchor
cross-read, one from a practice benchmark — is worth something, and I have left my
derivation in section 3 rather than deleting it, because the benchmark shows *why* the
test is the right one and not merely a patch for one bug.** What that edit does **not**
yet contain, and what is therefore the live value of this document:

- **R1 `Routine load`** — not present. Sarah's section is still unedited as of this
  writing.
- **R2 Part B** — the VoC skill's `Use ONLY` allowlist is **unchanged**, and this is now
  *more* urgent, not less: the new consistency test tells a reader to check the time
  budget, but the panel sub-agent is still forbidden to read it. The same is true of the
  new `.claude/house-data-profile.md` pre-read.
- **R3 drafted text** — the landed edit forward-references "the throughput criterion now
  in her section"; that criterion does not exist yet. Section 4 drafts it.
- **R4 David** — not addressed.
- Sections 5, 6 and 7 (rejects, the JTBD answer, what to protect) are entirely novel.

**Scope of the claim:** this is a benchmark of *documented* practice against our persona
model, plus a diagnosis of one observed misprediction. It is not user research, and
nothing in it may be quoted as customer feedback.

---

## 0. Executive summary

The document is good. Its weakness is not breadth — it is that **one whole category of
user behavior is absent from the fields the panel is allowed to read: routine, repeated,
high-volume labor.** Every persona is modeled as a set of *judgments* (criteria, filters,
dealbreakers) and none is modeled as a set of *motions*.

That absence has a precise mechanical trace, and it explains the observed failure:

1. Each persona carries a **Frequency & time budget** field. Sarah's says *"30–60 min
   daily working the plan"* — the largest hands-on daily figure in the roster.
2. That field is referenced by **nothing else in her definition**. Not a goal, not a pain
   point, not one of five evaluation criteria, not the one-question filter, not a hard NO,
   not the 10/10 anchor.
3. The VoC skill's sub-agent directive (`.claude/skills/voice-of-customer/SKILL.md:161`)
   says: *"Use ONLY this persona's goals, pain points, evaluation criteria, and hard
   NOs."* The time budget is **not on that list**. So the 30–60 minutes is not merely
   under-emphasized — it is formally outside the model's authorized inputs.
4. Asked how a PM should date 23 undated tasks, the Sarah model therefore reasoned from
   the only thing she is made of — defensibility — and chose the slow derivation-attached
   path. Six of eight other panelists, reasoning from personas whose anchors *do* describe
   hands-on work, predicted the fast path. They were right.

This was not a bad simulation. It was a faithful simulation of an incomplete model.

**Four changes, ranked. Everything else in this document is a considered rejection.**

| # | Change | Leverage | Cost |
|---|--------|----------|------|
| **R1** | Add a **`Routine load`** field to every persona: work volume, change rate, and the motion the incumbent tool uses today | Highest — supplies the missing decision input | ~2 lines × 11 personas |
| **R2** | Add the labor fields to the VoC skill's `Use ONLY` allowlist (the coherence invariant itself has already landed independently) | **Highest cost-adjusted** — one line; without it R1 and the newly-landed guidance are both unreachable by the panel | 1 line in `voice-of-customer/SKILL.md` |
| **R3** | **Fix Sarah**: 2 pain points, 1 evaluation criterion *at position 3*, 1 hard NO, rewritten anchor | High — the specific defect, drafted below | ~10 lines |
| **R4** | **Fix David narrowly**: routine-load line + 1 criterion + a second clause on his anchor. Keep his interception anchor | Moderate — same defect shape, much milder | ~4 lines |

**Personas 2 (Marcus), 3 (Priya) and 5 (Janet) are correctly modeled as receivers and
must not be touched.** Personas 6 (Alex), 7 (Jordan), 9 (Nadia), 10 (Omar), 11 (Bram)
already carry throughput anchors and are consistent. Persona 8 (Theo) is a throughput
anchor at his own timescale (seconds). Section 3 shows the test that decides each call.

**On JTBD: no.** See section 6 for the straight answer.

---

## 1. What respected product organizations actually do

Sources are marked **[primary]** (the company or author saying it in their own
publication), **[primary-adjacent]** (the practitioner quoted at length in an editorial
outlet), or **[folklore]** (widely repeated, no primary source located).

**This section went through a second verification pass, and the pass changed four claims**
— the Intercom job-story attribution, two attributions wrongly given to David Bland, the
Cooper paraphrase (§1.7, the most consequential), and the assertion that Stripe publishes
no user model (§1.8b — it does). Corrections are marked inline rather than silently
patched, because the wrong versions are the ones in general circulation and a future
reader will meet them again. A consolidated folklore ledger is at §9.

### 1.1 Superhuman — the most relevant precedent we have

Rahul Vohra's product/market-fit engine is the closest published analogue to what
`personas.md` is trying to be: a *predictive* customer model with a scoring loop attached.
**[primary-adjacent]** — Vohra's own account, published by First Round Review.

Four survey questions, the first being *"How would you feel if you could no longer use
Superhuman?"* (sent ~21 days into a user's life) with a 40% "very disappointed"
threshold, attributed to Sean Ellis benchmarking ~100 startups. **Cite this as *Vohra
citing Ellis*** — Ellis's own 2009 post is not retrievable (403 on every route, and
archive.org was unavailable), so the number is well-attested but not verified against its
own source. Superhuman moved 22% → 58% by splitting the roadmap: half on
what the "very disappointed" cohort already loved, half on the specific objections of the
"somewhat disappointed" cohort *who named speed as the main benefit*. The rest were
disregarded: *"Politely disregard those who would not be disappointed without your
product… Don't act on their feedback — it will lead you astray."*

**The part that matters for us is the HXC profile, and it is not the part usually
quoted.** Superhuman's high-expectation customer, built on Julie Supan's framework, reads:

> "Nicole is a hard-working professional who deals with many people… often works into the
> weekend… much of her work day in her inbox, **reading 100–200 emails and sending 15–40
> on a typical day**… aims to get to Inbox Zero, but **gets there at most two or three
> times a week**…"

Two of the six clauses are **quantified work volume and completion rate**. Not time spent
— volume of objects handled and how often the pile actually clears. That is the field
`personas.md` does not have, and it is exactly the field that would have told the Sarah
model that 23 undated tasks is a Tuesday, not an event.

Note the discipline: those numbers came out of survey segmentation of real users. Ours
would be modeled (T0). That is fine and the document already has the machinery to label
it — but see section 5 on why we should *not* copy the HXC designation itself yet.

- https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/
- https://review.firstround.com/what-i-learned-from-developing-branding-for-airbnb-dropbox-and-thumbtack/ (Supan on the HXC) **[primary-adjacent]**

### 1.2 Intercom — JTBD and the case against personas

**[primary]** Paul Adams, *How we accidentally invented Job Stories* (2016-06-28):
*"Personas artificially limit your product's audience because they focus on attributes
rather than motivations and outcomes. Designing for motivations and outcomes is far better
than designing for attributes. This is the key difference between Personas and JTBD."*
Des Traynor, five years earlier (2011, slug `when-personas-fail-you`), mocking persona
attributes as *"16-55, college-educated, good sense of humour, and other useless
criteria"*, and giving the reason Intercom switched: *"We couldn't find any useful
commonalities amongst the people, but we could find plenty of useful commonalities amongst
the tasks… the customer isn't the fundamental unit of analysis."*

**Job story attribution, corrected.** The format originated *at Intercom*; Klement named
and popularized it. Adams, in the post above: *"It didn't have that name at the time (Alan
Klement later named it for us)."* Klement then wrote the canonical explainer on Intercom's
own blog.

> ⚠️ The widely-circulated "Karen the 35-year-old marketer" caricature **is not traceable
> to any Intercom source.** Do not attribute a named-and-aged persona joke to them. The
> citable formulation is *attributes vs. motivations*.

**This critique does not bite on `personas.md`.** The document is already motivation-first:
Goals, Pain points, "What would make her switch", a one-question filter, and hard NOs.
There is almost no demographic content doing work — age and tech comfort appear and are
inert. Intercom's target is the "Karen, 35, marketing manager, likes yoga" persona. We do
not have one.

- https://www.intercom.com/blog/using-job-stories-design-features-ui-ux/
- *Intercom on Jobs-to-be-Done*, Traynor / Adams / Keating

### 1.3 Bob Moesta & Chris Spiek — forces of progress, switch interviews

**[primary]** jobstobedone.org (the Re-Wired Group's own publication). Four forces:
**push** of the current situation, **pull** of the new solution, **anxiety** about the new
solution, **habit of the present**. A switch happens only when *push + pull > anxiety +
habit*. The switch interview reconstructs the timeline back to the "first thought" moment
— the specific event that made someone start looking.

Mapped against our document:

| Force | Where it already lives in `personas.md` | Gap? |
|---|---|---|
| Push | **Pain points** | Covered |
| Pull | **What would make her switch tools** | Covered |
| Anxiety | **Hard NOs** (as dealbreakers rather than fears) | Covered in effect |
| **Habit of the present** | **Nowhere** | **This is the gap** |

Three of four forces are already present under other names. The fourth — what the persona
physically does today, in what motion, with what tool — is absent from all eleven
personas. This is the same hole R1 fills, arrived at from a completely different
direction, which is the main reason I am confident R1 is the right change.

- https://jobstobedone.org/the-four-forces/
- https://jobstobedone.org/radio/unpacking-the-progress-making-forces-diagram/
- Ryan Singer (Basecamp) on tipping moments: https://jobstobedone.org/radio/ryan-singer-jtbd-radio/ **[primary]**

### 1.4 Teresa Torres — continuous discovery

**[primary]** producttalk.org + *Continuous Discovery Habits*. Opportunity solution trees
connect one outcome → opportunities → solutions → assumption tests. Five assumption
classes (desirability, viability, feasibility, usability, ethical). Weekly touchpoints
with customers. Story-based interviewing: ask for a **specific past instance**, never a
generality, because generalities are self-report and self-report is unreliable.

The story-based-interviewing principle is the transferable one and we partially have it:
the 10/10 anchors *are* specific scenarios rather than generalities. The OST itself is
rejected (section 5).

- https://www.producttalk.org/opportunity-solution-trees/

### 1.5 David Bland — assumption mapping (and two attributions that are *not* his)

**[primary-adjacent]** Strategyzer / Maven / *Testing Business Ideas*. Plot assumptions on
a 2×2 of **importance** vs **evidence**; test the important-but-unevidenced cell first.

Two corrections, because both errors are near-universal in secondary write-ups and I made
one of them in an earlier draft:

- **"Leap of faith assumptions" is Eric Ries's** (*The Lean Startup*, 2011), not Bland's.
  Bland's own published diagram labels that cell **"Experiment."**
- **The riskiest assumption test (RAT) is Rik Higham's** — then a PM at Skyscanner —
  *"The MVP is dead. Long live the RAT"* (HackerNoon, 2016-09-27), not Bland's. They are
  not rival brandings of one idea: Higham's RAT is a polemic against the *term* MVP;
  Bland's mapping is the prioritization instrument that supplies the input RAT
  presupposes. They compose.
- If you ever reproduce Bland's 2×2: his published orientation runs **"Have Evidence" on
  the left**, so the target cell is *top-right*. Many third-party renderings silently flip
  the axis and then name the wrong quadrant.

Our falsification-line rule is a *better-targeted* version of this and should not be
replaced by it — see section 7. The one thing worth stealing is an **owner and a date**
per falsification line, which is a calibration-ledger change and belongs to whoever owns
that half of #3000, not to `personas.md`.

- https://www.strategyzer.com/library/how-assumptions-mapping-can-focus-your-teams-on-running-experiments-that-matter

### 1.6 Linear

**[primary]** linear.app/method. Two principles are on point. *Build with users*: seek
feedback but keep a coherent vision, and specifically **do not over-index on feedback from
users outside your target market** — *"will likely set you on the wrong path."* *Write
issues not user stories*: user stories are called an anti-pattern and *"a cargo cult
ritual."*

Linear does not publish a persona practice, and its "build for people like us" posture is
**not transferable** — its users are engineers like its builders. Ours are PMO directors,
resource managers and PMs answering to a governance forum. The one transferable rule
(don't build for out-of-market feedback) we already implement, and better: the
anti-persona section names the excluded users *and types the reason* ("a market-fit
failure, not a feature gap").

Worth noting as market context rather than method: Linear's public identity is
keyboard-first bulk efficiency — *"nearly every action has a keyboard shortcut"*
**[folklore/reviews, not Linear's own words]**. Alex and Jordan are modeled as daily Linear
users. A persona set that models Linear users but has no vocabulary for bulk efficiency is
internally inconsistent.

- https://linear.app/method/build-with-users
- https://linear.app/method/write-issues-not-user-stories

### 1.7 Alan Cooper — and the finding that reframes this whole document

**[secondary — Cooper's primary texts could not be retrieved.** cooper.com is now part of
Designit and "The Origin of Personas" does not load; `About Face` is not fetchable. Treat
everything here as directional, not quotable.**]**

Cooper's personas are **goal-directed**: users are grouped by "goals, tasks, and skill
levels", and the organizing question is *"what is their desirable end-state?"* His user
taxonomy is beginner / **perpetual intermediate** / expert, with the design implication
that a balanced UI serves the intermediate while giving beginners a path up and experts
accelerators.

**An earlier draft of this document said Cooper's method "has always held that a complete
persona model needs an efficiency dimension." That was wrong, and the correction is the
most important sourcing result in this section:**

> **Classical persona practice does not model frequency or volume of work at all.** The
> organizing axis is *goals*, which are stative — a desired end-state has no natural slot
> for "how many times a day." Where quantity enters Cooper's scheme it enters as **skill
> level**, which is a proxy for accumulated exposure, not a measure of throughput. The
> accelerator guidance lives in his *interface* advice, not in his *persona* model.
> Cooper's "day in the life" material is narrative color for empathy, not workload
> measurement.

The consequence, stated plainly: **a perpetual intermediate who does something 400 times a
day and one who does it 4 times a day are the same persona under Cooper's scheme, and they
need different products.** That is exactly the collision we hit — and it means R1 is not
"catch up to standard practice." See §2.1.

### 1.8 NN/g

**[primary-adjacent]** NN/g's persona components explicitly include *"the voluntariness of
use, frequency of use, and preferred device"*, and recommend a short day-in-the-life
narrative. So **frequency of use is standard practice, and we have it** — the `Frequency &
time budget` field. Our defect is not that the field is missing. It is that the field is
inert: nothing else in the persona references it, and the panel is not told to read it.

- https://www.nngroup.com/videos/personas-101/

### 1.8b Stripe — one real documented user model, and it is a disposition split

**Correction to an earlier draft of this document, which said Stripe publishes nothing.**
Stripe has exactly one named, published user model, and it is worth knowing about:
Michelle Bu (Stripe's API design lead), in Stripe-owned *Increment* — **[primary]** —
splits a single role into two archetypes by **disposition**, not by title:

> *"The eager developer chooses convenient APIs that are easy to understand and fast to
> integrate."* / *"The discerning developer chooses reliable, expressive, customizable
> APIs that will serve their needs as they iterate."*

Also primary and on point, from Stripe's account of designing the payments API: *"One of
our primary design tools was writing hypothetical integration guides to validate our
concepts."*

**Why this matters to us and why it still does not change the recommendations.** It is a
published precedent for splitting one role by *how the person wants to work* rather than
by who they are — which is the same move R1 makes on the doing/receiving axis. Our Nadia
(discerning: wants a stable contract to build against for years) and Bram (eager: wants
the DAG out in ten minutes) already sit at the two poles, correctly and without needing
this vocabulary. **Do not import the eager/discerning labels.** Noted so nobody re-proposes
Stripe as an unexploited source.

- https://increment.com/apis/api-design-for-eager-discerning-developers/
- https://stripe.dev/blog/payment-api-design

### 1.9 What could not be sourced, and one thing that is not what people think

- **Figma** — no published user-modeling *method* exists. The only hard, primary user model
  is a regulatory filing: the Form S-1 states that non-designers *"made up two-thirds of
  our more than 13 million monthly active users"* and that developers are ~30%. Their
  documented build trigger is **observed emergent usage** (FigJam and Figma Slides both
  described in the S-1 as growing out of what users were already doing), not modeling. The
  persona and JTBD **templates** on figma.com are FigJam content marketing aimed at
  customers — routinely miscited as evidence of Figma's own practice.
- **Basecamp has no documented anti-persona stance.** What exists is "scratch your own
  itch" (*Getting Real*), which is a different claim: you don't need a user model because
  you *are* the user. Do not launder one into the other. And **Shape Up disclaims this
  territory in its own text** — *"This book isn't about the risk of building the wrong
  thing… Improving your discovery process should come after regaining your ability to
  ship."* Ryan Singer's JTBD work is real but largely post-Basecamp personal writing; it is
  not "Basecamp's method."
- **Amazon working backwards / PR-FAQ** — real and documented (Vogels 2006; Bryar & Carr),
  but it is a *proposal format*, not a user model: the PR/FAQ is generated per initiative
  and discarded, and **nothing in it requires that the described customer was ever spoken
  to.** Adversarial pressure comes from colleagues, not users, so a beautifully written
  PR/FAQ about a customer nobody has met passes cleanly. Excluded as a category error.
  (The one line worth borrowing is Bryar & Carr's, and we already implement it via the
  anti-personas: *"If you think your product is for everyone, you are mistaken."*)

An industry claim I *did* find and am deliberately **not** relying on: a 2026 vendor report
asserting that duplicate data entry and cumbersome reporting drive users into "shadow
systems" where the official platform becomes a reporting destination while real work
continues in spreadsheets. It is directionally consistent with everything here and it is a
single secondary source, so per the document's own rule no conclusion below rests on it.

---

## 2. Where `personas.md` sits against that benchmark

| Practice | Status |
|---|---|
| Motivation-first, not demographic (Intercom's critique) | **Already ahead** |
| Frequency of use recorded (NN/g) | **Present but inert** — the defect |
| Specific scenarios not generalities (Torres) | **Present** — the 10/10 anchors |
| Anti-personas / don't build for out-of-market (Linear, Vohra) | **Ahead** — typed reasons + a carve-out |
| Falsifiable claims (Bland, Torres) | **Ahead** — per-finding, not per-project |
| Eviction path for a model that stops predicting | **Ahead** — almost nobody has this |
| Survivorship bias named | **Ahead** — Superhuman's engine has this flaw and does not name it |
| **Quantified work volume / completion rate (Supan/Vohra HXC)** | **Missing** |
| **Habit of the present — the incumbent motion (Moesta)** | **Missing** |
| **Expert/efficiency dimension (Cooper)** | **Missing** |

The last three rows are one hole seen from three angles.

### 2.1 Honest reframe: this is not catching up to standard practice

The Cooper correction in §1.7 changes what R1 is claiming, and the claim should be made
accurately rather than flatteringly.

**Frequency of use is standard.** NN/g lists it among the six normal persona components,
and we already have it — the `Frequency & time budget` field. Our failure there is
narrow and fixable: the field exists and nothing reads it.

**Quantified work volume is not standard.** Across Cooper, Nielsen, Shneiderman and the
HCI novice/expert literature, the documented axis is always **skill**, never **volume**.
Nielsen's *efficiency* usability component is speed-per-task for a trained user;
Shneiderman's universal-usability rule is about serving novices and experts in one
interface; Cooper's perpetual intermediate is a classification, not a rate. **None of them
is a throughput model.** The one published persona that carries volume explicitly is
Superhuman's HXC ("100–200 emails… 15–40 sent"), and it is an outlier derived from a
survey instrument rather than from persona methodology.

So R1 is a **deliberate extension past the canon**, not a gap-fill. Three consequences,
all of which argue for doing it anyway:

1. It is the right call regardless of precedent. TruePPM's product *is* plan maintenance
   at volume; a persona set for it that cannot express volume is missing its subject.
2. Being ahead of the canon means **nobody has debugged this for us.** Expect the first
   two or three `Routine load` lines to be wrong in ways only a real beta plan will reveal
   — which is an argument for the modeled-magnitudes caveat in §4, not against the field.
3. It should be recorded as an **extension** in `personas.md` itself, so a future reader
   does not assume it came from an established method and go looking for the literature
   that would justify it. There isn't any.

---

## 3. The test that decides which personas are wrong

Adopt this as the standing rule, because it generalizes to the next persona added and a
one-off Sarah fix does not:

> **Time-budget coherence.** Every persona states a `Frequency & time budget`. At least
> one **top-3 evaluation criterion** and the **10/10 anchor** must describe the work that
> budget actually pays for. A persona whose criteria and anchor are silent on its own
> largest time block is not modeling a user — it is modeling an opinion that user holds.

Applying it to all eleven:

| # | Persona | Stated budget | Criteria/anchor reference it? | Verdict |
|---|---|---|---|---|
| 1 | **Sarah** | **30–60 min daily working the plan** + longer weekly session | **Weekly session only. The daily hour is referenced by nothing.** | **🔴 Fix — R3** |
| 2 | Marcus | 5–10 min daily scan; monthly 2-day Excel ritual | Yes. Anchor kills the Excel ritual, which *is* his hands-on labor | ✅ Correct — leave |
| 3 | Priya | 15–30 sec/day; **hard ceiling 2 min/day** | Yes. "Never opens TruePPM" is a faithful restatement of the ceiling, not an aspiration | ✅ Correct — leave |
| 4 | **David** | 15 min daily + **1–2 hr weekly capacity planning** | Partially. The weekly planning hour is unrepresented | 🟡 Narrow fix — R4 |
| 5 | Janet | 30–60 sec, 1–2×/week, never in the tool | Yes. A digest anchor is the only coherent anchor for a 60-second budget | ✅ Correct — leave |
| 6 | Alex | 30 min 2× weekly + 1–2 hr biweekly ceremonies | Yes — "45 minutes instead of 2 hours" | ✅ Correct |
| 7 | Jordan | 30 min daily + 2 hr biweekly | Yes — "Sprint Planning takes 60 minutes" | ✅ Correct |
| 8 | Theo | Many short interactions daily, seconds each | Yes — a single query returning a citable answer *is* his throughput | ✅ Correct |
| 9 | Nadia | Intense 1–2 week build, then episodic | Yes — "ships the integration in an afternoon" | ✅ Correct |
| 10 | Omar | 5 min pre-install, then install windows | Yes — "under 30 minutes" | ✅ Correct |
| 11 | Bram | One 10–30 min evaluation session | Yes — "inside ten minutes" | ✅ Correct |

**Nine of eleven pass.** The document is not systematically broken; it has one stark
failure and one mild one. Fixing two personas for a stated reason is the right outcome —
do not rebalance the other nine for symmetry.

### Why Sarah in particular

She is the **most hands-on user in the roster** by her own stated budget, and she is
modeled entirely as a producer of an artifact somebody else reads. Every one of her five
criteria, her one-question filter (*"When this date moves, can I show why?"*), four of her
five hard NOs, and her anchor concern defensibility. Defensibility is real and belongs.
But a model made only of defensibility, asked a throughput question, will answer with
defensibility — which is exactly what happened.

### Why the *position* of the new criterion is not editorial

The rubric gives evaluation criteria beyond #3 almost no mechanical force:

- `10` requires *"every in-scope **top-3** criterion met"*
- `🔴 Blocker` fires on *"an in-scope **top-3** evaluation criterion missed"*
- `4–5` is *"some criteria met, none of the in-scope top-3"*

A maintenance criterion appended at position 6 would be **theater** — present in the text,
inert in every score. It has to displace something. R3 puts it at **3**, pushing the
governance artifact to 4. Justification: the governance pack is weekly; the plan
maintenance is daily and is the larger block. This is a real change to how Sarah scores
and should be made deliberately, not silently.

---

## 4. The four recommendations, with drafted text

### R1 — Add a `Routine load` field to every persona

**What.** A new field, placed immediately after `Frequency & time budget` (they are
siblings: one is duration, the other is volume and motion). Three things, one or two
sentences:

1. **Corpus** — how many objects they are responsible for.
2. **Change rate** — how many of those change by hand in a normal week, and what the
   worst pile looks like.
3. **The incumbent motion** — how they do it today, in which tool. This is Moesta's
   *habit of the present*, and it is the clause that predicts behavior.

**Why it improves prediction.** It is the only field that would have answered the question
the panel actually got. "How should a PM date 23 undated tasks?" is unanswerable from
goals and dealbreakers; it is nearly trivial given "20–40 tasks change hands-on in a normal
week, and in MS Project she does this with multi-select and fill-down." It is also the
field Superhuman's HXC is half made of. And it absorbs the single JTBD force we are
missing without importing the framework (section 6).

**Cost.** ~2 lines × 11 personas. All T0, labeled as such — no tier claim is implied. The
honest risk is that eleven invented volume figures acquire false authority through
repetition; mitigate with one sentence in the field's introduction saying these are
modeled magnitudes whose only job is to set the *order of magnitude* of a motion, and that
the first real beta plan we see supersedes all of them.

**Drafted field for Sarah** (existing voice — declarative, specific, no hedging):

> **Routine load**: 3–5 concurrent projects, 150–400 tasks each. In a normal week 20–40 of
> those tasks change by hand — dates set, an owner assigned, percent-complete corrected, a
> phase resequenced. Two or three times a year a plan arrives wholesale from an MS Project
> import or a stakeholder's spreadsheet: 50–200 tasks, structure intact, **no dates on any
> of them**. She does this today in MS Project with multi-select, fill-down and a paste
> from Excel — her mental model of "an edit" is a **selection**, not a row.

### R2 — State the coherence invariant, and make the new fields reachable

**What (two parts).**

*Part A — in `personas.md`* — **already landed** by the file's owner as "The
internal-consistency test — a persona must value what it does". No action needed. One
optional sentence would strengthen it: *"A persona that fails this test is amended, not
re-scored — the panel was right about the model it was given."* That closes the remaining
ambiguity about whether a failed test invalidates the panel run (it does not; it
invalidates the persona).

*Part B — in `.claude/skills/voice-of-customer/SKILL.md`, line 161*, change:

```
Use ONLY this persona's goals, pain points, evaluation criteria, and hard NOs.
```

to:

```
Use ONLY this persona's goals, pain points, routine load, frequency & time budget,
evaluation criteria, and hard NOs.
```

**Why.** The directive is an **allowlist**, and a field not on it is not authorized input
no matter what else is pasted into the sub-agent's context. This one line is the cheapest
item in this document and probably the highest-yield: it is the actual mechanism by which
the 30–60 minutes was excluded from the run that mispredicted.

**This is now the most urgent item, not the least.** `personas.md` has just gained a
consistency test instructing a *reader* to check the time budget, and a `house-data-profile`
declared as required pre-reading for plan-shape questions. Neither is reachable by a panel
sub-agent under the current allowlist. Without Part B the document accumulates correct
guidance that the thing consuming it is told not to read — which is a worse state than
before, because the guidance now looks handled.

**Cost.** One paragraph and one line. **Different owner** — the skill file is not
`personas.md`; hand Part B to whoever owns the VoC skill in #3000.

**Second-order effect to accept knowingly:** widening the allowlist gives every persona
sub-agent more to reason from, which will make panels slightly more verbose and slightly
less crisply differentiated. Worth it.

### R3 — Fix Sarah

Drafted in the document's existing voice. Compare against her current pain points, which
are first-person and end on a cost ("It takes an hour I don't have").

**Add to Pain points** (two, placed after the "when a task slips" line):

> - "Half a plan arrives with no dates on it — an import, a spreadsheet, someone else's
>   WBS. I set them one at a time, and it is an evening."
> - "Every tool makes the first edit beautiful and the twentieth edit identical to the
>   first. I don't have a hard problem. I have the same easy problem forty times."

**Add to "What would make her switch tools"** (one):

> - One motion that applies the same change to everything she has selected, with the
>   engine reconciling the consequences once at the end rather than forty times

**Evaluation criteria — insert at 3, renumbering:**

> 1. Does it show me the critical path and exactly what happens downstream when something
>    slips?
> 2. Can I run phase gates and sprints in one plan without reconciling two tools?
> 3. **When I have the same edit to make forty times, is there one motion that does all
>    forty?**
> 4. Can I hand a steering committee or auditor a defensible artifact without a day of
>    assembly?
> 5. Will it run on infrastructure we control?
> 6. What does it cost per person?

**Add to Hard NOs** (one — recommended, with its justification stated so the owner can
decline it):

> - A plan she can only maintain one task at a time — no multi-select, no fill-down, no
>   import that lands with dates

*Justification for making this a hard NO rather than a pain point:* she is coming from MS
Project, which has all three. Losing them is a **regression against the incumbent**, and
regressions against the incumbent are the classic dealbreaker class. It is also cleanly
falsifiable ("no beta PM raises bulk editing unprompted in their first two weeks"), which
the rubric requires. Be aware it is a real change: a new hard NO can fire a `1` and a `🔴`
where the current model would have scored `6`.

**10/10 anchor — replacement.** Leads with the daily labor, keeps the governance moment,
which is genuinely top-3 and must not be lost:

> **10/10 anchor**: A 180-task plan lands from an MS Project import on Monday morning with
> no dates on any of it. She selects the lot, applies a working-day pattern in one motion,
> fixes the eleven tasks the engine flags as impossible, and is looking at a critical path
> forty minutes later instead of losing the evening. On Thursday a dependency slips; she
> sees the downstream cascade and the new P80 immediately, adjusts one gate, and the
> governance pack generates itself — with the derivation behind every changed date
> attached, so the first question from the room is answered before it is asked.

*Note on the shape:* the anchor now contains **both** modes, in time order, daily before
weekly. That is deliberate — Sarah is genuinely both, and an anchor that swapped
defensibility out for throughput would create the mirror-image defect in six months.

### R4 — Fix David narrowly, and keep his anchor's interception moment

**My view, since you asked for one:** David is a real but much milder instance of the same
shape, and the right fix is *additive*, not a replacement.

His anchor — the tool warning *"this puts her at 130% in March"* before a save — is **not**
a receiving-output anchor in the Janet sense. It is the moment his entire job succeeds:
the double-booking that did not happen. His one-question filter (*"Does this catch the
conflict before it's locked in?"*) agrees with it. That is coherent and should stay.

What is unrepresented is the **1–2 hr weekly capacity planning session**, and note that
his own pain points already name the labor — *"a spreadsheet I rebuild from scratch every
quarter"* — so the criteria and anchor are lagging content the persona already contains.
That makes this a cheap fix with low risk of inventing anything.

**Routine load** (drafted):

> **Routine load**: 22 engineers across 8–12 competing project demands. In a normal week
> he adjusts 15–30 individual allocations and re-reads the whole grid at least twice;
> each quarter he rebuilds a capacity forecast from scratch in a spreadsheet because the
> tool cannot hold it. Today the grid lives in Excel, and his motion is a fill-across over
> a row of weeks.

**Evaluation criteria — insert at 4** (not top-3: his top three are correct as they stand,
and I would rather add an honest 4th than displace a criterion that is genuinely more
decisive for him):

> 4. **Can I rebalance a week of allocations across twenty-two people in one pass, or do I
>    edit them one assignment at a time?**

Consequence, stated plainly: at position 4 this criterion has no force under the `10` /
`🔴` top-3 rules. That is the correct trade for David — it will shape his prose findings
without letting a bulk-edit gap fire a blocker on a resource manager whose actual
dealbreakers are partial allocation and pre-commit warning.

**Anchor — append one clause, do not replace:**

> **10/10 anchor**: A PM tries to assign Aisha 60% to a new project; the tool warns *"this
> puts her at 130% in March"* before the assignment is saved, and David doesn't find out
> from a burned-out engineer six weeks later. And on Friday his weekly rebalance —
> twenty-two people, four projects, a fortnight of weeks — is twenty minutes in one grid
> instead of two hours reconstructing last quarter's spreadsheet.

---

## 5. Considered and rejected

Listed so nobody re-proposes them without reading the reason.

1. **Job statements / job stories per persona** (*"When ___, I want to ___, so I can
   ___"*). **Reject.** See section 6.

2. **A full forces-of-progress block per persona.** **Reject.** Three of the four forces
   already exist under other names (section 1.3). Adding the block would restate Goals,
   Pain points and Hard NOs in a second grammar, cost ~150 lines across the roster, and
   add no new input to the panel. Take the one missing force as a line inside `Routine
   load` and refuse the rest.

3. **Opportunity solution trees (Torres).** **Reject outright.** An OST is a *discovery
   workspace* for a trio running weekly customer interviews toward one measurable outcome.
   `personas.md` is a *reference model* consumed by a simulated panel. An OST built from
   modeled opportunities would be a tree of guesses rendered with the visual authority of
   research — the precise failure mode this document already fights hardest. Revisit only
   once the calibration ledger has real cycles in it and there are real opportunities to
   hang on it.

4. **Assumption mapping 2×2 / riskiest assumption test (Bland).** **Reject as a persona-doc
   addition.** The `Every 🔴 must be falsifiable` rule already does the important work and
   does it *better targeted* — per finding, at the moment of the claim, rather than per
   project at a workshop. The one genuinely missing element is an **owner and a review
   date** on each falsification line, so unchecked lines cannot accumulate silently. That
   is a `persona-calibration.md` change; route it to whoever owns the ledger half of
   #3000.

5. **Designate a Superhuman-style HXC — one persona whose disappointment outranks the
   others.** **The strongest of the rejects, and rejected only for now.** The panel
   averages across eight personas, which structurally optimizes for breadth; Vohra's whole
   argument is the opposite (*"better to make something that a small number of people want
   a large amount"*). But Superhuman's HXC was **derived from survey segmentation of real
   users** — question 2 of the survey, on the grounds that *"happy users will almost always
   describe themselves."* Picking an HXC pre-beta from T0 composites would harden a guess
   into a strategy, and is exactly the manufactured corroboration the document forbids.
   Partial substitutes already exist: the Tier-1 market ranking, and the rule that one 🔴
   outweighs the average in every direction. **Put this at the top of the list for the
   first calibration cycle that has real data.**

6. **A "switch trigger / first-thought moment" line per persona** (Moesta's timeline).
   **Defer.** Genuinely absent and genuinely real — the document records *what would make
   her switch* (a capability list) but never *what happened on the day she started
   looking* (an event). Rejected for this pass on yield: it mostly informs go-to-market
   messaging and evaluation-path design, not feature prediction, and it would compete for
   attention with `Routine load`, which is strictly more predictive. Rank 5th; revisit
   after R1–R4 have been through a panel or two.

7. **Empathy maps / day-in-the-life narratives (NN/g's softer recommendation).**
   **Reject.** At 1140 lines the document is already at the edge of what a Sonnet
   sub-agent will actually weight. A narrative would deliver the same predictive content
   as `Routine load` at twenty times the length, and long prose is what sub-agents skim.

8. **More demographic or biographical texture.** **Reject.** This is precisely what
   Intercom, Indi Young and the modern critique attack, and the document has correctly
   avoided it. Age and tech comfort are already inert; do not add siblings.

9. **Linear's "we build with taste, not personas" posture.** **Reject as non-transferable.**
   Linear's users are engineers like its builders. Sarah, Marcus and David are not us. The
   transferable half of Linear's actual published principle — do not over-index on
   out-of-market feedback — we already implement more rigorously than they state it.

10. **Amazon working-backwards / PR-FAQ.** **Reject as a category error.** It is a proposal
    format, not a user model. Nothing to graft onto a persona file.

---

## 6. JTBD — the straight answer

**No. Do not add a job statement or a forces-of-progress block per persona. Adopt exactly
one force — habit of the present — as a single clause inside `Routine load`, and take
nothing else.**

The reasoning, in order:

1. **Three of the four forces are already present under other names**, which section 1.3
   tabulates. Pain points *are* push. "What would make her switch tools" *is* pull. Hard
   NOs *are* anxiety, expressed as dealbreakers. A forces block would give the panel the
   same information in a second grammar. Restating an input does not improve a prediction;
   it lengthens the prompt.

2. **A job statement written from domain knowledge is a Goals restatement, not a job.** The
   value of a job statement comes from the switch interview that produced it — a real
   person reconstructing a real timeline. Written at a desk it is grammar, not evidence,
   and this document's own T0 discipline would require labeling it modeled anyway. We
   would be adding eleven sentences whose entire claim to authority is a format we did not
   earn.

3. **Intercom's critique of personas does not apply to these personas.** Their target is
   the demographic persona that says who someone is and never why they act. This document
   is motivation-first already — goals, pains, a one-question filter, typed dealbreakers.
   Adopting the remedy for a disease we do not have is how a persona doc acquires the
   ceremony you asked me to keep out of it.

   **And the premise that JTBD replaces personas is not JTBD's own position.** From the
   sidebar of Christensen's HBR article itself: *"Jobs analysis doesn't require you to
   throw out the data and research you've already gathered. **Personas**, ethnographic
   research, focus groups, customer panels, competitive analysis, and so on can all be
   perfectly valid starting points for surfacing important insights."* His target is
   **correlational segmentation read as causal**, not personas as an artifact — the
   memorable line is about a man whose age, height and shoe size *"has caused him to go out
   and buy the New York Times."* The strong anti-persona position circulating under
   Christensen's name is a practitioner extrapolation; the only genuinely anti-persona
   passage in that article is quoted testimony from Des Traynor. So the question is not
   "personas or JTBD" — it is which JTBD parts add signal to a persona set that already
   works. Answer: one.

4. **The one force with no counterpart is habit of the present — and that is not a
   coincidence, it is the defect.** Habit is where routine labor lives: what you do today,
   by hand, in which tool, how many times. The document records the *outcome* of that
   labor ("takes an hour I don't have") and never the *motion*. Two independent lines of
   evidence converge on it — Superhuman's HXC is half quantified volume, and Moesta's
   fourth force is the incumbent behavior — and both land on the same missing line. So the
   correct move is surgical: take that one line, put it in `Routine load` (R1), and refuse
   the framework it came from.

**Test of whether this was right:** re-run the 23-undated-tasks question against a Sarah
carrying R1 + R3. If she still picks the slow path, `Routine load` did not do its job and
the fuller JTBD treatment deserves a second hearing. If she flips, the one clause was
sufficient and the other 150 lines would have been ceremony. Record the outcome in the
calibration ledger either way — it is the cheapest falsification test available for a
change to this document, and it costs one panel run.

---

## 7. What this document already does better than published practice — do not refactor it away

Seven things. Several are unusual enough that a well-meaning future edit toward
"standard persona practice" would be a regression.

1. **A falsification line required on every 🔴, written at the moment of the claim.**
   Assumption mapping and RAT ask a team to design experiments for a project's riskiest
   assumptions at a workshop. This document requires the disconfirming observation to be
   named *per finding*, inline, or the finding is demoted. That is a stricter and better
   targeted discipline than anything in Bland or Torres, and it is what makes the
   calibration ledger scoreable at all. **Do not replace it with a 2×2.**

2. **Anchors are datable episodes, not summaries.** The strongest cross-school principle
   in the whole benchmark is one that Torres and Moesta reach independently and without
   citing each other: **refuse the generality, demand one specific instance.** Torres —
   *"Keep the interview grounded in specific instances of past behavior"*, because *"when
   asked about our future behavior, we tend to answer based on what we know we should do.
   We are eternal optimists"*; ask *"tell me about the last time you watched Netflix"*, not
   *"tell me about your experience on Netflix"*. Moesta's switch interview is the same move
   from the other end — a forensic backward walk through **one** real purchase. Our 10/10
   anchors already have this shape: each is a single dated scenario ("a dependency slips on
   Monday"), not a summary of preferences. **Do not let anyone "tidy" the anchors into
   generalized capability statements** — that would convert the one element of this
   document with genuine methodological pedigree into a feature list.

3. **Bidirectional grounding tiers with a written eviction rule** — "no hits across three
   consecutive calibration cycles → demoted, or retired if already T0." Every persona
   methodology I found has a promotion story (research makes a persona more real) and no
   retirement story. Cooper, NN/g and Supan are all silent on it. A roster that can only
   accrete stops modeling anything, and this document is the only one I encountered that
   says so.

4. **"The average never authorizes", and specifically "≥ 8 → treat with suspicion, not
   confidence."** This inverts the normal incentive of a scoring rubric. Superhuman's
   engine has the opposite property — 40% is a go signal — which is defensible when the
   number comes from real users and indefensible when it comes from a model restating its
   own brief. Naming that explicitly is rare and correct.

5. **Survivorship bias named in the ledger** — *"read every hit rate below as an upper
   bound."* Vohra's PMF survey has exactly this flaw (it can only reach people still using
   the product) and does not name it. We do, in the file where it would otherwise do the
   most damage.

6. **Anti-personas with a typed reason class and a carve-out.** "A market-fit failure, not
   a feature gap." "A persona-fit failure, not a feature gap." Plus the Stan/Bram carve-out
   that excludes a user from the platform while deliberately keeping the library funnel
   open. Most published anti-persona practice is a bare exclusion list; the typed reason is
   what stops a future reader re-litigating the exclusion from first principles.

7. **Conditional panelists and `N/A` for out-of-window criteria.** Janet is omitted from
   panels she cannot meaningfully judge; specialists join only on surface match; a criterion
   that is unmet because the capability is unbuilt is excluded from scoring rather than
   fired as a blocker. Both mechanisms separate *signal about the feature* from *noise
   about the roadmap*, and most scoring rubrics conflate the two until they are useless.

---

## 8. Sequencing

1. **R2 Part B** (one line in the VoC skill's allowlist) — do this first; everything else
   is inert without it.
2. **R1** — `Routine load` on all eleven, plus the modeled-magnitudes caveat.
3. **R3** — Sarah, including the criteria renumbering. Say in the edit that criterion 3
   displaced the governance artifact to 4 and why.
4. **R4** — David, additive only.
5. **R2 Part A** — already landed. Optionally append the one clarifying sentence in §4,
   and once R1/R3/R4 are in, re-read the landed test's forward reference ("the throughput
   criterion now in her section") to confirm it now points at something real.
6. Re-run the 23-undated-tasks question (section 6) and record the result in
   `persona-calibration.md` as the falsification test for this whole change.

---

## 9. Folklore ledger — claims that circulate widely and do not survive checking

Recorded because several of these were load-bearing in an earlier draft of this document,
and because anyone who re-researches this topic will meet them again. Anything asserted
about how a named company works should clear this bar before it is cited in an ADR, an
issue, or `personas.md`.

| Circulating claim | Verdict | What is actually true |
|---|---|---|
| Christensen says personas are useless | **False** | His own sidebar: *"Personas… can all be perfectly valid starting points."* The target is correlational segmentation |
| JTBD replaces personas | **Not JTBD's position** | See above. The only anti-persona passage in the HBR article is quoted Intercom testimony |
| Intercom mocks "Karen the 35-year-old marketer" | **Untraceable** | Their published examples are *"16-55, college-educated…"* and *"attributes that don't acknowledge causality"* |
| Alan Klement invented the job story | **Half true** | Format originated at Intercom (Adams); Klement *named* it — *"Alan Klement later named it for us"* |
| Moesta's fourth force is "allegiance to the current behavior" | **Folklore** | He says **"habit of the present."** His own site is also inconsistent on force 3 ("anxiety of the unknown" vs "of the new solution") — there is no canonical four-word list |
| David Bland coined "leap of faith assumptions" | **False** | Eric Ries, *The Lean Startup* (2011). Bland's own diagram labels that cell "Experiment" |
| David Bland coined the riskiest assumption test | **False** | Rik Higham (Skyscanner), HackerNoon, 2016-09-27 |
| Bland's evidence axis runs low→high, left to right | **False** | "Have Evidence" is on the **left**; the target cell is top-**right**. Third-party renderings flip it and then name the wrong quadrant |
| Basecamp has an anti-persona stance | **Undocumented** | "Scratch your own itch" is a different claim: you don't need a user model because you *are* the user |
| Shape Up is a discovery / user-research method | **Self-refuted** | *"This book isn't about the risk of building the wrong thing."* It points at Christensen for that half |
| Figma's persona/JTBD templates show Figma's method | **Conflation** | FigJam content marketing aimed at customers |
| Stripe publishes no user model | **False** — *this document said so in an earlier draft* | Michelle Bu's eager / discerning developer archetypes, Stripe-owned *Increment* |
| Stripe's docs philosophy is documented by Stripe | **False** | Every articulation located is written *about* Stripe by outsiders |
| The "Collison installation" is Stripe's own account | **False** | Paul Graham, *Do Things That Don't Scale* (2013) |
| Cooper's persona method covers task frequency/volume | **False** | The axis is goals and skill level. There is no throughput dimension anywhere in the canon — see §2.1 |
| Shneiderman rule 2 is "enable frequent users to use shortcuts" | **Outdated edition** | Current text on his own page: *"Seek universal usability."* Both are his; say which edition |
| "Expert blind spot" is an HCI/UX term | **False** | Education research (Nathan & Koedinger). "Curse of knowledge" is Camerer/Loewenstein/Weber 1989 |
| Bezos: customers are "beautifully, wonderfully dissatisfied" | **Unverified** | The verified 2017 phrasing is **"divinely discontent"** |
| The milkshake study is in the Sept 2016 HBR article | **False** | Zero occurrences in the reprint. It is in HBS note 9-611-004 and *Competing Against Luck*; the HBR spine is the Detroit condominium story |

**Sources that could not be opened**, listed so nobody assumes they were checked: Sean
Ellis's "The Startup Pyramid" (403); Moesta's own "The 6 Stages of Making a Purchase"
(403 — the best primary citation for the six-stage timeline, unread); Higham's RAT article
(403 on both hosts, so that quote is search-index text and is the lowest-confidence item
here); Cooper's "The Origin of Personas" (dead host); Indi Young's "Describing Personas"
(403); **Kathy Sierra's entire primary corpus** (seriouspony.com sold, the *Creating
Passionate Users* archive parked — do not put quotation marks around anything attributed
to her); and the interiors of *Competing Against Luck*, *Testing Business Ideas*,
*Continuous Discovery Habits*, *About Face* and *Badass*. archive.org was unavailable
throughout, which is why several of these could not be recovered.

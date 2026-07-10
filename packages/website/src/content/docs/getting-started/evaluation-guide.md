---
title: Evaluation guide
description: Verify every 0.3 capability in about 30 minutes using the bundled sample programs — which sample, which login, which screen, and what to expect.
---

:::note[Added in 0.3]
This guide covers the 0.3 feature set, available since the `0.3.0-alpha.1`
pre-release (Jun 28, 2026). See the [roadmap](/overview/roadmap/).
:::

This page is for someone evaluating TruePPM — or a reviewer doing a release
walkthrough — who wants to confirm each capability works without first learning
where everything lives. It maps every 0.3 capability to a **bundled sample**, a
**persona login**, the **exact screen** to open, and **what you should see**.

The fastest way through it: load a sample, sign in as the named persona, open the
screen, and check the expectation. Every sample imports as a **program already in
flight** — its history is replayed with backdated, attributed events, so you are
reviewing a program that has run for months, not a blank slate.

## Coming in 0.4 (preview)

:::note[Forward-looking — lands with the 0.4 tag]
0.4 is TruePPM's first beta and is still **Underway** (target Jul 27 – Aug 3,
2026) — see the [roadmap](/overview/roadmap/). The three capabilities below are
**not shipped yet**; they land with the 0.4 tag. Everything in the checklist
further down is verifiable **today** on 0.3 — this section is a preview of what
the next revision of this guide will add.
:::

The 0.4 beta is the release that makes a TruePPM schedule *answerable* and
*evaluable without an install*. Three headliners will extend this walkthrough
when they ship:

| Ships in 0.4 | What you will verify once it tags |
|---|---|
| **Read-only MCP server** | Point any MCP client (Claude Desktop, Cursor, Zed) at your self-hosted instance and ask the live schedule real questions — critical path, sprint status, the risk register, and a **non-mutating Monte Carlo what-if** ("slip this task three days — when do we ship?"). Every answer is computed server-side by the same CPM/Monte Carlo engine the UI uses — never guessed by a model, never leaving your box. Read-only by design |
| **Read-only share links** | Mint a tokenized, expiring, revocable public link to a schedule or board view — read-only, rate-limited, and disableable workspace-wide — so a schedule can travel beyond its own instance without handing over a login |
| **Basic single sign-on (OIDC / OAuth2)** | Point TruePPM at your own identity provider (Keycloak, Authentik, Authelia, Zitadel, Google, GitHub, GitLab) and your whole team logs in through it — self-hosted, login-only, no paywall. Identity *governance* (SAML 2.0, SCIM, LDAP/AD directory sync) stays in the enterprise edition |

## Before you start

Load one or more of the four bundled samples. On a fresh install the **Programs**
page has a **Load demo data** button; or load from the command line:

```bash
docker compose exec api python manage.py load_sample_project --sample aurora-mobile-app --with-personas
docker compose exec api python manage.py load_sample_project --sample bayside-civic-center --with-personas
docker compose exec api python manage.py load_sample_project --sample helios-crm-replacement --with-personas
docker compose exec api python manage.py load_sample_project --with-personas                          # Atlas (default)
```

See [Sample projects & JSON import/export](/getting-started/sample-projects/) for
what each sample is built to demonstrate. Each persona account is namespaced
`<sample>-<name>` (for example `aurora-priya`, `bayside-sam`). The
`--with-personas` flag gives those accounts a usable login password and **prints
the persona usernames and the shared password** after loading — in local Docker
dev with `DEBUG` on, that password is `demo` (otherwise it is `$TRUEPPM_DEMO_PASSWORD`
if set, or a random token printed once). Without the flag the personas are
view-only and cannot sign in. You can also just use your own admin account: you
own every sample you load, so you already see everything the walkthroughs point
at. When you are done, the program owner can **Remove sample data** to tear a demo
down without touching real work.

:::tip
Pick the sample that matches the methodology you care about: **Aurora** for pure
agile, **Bayside** for waterfall/CPM, **Helios** for the small hybrid bridge, and
**Atlas** for the whole story at program scale.
:::

## What makes the demo data realistic

Most of what an evaluator distrusts about demo data is that it looks *staged* —
every task owned by one person, every status frozen, no trail of how the work got
there. The bundled samples are authored as **event timelines** instead, so the
history holds up to inspection:

- **Tasks change hands.** Work is reassigned for coverage (someone is out), for
  load-balancing (a teammate is overloaded), and to hand a task to the right
  specialist. Open any reassigned task's **History** and you see dated
  "reassigned from … to …" rows by name.
- **Work moves non-linearly.** A few "hero" tasks per program fail review and
  bounce back to In Progress before they ship — the path a real task takes, not a
  straight line to Done.
- **People talk.** Standup notes, blocker call-outs, handoff notes, and review
  feedback appear as dated comments by named personas.
- **Sprints have verdicts.** Closed sprints carry an honest goal outcome (Met /
  Partially met) and a real burndown curve, not a single fabricated number.
- **Risks have a life.** A risk's status walks Open → Mitigating →
  Resolved/Closed over time, tied to the tasks that drove it.
- **Scope is governed.** A mid-sprint injection is accepted in one program and
  rejected (deferred) in another, each recorded as a scope-change audit entry.

## Capability checklist

Each row is independently verifiable. "Look here" names the screen; "Expect"
is the signal that the capability works.

### Agile team (the 0.3 headline)

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| Sprint lifecycle & burndown | Aurora · `aurora-priya` | Sprint 1–2 (closed) → burndown | A real downward curve with day-by-day points, not a single number |
| Velocity trend with a range | Aurora · `aurora-priya` | Velocity chart | A 20 → 27 ramp across the closed sprints, with a forecast spread |
| Sprint goal verdict | Aurora · `aurora-priya` | Closed sprint header | Sprint 1 reads **Partially met** (20 of 26), Sprint 2 **Met** |
| Active sprint brackets "today" | Aurora · `aurora-priya` / Helios · `helios-jordan` | Active sprint board | The in-flight sprint straddles the current date, with work mid-column |
| Mid-sprint scope audit (accepted) | Aurora · `aurora-priya` | "Widget gallery" task → sprint scope chip | A goal-impacting injection accepted mid-sprint, recorded in the audit |
| Mid-sprint scope audit (rejected) | Helios · `helios-ivan` / `helios-jordan` | "Search & filters" task | An injection rejected and deferred — the task drops out of the sprint |

### Task history & collaboration (new in this guide)

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| Reassignment trail | every sample | A reassigned task → **History** | Dated "reassigned to …" rows by name (e.g. Aurora "Biometric login": Diego → Mei) |
| Non-linear "hero" task | every sample | The hero task → **History** | A Review → In Progress bounce, then Review → Done (Aurora "Onboarding flow"; Atlas "SSO login"; Bayside "Rebar & formwork") |
| Persona comments | every sample | A hero/handoff task → comments | Standup, blocker, handoff, and review-rework notes by named people, dated |
| Backdated, attributed history | every sample | Any completed task → **History** | "Moved to Done by … N days ago", not everything stamped "today" |

### Schedule (CPM) & forecasting

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| Critical path | Bayside · `bayside-sam` | Schedule view | A highlighted critical path through the construction phases |
| All four dependency types | Bayside · `bayside-sam` | Foundation/Finish-out links | FS, SS, FF, and SF links present (parallel pours, "finish together", SF on commissioning) |
| Three-point estimates | Bayside · `bayside-sam` | Any scheduled task | Optimistic / most-likely / pessimistic on the estimate |
| Baseline-vs-actual slip | Bayside · `bayside-sam` | Baseline overlay | Completed work compared against the captured **Contract baseline** |
| Monte Carlo P50/P80/P95 | Bayside · `bayside-sam` / Atlas · `atlas-alex` | Monte Carlo modal | Monotonic P50 ≤ P80 ≤ P95; toggling a high-impact risk shifts P80 |

### Risk register

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| Populated register | Bayside (12) · Atlas (20) | Risk register | A full register with a probability × impact matrix |
| Risk status lifecycle | every sample | A risk → **History** | Dated Open → Mitigating → Resolved/Closed (e.g. Bayside "soil conditions"; Atlas "SSO security finding") |
| Schedule-driving risks | Atlas · `atlas-alex` | Risk → Monte Carlo | Several high probability × impact risks that visibly move the forecast |

### Hybrid & program scale

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| The bridge demo | Helios · `helios-jordan` | Plan → build handoff | A completed waterfall plan feeding live build sprints across a cross-phase dependency |
| Hybrid rollup | Helios · `helios-jordan` / Atlas · `atlas-alex` | Program / project overview | Gated and flow work rolling up together under one parent |
| Cross-project critical path | Atlas · `atlas-alex` | Program schedule | Platform Core gates Migration, which gates the public-launch milestone |
| Methodology mix in one program | Atlas · `atlas-alex` | Three projects | Agile, waterfall, and hybrid streams side by side |

### Interface (v2)

| Capability | Sample · persona | Look here | Expect |
|---|---|---|---|
| Unified app-shell bar | any · any | Top bar + left rail | One 56-px bar: a `Program › Project` location switcher on the left and a pinned utility cluster (health, sync, notifications, user menu) on the right. **View switching lives in the left navigation rail**, not in top-bar tabs |
| Command palette | any · any | Press **⌘K** | Jump to backlog/board and search tasks inline |
| Role-based landing | any · sign in as different roles | Post-login screen | Each role lands on the surface it lives on (a Viewer lands read-only) |

## A 30-minute tour by persona

If you would rather follow one role end to end, pick the path that matches you.

### Scrum Master / agile delivery — ~10 min (Aurora)

1. Sign in as **`aurora-priya`**. Open the closed **Sprint 1** — read its
   **Partially met** verdict and its burndown curve.
2. Open the **Velocity** chart — note the 20 → 27 ramp and the forecast range.
3. Open the active sprint board. Find **"Onboarding flow"** and open its
   **History**: it went to Review, bounced back on a real defect, was reworked,
   and shipped — with Tom's review comments inline.
4. Find **"Widget gallery"** — a mid-sprint injection the PO pulled in and the
   team accepted, recorded in the scope audit.

### Project Manager / scheduler — ~10 min (Bayside)

1. Sign in as **`bayside-sam`**. Open the **Schedule** — follow the critical path and
   spot the four dependency types (the parallel pours and the "finish together"
   framing links).
2. Turn on the **Contract baseline** overlay — compare completed phases against
   plan.
3. Open the **Monte Carlo** modal — confirm P50 ≤ P80 ≤ P95, then toggle the
   **supply-chain** risk and watch P80 move.
4. Open the **soil-conditions** risk's **History** — Open → Mitigating → Closed
   as the geotech survey cleared it.

### Product Owner / hybrid lead — ~10 min (Helios, then Atlas)

1. In **Helios**, sign in as **`helios-jordan`**. See the finished waterfall **Planning**
   phase hand off to the live **Build** sprints across the cross-phase
   dependency.
2. Find **"Search & filters"** — an injection that was **rejected** mid-sprint
   and deferred, so it dropped back out of the sprint.
3. Open **Atlas** and sign in as **`atlas-alex`** (the program lead). Follow the cross-project critical path
   (Platform Core → Migration → public launch) and open the **SSO login** task's
   History to see a security-review bounce that became a tracked audit risk.

### Team member / contributor — ~5 min (Aurora)

1. Sign in as **`aurora-priya`**. Open the board (or **My Work**) and find your
   in-flight cards.
2. Move a card to the next column — the active sprint's **burndown** redraws
   immediately; you didn't touch anything else.
3. Open a "hero" task's **History** — your reassignments and a review bounce-back
   are there, dated and by name. This is what "your board moves are the status"
   looks like.

### Resource manager — ~5 min (any sample), with one honest caveat

Cross-project allocation and pre-commit conflict warnings are a **0.5**
capability — they are not here yet, and an honest evaluation should expect that.
What you *can* verify today is project-scoped:

1. Sign in to any sample and open the **resource roster** — every sample seeds
   realistic **capacity profiles** (full-time, part-time, and 10% advisors), not
   everyone at 100%, with a non-default working calendar on at least one person.
2. Open or activate a sprint and check **capacity preflight** — over-allocation
   within the project is flagged before the sprint starts.

See the [resource managers guide](/guides/resource-managers/) for what lands when.

### Executive sponsor — ~5 min (Atlas), no login of your own

You don't need to drive the tool. Have someone open **Atlas** and show you the
forecast.

1. Open the **Monte Carlo** modal on the flagship program — the answer is a
   **range with a confidence level** (P50 ≤ P80 ≤ P95), computed from the live
   plan, not a hand-built status slide.
2. Toggle a high-impact risk and watch **P80 move** — that's the difference
   between "we're on track" and "we're 80% likely by this date, and here's what
   would change it."

The portfolio dashboard and pushed weekly digest you'd want next are still
ahead — see the [executives guide](/guides/executives/).

### PMO director — ~5 min (Atlas)

Atlas is a **program** — three related projects under one team — which is exactly
the community-edition scope.

1. Open the **program view** and read the cross-project rollup: the public-launch
   milestone gated by Platform Core and Migration.
2. Follow the **cross-project critical path** across the three projects.

Portfolio governance *across many programs* (SSO, immutable audit, cross-program
leveling) is the enterprise layer — the
[PMO directors guide](/guides/pmo-directors/) draws the line.

### Agile coach — ~10 min (Aurora, then Helios)

Your evaluation is about autonomy, so check the artifacts that prove the sprint
belongs to the team:

1. In **Aurora**, sign in as **`aurora-priya`**. Open a closed sprint's **retrospective**
   and confirm a promoted action item carried into the next sprint's backlog —
   the pipeline is real, not a checkbox.
2. Find the mid-sprint scope injection that was **accepted** and recorded in the
   scope audit (not slipped in silently).
3. In **Helios**, find the injection that was **rejected** and deferred — the
   team's boundary held, with a record either way.
4. Note that **velocity stays team-private** unless the team opens the audience —
   it is not auto-published to a management view.

The full autonomy-vs-control contrast test (sign in as the team, then as
management) is in the [agile coaches guide](/guides/agile-coaches/).

## Where this data comes from

Every sample is generated from a committed builder
(`scripts/seeds/build_atlas_seed.py`, `scripts/seeds/build_samples.py`) and
replayed by the importer (ADR-0114). The event timeline — reassignments,
comments, status moves, scope changes, risk lifecycles — is authored in those
builders and reconstructed as backdated history on import. To author your own,
see the [seed data schema reference](/architecture/seed-data-schema/).

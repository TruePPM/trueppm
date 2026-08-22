# VoC falsification audit — every open `voc-audit` issue

**Date:** 2026-08-21 · **Issue:** #3000 (part 1) · **Scope:** all open issues in
`trueppm/trueppm` carrying the `voc-audit` label, fetched via
`GET /projects/trueppm%2Ftrueppm/issues?labels=voc-audit&state=opened` (2 pages, 122 issues).

## Why this audit exists

`.claude/persona-calibration.md` states the scoring rule plainly:

> Only findings that carried a **falsification line** can be scored — that is what the
> line is for. An unfalsifiable 🔴 is recorded as `unscoreable` and counts against the
> panel, not for it.

and `.claude/personas.md:264` defines what the line must be:

> **Every 🔴 must be falsifiable.** State, in one line, the real-world observation that
> would confirm or refute it — "no beta operator reports this in their first week",
> "three of five demo conversations raise it unprompted", "the metric shows nobody uses
> the fallback path".

The first real calibration pass is due after 0.4 reaches users. This audit measures how
much of the current pool that pass will actually be able to grade.

## Headline

| Classification | Count | % of pool |
|---|---:|---:|
| **scoreable** — carries an explicit falsification line stating a real-world observation | **3** | **2.5 %** |
| **partial** — carries a code verification/repro section, but no user-observable falsification condition | **45** | **36.9 %** |
| **unscoreable** — neither | **74** | **60.7 %** |
| **Total open `voc-audit` issues** | **122** | 100 % |

**97.5 % of the open `voc-audit` pool would grade `unscoreable` in a calibration pass run
today.** Only #2657, #2660 and #2661 carry a falsification line.

Under the ledger's own rule ("an unfalsifiable 🔴 … counts against the panel, not for it"),
the first calibration cycle would score 119 of 122 findings against the personas — which
is not a measurement of the persona model, it is a measurement of the issue template.

### Persona attribution

| | Count | % |
|---|---:|---:|
| Names the raising persona (proper name, e.g. "Raised by: Sarah (delivery manager)") | 103 | 84.4 % |
| Names a role lens only ("Executive Sponsor lens", "the Delivery Lead lens") | 11 | 9.0 % |
| **Total with per-persona attribution** | **114** | **93.4 %** |
| No persona attribution | 8 | 6.6 % |

Attribution is in good shape and is *not* the blocker. Seven of the eight unattributed
issues (#2900, #2901, #2902, #2907, #2910, #2915, #2922) are deliberately unattributed —
each carries the line *"Surfaced by **verification** … no persona raised it, and it must
not be attributed to one."* That is correct practice, not a gap. Only #268 is
unattributed by omission.

Raising-persona frequency across the pool (an issue can name several):

| Persona | Issues |
|---|---:|
| Sarah (Delivery/Program Manager) | 48 |
| Marcus (PMO Director) | 35 |
| Alex (Delivery Lead) | 34 |
| Priya (Team Member) | 28 |
| Jordan (Product Owner) | 26 |
| **Morgan (Agile Coach) — retired persona** | **21** |
| David (Resource Manager) | 10 |
| Janet (Executive Sponsor) | 8 |
| Nadia (Integration/API Developer) | 7 |
| Omar (Self-Hosting Operator) | 6 |
| Theo (AI-Native Technical Operator) | 5 |

**21 issues attribute findings to "Morgan (Agile Coach)", a persona that no longer exists
as an entry in `.claude/personas.md`.** Morgan was folded into Persona 6 (Alex Rivera) by
the 2026-07 revision — `personas.md:662-669` says his "hard NOs and criteria carry over
verbatim". A reweighting pass keyed on persona name will not resolve "Morgan" against the
current roster unless that alias is handled explicitly.

### Provenance blocks

30 of 122 issues (24.6 %) carry an explicit **Provenance** block naming the panel, the run
date, and the simulated-not-research caveat. A further 60 carry a looser `## Source` /
`Raised by` / `Filed from VoC audit on !NNN` attribution line, so **90 of 122 (73.8 %)**
have some structured provenance.

Provenance and falsifiability are uncorrelated: 28 of the 30 Provenance-block issues are
`partial`, and **none of the three scoreable issues carries a Provenance heading** — they
carry a `## Falsification` section instead. The Provenance block records *where the finding
came from*; nothing in the current template records *what would prove it wrong*.

## The structural finding: falsification was a one-panel practice

Broken down by the panel run that produced the issue, the falsification lines are not
thinly spread — they are entirely confined to one run.

| Panel cohort (date) | n | scoreable | partial | unscoreable |
|---|---:|---:|---:|---:|
| 0.4 pre-release /voc-audit sweep (2026-08-17) | 25 | 0 | 25 | 0 |
| /pre-release full audit (2026-08-16) | 2 | 0 | 2 | 0 |
| 0.4 VoC panel (2026-08-01) | 7 | 0 | 7 | 0 |
| Settings-surface /voc-audit panel (2026-07-31) | 4 | 3 | 1 | 0 |
| hybrid-bridge VoC panel (2026-07-30) | 2 | 0 | 2 | 0 |
| agile-methodology VoC panel (2026-07-28) | 2 | 0 | 0 | 2 |
| UX-flows / 0.4 beta wish-list panel (2026-07-26) | 12 | 0 | 6 | 6 |
| VoC audit (timesheet / board cards) (2026-07-14) | 3 | 0 | 0 | 3 |
| VoC (2026-07-11) | 1 | 0 | 1 | 0 |
| Build Mode VoC audit (2026-07-03) | 1 | 0 | 0 | 1 |
| v2 nav-chrome VoC audit (2026-07-02) | 7 | 0 | 0 | 7 |
| methodology view-tab VoC audit (2026-07-01) | 3 | 0 | 0 | 3 |
| 0.3 agile-overlay VoC audit (2026-06-25) | 6 | 0 | 0 | 6 |
| 0.3 agile-workflow VoC audit (2026-06-22) | 8 | 0 | 0 | 8 |
| MR !596 VoC audit (2026-06-13) | 1 | 0 | 0 | 1 |
| 0.3 release / contributor-retention VoC (2026-06-11) | 2 | 0 | 0 | 2 |
| 0.3 bridge/sprint VoC audit (2026-06-10) | 6 | 0 | 1 | 5 |
| roadmap-restructure VoC panel (2026-05-30) | 1 | 0 | 0 | 1 |
| #697 focused panel (2026-05-24) | 1 | 0 | 0 | 1 |
| SettingsShell VoC re-audit (2026-05-23) | 3 | 0 | 0 | 3 |
| Project Board VoC audit (2026-05-21) | 5 | 0 | 0 | 5 |
| MR !291/!297/!298/!302 VoC audits (2026-05-19) | 15 | 0 | 0 | 15 |
| unknown (undated) | 5 | 0 | 0 | 5 |

Three observations follow from that table.

1. **The Settings-surface panel of 2026-07-31 is the only run that ever wrote falsification
   lines**, and it wrote them on 3 of its 4 issues. Every other run — 21 of 22 cohorts,
   118 of 122 issues — wrote none.
2. **The practice did not survive the next run.** The 2026-07-31 cohort is followed by
   2026-08-01 (7 issues), 2026-08-16 (2), and 2026-08-17 (25) — 34 issues, zero
   falsification lines. Whatever produced the falsification sections was not carried into
   the template.
3. **Verification rigor rose while falsifiability went to zero.** The 2026-08-17 sweep is
   the most disciplined cohort in the pool by every other measure: 25/25 carry a
   Provenance block, 25/25 carry the "the panel is not evidence / all personas are T0"
   caveat, 25/25 cite `file:line` against `main` at `31311fb8b`, and seven of them
   explicitly record which persona claims verification *falsified*. It scores 0/25 on the
   one thing the calibration ledger grades.

That third point is the trap. A reader of #2914 or #2917 sees a Provenance block, a T0
disclaimer, a sha, and line-number citations, and concludes the finding is rigorously
sourced — and it is. But the ledger does not score "is the defect real"; it scores "did
the persona predict what a user would say". Code verification proves the first and is
silent on the second. **The 2026-08-17 cohort substituted verification for falsification,
and the substitution is invisible unless you are holding the calibration rule.**

A representative example, #2863, shows the substitution happening in as many words. It is
the only issue outside the 2026-07-31 cohort that uses the phrase "falsification line":

> **Falsification line, checked:** falsified if any role check in `TaskFormModal` or its
> caller suppresses or collapses the Classification group for MEMBER-and-below on create.
> `isReadOnly` (`:654`) and every render guard around the block (`:996`,
> `!isMilestoneCreate` only) were read — no such gate exists.

That is a well-formed falsification of a *claim about the code*, and it has already been
checked and closed. It predicts nothing about Priya. `/voc-audit` cannot score it in a
calibration pass, because there is no future observation left to make.

## What good looks like — the three scoreable issues, quoted

### #2657 — settings change history records field keys only

Three lines, one per raising persona, each naming a different real-world observer:

> ## Falsification
>
> - Marcus's: put an actual `workspace_settings_changed` payload in front of an assessor
>   sampling SOC 2 CC8.1 change-management evidence. If a key-only record is accepted, or
>   no self-hosting operator raises it in their first audit cycle, refuted.
> - Theo's: ask a beta operator to produce who disabled agent read access on a *program*,
>   and when, without shell access to Postgres. If they can, refuted.
> - Sarah's: refuted if in the first month of beta no PM asks who or when a settings value
>   changed.

This is the model. Per-persona falsification means a false alarm can be charged to the
persona that raised it — Sarah's line can be refuted while Marcus's holds, and the ledger
reweights only Sarah on that topic. A single issue-level line cannot do that.

### #2660 — no way to read a resolved configuration

> ## Falsification
>
> - Theo's: give a beta operator API access only and ask why agent reads are refused on a
>   named project. If they can identify the deciding scope from responses alone, the
>   `source` half is refuted.
> - Marcus's: ask three beta operators running 10+ projects to name every project
>   overriding a workspace default for one named field. If any answers in under five
>   minutes without scripting, the deviation-report half is refuted.
> - Omar's own caveat: he has no visibility into whether real self-hosters run more than
>   one environment. **If most run a single production instance, the export half is much
>   smaller than his staging-first instinct assumes.** Theo raised the mirror caveat: if
>   operators treat Helm values as the real source of record, the export gap is largely
>   theoretical.

Note the third bullet: it falsifies *scope*, not just existence, and records the panel's
own blind spot. That is the "what this panel could not see" open question the global
CLAUDE.md asks for, written where the calibration pass can find it.

### #2661 — a project/program token authenticates as the human who minted it

> ## Falsification (Nadia's)
>
> Revoke or offboard the user who minted a production project token. If the integration
> keeps working with unchanged permissions, the token is not really bound to them and the
> finding is overstated. If its access changes or it dies, a service credential is coupled
> to a human account.

Weaker than the other two, and worth naming why: this is a **system experiment**, not a
user observation. It is checkable — so it is scoreable — but it can be settled by an
engineer at a terminal without a user ever appearing. It confirms the defect, not the
persona. Prefer the #2657/#2660 form.

## The near misses — five issues that get close and stop one sentence short

These are the cheapest issues to fix, because the falsifiable claim is already written
down; it is just not written down as a falsification.

- **#2707** (Jira mirror polling default-off) states the criterion but never turns it into
  an observation: *"The contributor persona's **#1 stated evaluation criterion for this
  feature is 'syncs automatically'**"*. One sentence away from *"refuted if no beta
  contributor mentions staleness in their first two weeks of using the mirror."*
- **#2413** (Jira mirror has no freshness signal) quotes Priya's one-question filter —
  *"does this remove a click from my day, or add one?"* — which is a directly observable
  test, stated as motivation rather than as a check.
- **#2416** (Day-1 operator checklist) quotes Omar: *"My whole persona is scored on
  'healthy in the first 30 minutes' — the content clears that bar, the *navigation* of it
  doesn't yet."* The 30-minute bar is a stopwatch-checkable claim about a real operator.
- **#2645** (velocity sampler horizon drift) does the honest half — *"The panel scored it
  as a triggered hard NO; on verification the practical impact is materially lower than the
  panel assessed, and this issue is filed at the reduced severity rather than the panel's.
  No real user reported it."* — recording a panel overcall, but leaves nothing for the next
  cycle to check.
- **#2644** (N-sprint milestone aggregation) explicitly records the panel's blind spot —
  *"the PMO and Delivery Lead panelists both listed the multi-feeder case under 'what I
  could not see'"* — which is exactly the material a falsification line is made from.

## Full issue table

`Class`: **scoreable** = explicit falsification line stating a real-world observation ·
**partial** = verification/repro against code, no user-observable falsification ·
**unscoreable** = neither.

| Issue | Class | Persona named | Note |
|---|---|---|---|
| #2922 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verification prose against the tree (no line cites); no user-observable falsification condition. |
| #2921 | partial | y (Priya, Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2920 | partial | y (Janet, Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (3 file:line citations); no user-observable falsification condition. |
| #2919 | partial | y (David) | 0.4 pre-release /voc-audit sweep — Verified against code (6 file:line citations); no user-observable falsification condition. |
| #2918 | partial | y (Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2917 | partial | y (Jordan, Priya) | 0.4 pre-release /voc-audit sweep — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2916 | partial | y (Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (6 file:line citations); no user-observable falsification condition. |
| #2915 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (3 file:line citations); no user-observable falsification condition. |
| #2914 | partial | y (Alex, Jordan) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2913 | partial | y (Priya) | 0.4 pre-release /voc-audit sweep — Verified against code (4 file:line citations); no user-observable falsification condition. |
| #2912 | partial | y (Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2911 | partial | y (Marcus) | 0.4 pre-release /voc-audit sweep — Verified against code (10 file:line citations); no user-observable falsification condition. |
| #2910 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2908 | partial | y (Alex, Marcus, Omar, Sarah) | 0.4 pre-release /voc-audit sweep — Verification prose against the tree (no line cites); no user-observable falsification condition. |
| #2907 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2906 | partial | y (Jordan) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2905 | partial | y (David) | 0.4 pre-release /voc-audit sweep — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2904 | partial | y (Alex, Priya) | 0.4 pre-release /voc-audit sweep — Verified against code (3 file:line citations); no user-observable falsification condition. |
| #2903 | partial | y (Marcus, Nadia, Theo) | 0.4 pre-release /voc-audit sweep — Verified against code (8 file:line citations); no user-observable falsification condition. |
| #2902 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (4 file:line citations); no user-observable falsification condition. |
| #2901 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2900 | partial | n (—) | 0.4 pre-release /voc-audit sweep — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2899 | partial | y (Nadia, Sarah) | 0.4 pre-release /voc-audit sweep — Verified against code (3 file:line citations); no user-observable falsification condition. |
| #2898 | partial | y (Nadia) | 0.4 pre-release /voc-audit sweep — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2897 | partial | y (Alex, Jordan) | 0.4 pre-release /voc-audit sweep — Verified against code (10 file:line citations); no user-observable falsification condition. |
| #2864 | partial | y (Marcus) | /pre-release full audit — Verified against code (3 file:line citations); no user-observable falsification condition. |
| #2863 | partial | y (Priya) | /pre-release full audit — Verified against code (4 file:line citations); no user-observable falsification condition. |
| #2711 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2709 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2708 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2707 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2706 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2705 | partial | y (Janet) | 0.4 VoC panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2704 | partial | y (role-lens only) | 0.4 VoC panel — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2661 | scoreable | y (Nadia, Theo) | Settings-surface /voc-audit panel — `## Falsification` section with a stated real-world check (Nadia, Theo). |
| #2660 | scoreable | y (Marcus, Nadia, Omar, Sarah, Theo) | Settings-surface /voc-audit panel — `## Falsification` section with a stated real-world check (Marcus, Nadia, Omar, Sarah, Theo). |
| #2658 | partial | y (Alex, Marcus, Omar, Sarah, Theo) | Settings-surface /voc-audit panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2657 | scoreable | y (Marcus, Nadia, Omar, Sarah, Theo) | Settings-surface /voc-audit panel — `## Falsification` section with a stated real-world check (Marcus, Nadia, Omar, Sarah, Theo). |
| #2645 | partial | y (role-lens only) | hybrid-bridge VoC panel — Verified against code (4 file:line citations); no user-observable falsification condition. |
| #2644 | partial | y (role-lens only) | hybrid-bridge VoC panel — Verified against code (2 file:line citations); no user-observable falsification condition. |
| #2642 | partial | y (role-lens only) | VoC — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2497 | unscoreable | y (role-lens only) | agile-methodology VoC panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2496 | unscoreable | y (role-lens only) | agile-methodology VoC panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2446 | unscoreable | y (Priya, Sarah) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2445 | partial | y (Alex, David, Marcus) | UX-flows / 0.4 beta wish-list panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2444 | partial | y (David, Marcus, Sarah) | UX-flows / 0.4 beta wish-list panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2443 | partial | y (David, Marcus, Sarah) | UX-flows / 0.4 beta wish-list panel — Verified against code (5 file:line citations); no user-observable falsification condition. |
| #2417 | unscoreable | y (Sarah) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2416 | unscoreable | y (Omar) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2414 | partial | y (Nadia) | UX-flows / 0.4 beta wish-list panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #2413 | unscoreable | y (Priya) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2412 | partial | y (Omar) | UX-flows / 0.4 beta wish-list panel — Verification prose against the tree (no line cites); no user-observable falsification condition. |
| #2411 | unscoreable | y (Alex, Jordan, Morgan) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2410 | unscoreable | y (Alex, Janet, Marcus, Morgan, Sarah) | UX-flows / 0.4 beta wish-list panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #2408 | partial | y (Janet, Marcus) | UX-flows / 0.4 beta wish-list panel — Verified against code (1 file:line citation); no user-observable falsification condition. |
| #1951 | unscoreable | y (Jordan, Priya, Sarah) | VoC audit (timesheet / board cards) — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1950 | unscoreable | y (Alex, Marcus, Priya, Sarah) | VoC audit (timesheet / board cards) — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1949 | unscoreable | y (Priya, Sarah) | VoC audit (timesheet / board cards) — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1634 | unscoreable | y (Priya, Sarah) | Build Mode VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1597 | unscoreable | y (Morgan) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1596 | unscoreable | y (Janet, Marcus) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1595 | unscoreable | y (Alex) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1593 | unscoreable | y (Jordan) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1592 | unscoreable | y (Sarah) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1561 | unscoreable | y (Priya) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1559 | unscoreable | y (David) | v2 nav-chrome VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1468 | unscoreable | y (Marcus, Morgan) | methodology view-tab VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1467 | unscoreable | y (Alex, Jordan, Morgan) | methodology view-tab VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1465 | unscoreable | y (Alex, Jordan, Marcus, Sarah) | methodology view-tab VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1302 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1301 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1300 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1299 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1298 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1297 | unscoreable | y (Alex, Jordan, Marcus, Morgan, Priya, Sarah) | 0.3 agile-overlay VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1277 | unscoreable | y (Alex, Jordan, Sarah) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1276 | unscoreable | y (David, Marcus, Sarah) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1274 | unscoreable | y (Marcus, Sarah) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1273 | unscoreable | y (Marcus, Sarah) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1272 | unscoreable | y (Marcus) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1271 | unscoreable | y (Alex) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1270 | unscoreable | y (Alex, Jordan) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1269 | unscoreable | y (Alex, Morgan) | 0.3 agile-workflow VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1214 | unscoreable | y (Jordan) | unknown — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1200 | unscoreable | y (Janet, Marcus, Sarah) | unknown — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1199 | unscoreable | y (Alex, Morgan) | unknown — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1160 | unscoreable | y (Morgan) | MR !596 VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1145 | unscoreable | y (Alex, Morgan) | 0.3 release / contributor-retention VoC — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1137 | unscoreable | y (Morgan, Priya) | 0.3 release / contributor-retention VoC — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1105 | unscoreable | y (Alex) | 0.3 bridge/sprint VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1104 | unscoreable | y (Marcus) | 0.3 bridge/sprint VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1103 | unscoreable | y (Janet, Marcus) | 0.3 bridge/sprint VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1102 | partial | y (Marcus, Sarah) | 0.3 bridge/sprint VoC audit — Verification prose against the tree (no line cites); no user-observable falsification condition. |
| #1101 | unscoreable | y (Jordan, Morgan) | 0.3 bridge/sprint VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #1100 | unscoreable | y (Alex, Sarah) | 0.3 bridge/sprint VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #872 | unscoreable | y (Alex, David, Janet, Jordan, Marcus, Morgan, Priya, Sarah) | roadmap-restructure VoC panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #702 | unscoreable | y (Sarah) | #697 focused panel — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #672 | unscoreable | y (Marcus, Sarah) | SettingsShell VoC re-audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #671 | unscoreable | y (Marcus, Sarah) | SettingsShell VoC re-audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #670 | unscoreable | y (Marcus, Sarah) | SettingsShell VoC re-audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #612 | unscoreable | y (Alex, Morgan) | Project Board VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #611 | unscoreable | y (Priya) | Project Board VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #610 | unscoreable | y (Sarah) | Project Board VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #609 | unscoreable | y (Priya, Sarah) | Project Board VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #608 | unscoreable | y (Alex, Jordan, Priya) | Project Board VoC audit — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #565 | unscoreable | y (Jordan) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #563 | unscoreable | y (Marcus) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #562 | unscoreable | y (Jordan, Priya) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #558 | unscoreable | y (Priya) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #557 | unscoreable | y (Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #556 | unscoreable | y (Jordan) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #555 | unscoreable | y (Alex, Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #554 | unscoreable | y (Jordan, Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #552 | unscoreable | y (Alex, Morgan, Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #548 | unscoreable | y (Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #547 | unscoreable | y (Alex, Jordan, Morgan) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #545 | unscoreable | y (Alex, Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #544 | unscoreable | y (Priya, Sarah) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #542 | unscoreable | y (David, Priya) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #540 | unscoreable | y (David) | MR !291/!297/!298/!302 VoC audits — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #489 | unscoreable | y (Alex, Priya) | unknown — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |
| #268 | unscoreable | n (—) | unknown — Persona friction + proposed fix/implementation scope only; no verification section, no falsification line. |

## What fraction of the backlog-steering pool grades `unscoreable` today

**119 of 122 open `voc-audit` issues — 97.5 % — carry no falsification line and would be
recorded as `unscoreable` by the first calibration pass.**

Broken out by how far short they fall:

- **74 issues (60.7 %)** are `unscoreable` outright: a persona quote, a friction
  description, and a proposed fix, with nothing checked against either the code or the
  world. These are concentrated in the older cohorts — the entire 2026-05-19 MR-review
  wave (15 issues), the 2026-06-22 and 2026-06-25 agile waves (14), the 2026-07-02 nav
  wave (7).
- **45 issues (36.9 %)** are `partial`: the defect is verified real against `main`, so the
  finding is trustworthy — but the calibration pass still records them `unscoreable`,
  because nothing in them predicts a user report. This is the larger problem, since these
  are the *recent* issues and the ones a reader is most likely to mistake for calibrated.
- **3 issues (2.5 %)** are scoreable.

The `.claude/persona-calibration.md` rule that unfalsifiable findings "count against the
panel, not for it" means the first cycle would return a false-alarm-dominated result that
says nothing about persona quality. **The four-issue sample that prompted this audit
(#2917, #2914, #2912, #2705) generalizes exactly: those four are all `partial`, and their
cohorts score 0/25 and 0/7 respectively.**

## Notes on method and its limits

- Classification is from issue *body text only*, fetched once via the API. Comments were
  not read; a falsification line added in a comment would be missed. Given that no issue
  body carries the practice outside one cohort, that risk is small but not zero.
- `partial` was assigned when a body contains at least one `file:line` citation used to
  establish current behavior, or explicit verification prose ("verified against `main` at
  `<sha>`", "read in full", "zero references", "found by direct inspection"). Bodies whose
  only code references are *implementation pointers* in a Scope or Proposed-fix section
  (the whole 2026-05-19 cohort, e.g. #557) were classified `unscoreable` — describing where
  a fix would go is not verifying that the defect exists.
- **#611** was auto-flagged `partial` on one `file:line` and manually demoted: the citation
  is an instruction for where to add an affordance, not a verification of current behavior.
- The persona-frequency table counts name mentions anywhere in the body, so an issue that
  names a persona in a "Related asks from Sarah" section counts toward Sarah. The
  attribution column in the issue table is stricter — it reflects whether the body names a
  raising persona or role lens at all.

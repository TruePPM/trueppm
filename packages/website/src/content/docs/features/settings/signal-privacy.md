---
title: Signal privacy
description: Govern how far each team signal — velocity, throughput rollup, and the retro pulse — may travel, on a team-owned ladder with an authorized ceiling.
---

:::note[Planned for 0.3]
The **Project Settings → Signal privacy** tab is planned for 0.3 (the agile team release). It is not yet in a tagged build — see the [roadmap](/overview/roadmap/).
:::

The **Project Settings → Signal privacy** tab is where a team decides how far its own metrics may travel. Agile signals — how fast the team goes, how much it finishes, how it feels — are honest only when the team trusts they will not be turned into a management gauge behind its back. This tab puts that trust under the team's control.

Open it at **Project → Settings → Signal privacy** (`/projects/:id/settings/signal-privacy`).

## What signals are governed

Three team signals can be gated:

- **Velocity** — the per-sprint velocity series and its forecast range.
- **Throughput rollup** — the team's per-period throughput (completed work over time).
- **Retro pulse** — the team-sentiment trend captured at retrospectives.

These are the team-private *details*. Aggregate, outward-facing readings — milestone health, schedule confidence — are **not** on this tab and stay visible to everyone (see [Suppressed, not blocked](#suppressed-not-blocked) below).

## The ladder and the ceiling

Each signal travels along one **ordered ladder** of audiences:

1. **Team only**
2. **Team + Scrum Master**
3. **Team + Scrum Master + PM**
4. **Shared to program rollup**

Two values govern each signal:

- the **audience** — how far the signal currently travels, and
- the **ceiling** — the highest audience the team has authorized.

The audience can move freely *up to* the ceiling; it can never exceed it. The split exists so the day-to-day visibility choice (where the Scrum Master sets the audience) is separate from the deliberate trust decision (where the team raises how far the signal is *allowed* to go).

A signal set to **Shared to program rollup** opts that signal into a cross-team program rollup. The rollup that consumes shared signals is an enterprise feature; on its own this setting simply marks the signal as eligible to be shared upward.

## Who can change what

| Action | Who |
|--------|-----|
| View the tab and the "Who sees what" matrix | Any project member (read-only) |
| Move a signal's **audience** within the ceiling | **Scrum Master** or project **Admin** |
| **Lower** a ceiling | Scrum Master or project Admin |
| **Propose raising** a ceiling | Scrum Master or project Admin — the team then ratifies (see below) |
| **Vote** on a raise proposal | Any team member |

Everyone else sees the tab read-only. They can see the current audience and ceiling for each signal; they just cannot change them. The API enforces the same gate server-side regardless of what the UI shows, and a non-member can never read a team signal.

### Moving the audience

Within the authorized ceiling, the Scrum Master moves a signal's audience up or down freely — no confirmation, no audit ceremony. This is the routine "open the velocity chart to the PM this sprint, pull it back next sprint" choice, and it stays lightweight on purpose.

### Raising the ceiling is a team act

**Lowering a ceiling is always allowed** — a team can always decide a signal should travel less far, with no friction.

**Raising a ceiling is a team decision, not one person's.** Letting a signal travel *further* than the team has previously authorized is a trust decision the team owns. A facilitator or Admin can *propose* a raise, but it does not take effect until the team **ratifies** it — a strict majority of the team's members must approve. A lone facilitator, or a PM, can never widen a team signal's exposure alone.

While a proposal is open, any team member can approve or reject it, and the proposal together with every vote is a **team-readable audit trail**: who proposed the raise, who voted, and how it resolved. A proposal that is not ratified within 72 hours simply expires with the ceiling unchanged — silence is never read as consent to share more widely. Lowering the ceiling while a raise is pending supersedes the proposal, so a tightened baseline always wins.

There is deliberately **no management override**: nobody outside the team — not a PM, not the PMO — can raise a ceiling or bypass the vote. That is the whole point of the model.

## One-click ratchet

The Scrum Master can pull **every** signal back to **Team only** in one action — the **"Make everything team-only"** button. It is the fast path for "we want to talk freely this retro" or "stop sharing now, sort it out later." Because lowering is always allowed, this needs no special authorization, and the team can re-open signals afterward up to their existing ceilings.

## Suppressed, not blocked

Gating a signal **suppresses** the team-private detail; it does not blank out the project. When a signal is set to **Team only**:

- **Milestone health and schedule confidence stay visible to everyone** — the aggregate readings the rest of the project depends on are never hidden.
- Only the team-private detail is gated — the **velocity series** and the **pulse trend** — and only for people above the current audience.

A PM who is outside a signal's audience still sees that the schedule is on track; they just do not see the team's raw velocity numbers behind it. The signal is suppressed for them, not the whole view.

## The "Who sees what" matrix

A read-only **matrix view** on the tab lays out, at a glance, every signal against every audience tier — which signals each role can currently see, and where each signal's ceiling sits. It is visible to any project member so the whole team can confirm exactly how far each signal travels without having to interpret per-signal settings one by one.

## Where this appears

The Signal privacy tab is shown on **agile** and **hybrid** projects. It is **hidden on Waterfall** projects, where these team signals do not apply — consistent with how the [methodology preset](/features/methodology-preset/) hides tabs that do not fit the project's planning model.

## Related ADRs

- [ADR-0104](/architecture/decisions/) — Signal privacy: the team-owned visibility ladder with an authorized ceiling; Amendment A adds team ratification for raising a ceiling

## Related

- [Project team & agile roles](/features/settings/project-team/) — who holds the Scrum Master facet that can govern signals
- [Velocity panel](/features/velocity/) — the velocity signal this tab governs
- [Retrospective](/features/retrospective/) — where the retro pulse is captured
- [Project methodology preset](/features/methodology-preset/) — which tabs appear per planning model

---
title: Estimation poker
description: Size unestimated stories together during sprint planning — Fibonacci voting, simultaneous reveal, outlier surfacing, and a one-click commit to story points.
---

Size the backlog where you plan it. Estimation poker is a right-rail card on the **planning**
sprint that lets a team resolve unestimated stories in-place — no tabbing out to a separate
poker app and copying numbers back by hand.

## How it works

When a planned sprint has at least one candidate without story points, the **Estimation
poker** card appears in the planning workspace.

1. **Open a round.** A facilitator — a Scrum Master, Product Owner, or project admin —
   starts poker on the next unestimated candidate.
2. **Vote.** Each team member picks a Fibonacci card (1 / 2 / 3 / 5 / 8 / 13 / 21, or "?"
   for unsure). Votes are **hidden** while the round is open — you see only how many people
   have voted, never who voted what, so nobody anchors on the first number called out.
3. **Reveal.** The facilitator reveals all votes at once. Every card is shown side by side.
4. **Discuss the outlier.** When the spread is wide — the highest and lowest votes diverge by
   at least two cards — the card surfaces an **outlier** prompt, the cue to ask "why are we 3
   versus 13?" before settling.
5. **Commit.** The facilitator commits the agreed value (defaulting to the team's
   most-common vote). Committing writes the number straight to the story's **story points**
   and closes the round, and the card advances to the next unestimated candidate.

If the team can't agree, the facilitator can **re-vote** — reopening the round keeps the
existing votes so people adjust rather than start over.

## Live and team-owned

Poker is a live, multi-writer ceremony: everyone votes on their own screen and the room
stays in sync in real time. The estimate belongs to the team — it feeds the team's own
velocity, and individual votes are never aggregated into a per-person history.

## Notes

- Poker runs on a **planning** sprint, before activation, so committing an estimate sets the
  story's initial size rather than changing scope mid-sprint.
- Only the Fibonacci scale is offered — the scale most teams already use.
- The committed value lands on the same `story_points` field the
  [sprint backlog](/features/sprint-backlog/) and [velocity](/features/velocity/) read, so no
  re-entry is needed.
